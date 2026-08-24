import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { splitEntityName, type KarbonClient, type KarbonClientSummary, type KarbonProvider } from '@element/integrations';
import { PreconditionError, assertCan, type Logger, type Principal } from '@element/shared';

/**
 * Bringing a firm's clients in from Karbon.
 *
 * Until this existed there was no route from "Karbon holds the client list" to
 * "this application knows a client exists". `KARBON_SYNC` syncs one work item
 * by key and creates no client at all, so the only way to populate a firm with
 * hundreds of T1s was to type them, one at a time, into a form. That is the
 * kind of task nobody finishes, and an application nobody finishes populating
 * is one nobody uses.
 *
 * Two rules make it safe to run more than once:
 *
 *   - **It never overwrites, but it does fill blanks.** A client already here
 *     may have been corrected by a person — a legal name Karbon has wrong, a
 *     business number typed from the CRA notice rather than the CRM. Karbon is
 *     the system of record for documents, not for the details that go *into* a
 *     legal document, so a field holding a value is reported as differing and
 *     left alone.
 *
 *     A field holding *nothing* is a different case, and conflating the two
 *     made re-running the import pointless: the firm's whole book came across
 *     while the client read was returning no contacts at all, and every run
 *     afterwards saw those clients as "already here" and moved on. The contacts
 *     would never have arrived. Blanks are filled; contacts are matched on
 *     Karbon's own key so nothing is duplicated or displaced.
 *   - **It refuses a mock.** With the mock adapter, importing would write
 *     fictional sample clients into the real client list, where they would be
 *     indistinguishable from the firm's own and would sit in the engagement
 *     list for ever.
 */

export interface ClientImportDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  logger: Logger;
}

/**
 * Where the list of candidate clients comes from.
 *
 * `CLIENT_LIST` reads `/Organizations` and `/Contacts` — Karbon's own client
 * list, and the answer to "who are the firm's clients?".
 *
 * `WORK_ITEMS` takes the distinct clients named on recent work items. It was
 * the only route for a long time, and it answers a narrower question: who has
 * work open. A new client, a dormant one, and any client whose work predates
 * the window are all invisible to it, which is how a firm reconciles the count
 * against their own list and finds it short.
 *
 * Both are kept because they are genuinely different questions, and the narrow
 * one is useful when a firm's Karbon holds many non-clients.
 */
export type ClientImportSource = 'CLIENT_LIST' | 'WORK_ITEMS';

/** What a discovery pass found, and whether it found all of it. */
interface Discovered {
  entityKeys: string[];
  /** True when the limit cut the search short, so more clients exist. */
  truncated: boolean;
  /** Karbon contact type to count, for the client-list source only. */
  byContactType: Map<string, number>;
  /** Passed over for their contact type, by type. */
  skippedByContactType: Map<string, number>;
  /**
   * The client-list entry per key, when discovery had one.
   *
   * Carries the name, which is what lets a preview report a client it would add
   * without spending a request re-reading what the list already said. Empty for
   * work-item discovery, which knows keys and nothing else.
   */
  summaryByKey: Map<string, KarbonClientSummary>;
}

/** Whether a Karbon contact type is one this import passes over. */
function isExcludedContactType(contactType: string | null | undefined): boolean {
  const value = contactType?.trim().toLowerCase();
  if (!value) return false;
  return EXCLUDED_CONTACT_TYPES.some((excluded) => excluded.toLowerCase() === value);
}

export interface ClientImportInput {
  karbon: KarbonProvider;
  actor: Principal;
  /**
   * How many records to look through — work items, or client-list entries.
   * Client discovery, not a cap on how many clients may be created.
   */
  limit?: number;
  /** Defaults to Karbon's own client list. */
  source?: ClientImportSource;
  /**
   * True to import every contact type, including the excluded ones.
   *
   * The exclusion is a convenience for the common case, not a definition of what
   * a client is, so there has to be a way past it — a client wrongly marked
   * Inactive in Karbon must not be unreachable from here.
   */
  includeAllContactTypes?: boolean;
  /** True to report only, changing nothing. */
  dryRun: boolean;
  /**
   * How many already-stored clients a preview re-reads to compare.
   *
   * Settable so a test can drive the bound without seeding hundreds of clients,
   * and so the value is visible rather than buried. Ignored for a real import,
   * which compares everything.
   */
  maxComparedPerPreview?: number;
  correlationId?: string;
}

export interface ClientDifference {
  field: string;
  here: string | null;
  inKarbon: string | null;
}

export interface ClientImportResult {
  /** Distinct client keys found across the work items examined. */
  found: number;
  created: { entityKey: string; legalName: string }[];
  /** Already present. Reported, never modified. */
  unchanged: number;
  differing: { entityKey: string; legalName: string; differences: ClientDifference[] }[];
  /** Clients that could not be read back, with the reason. */
  failed: { entityKey: string; reason: string }[];
  /**
   * Clients already here that had blanks filled in — never values replaced.
   * Reported separately from `differing` because the two are opposites: this is
   * what changed, that is what deliberately did not.
   */
  backfilled: { entityKey: string; legalName: string; contactsAdded: number; fieldsFilled: string[] }[];
  /**
   * Candidates passed over because of their Karbon contact type, by type.
   *
   * Reported rather than merely omitted. A client silently missing from an
   * import is the failure this whole area keeps producing, and "skipped because
   * Karbon calls it Inactive" is only a defensible reason if the person can see
   * it was applied and to how many.
   */
  skippedByContactType: { contactType: string; count: number }[];
  dryRun: boolean;
  notes: string[];
}

/** Work items to examine. Each distinct client among them is a candidate. */
const DEFAULT_LIMIT = 200;

/** Rows per transaction when refreshing the stored copy of Karbon's names. */
const MIRROR_CHUNK = 200;

/**
 * The most work items one import may examine.
 *
 * A firm whose whole book does not appear in the first `DEFAULT_LIMIT` needs to
 * look further — but not without a ceiling.
 *
 * This used to say the cost mattered because the import "runs inside a request".
 * It no longer does: the real import is a worker job, precisely because several
 * hundred clients is minutes of rate-limited reads. A preview still runs in the
 * request and is bounded separately — see `MAX_COMPARED_PER_PREVIEW`.
 *
 * Matched to what the Karbon client can actually page through
 * (`MAX_SEARCH_PAGES` × `PAGE_SIZE`), so asking for more than this would
 * promise a depth the search cannot reach.
 */
const MAX_LIMIT = 5000;

/**
 * Karbon contact types whose entries are not imported as clients.
 *
 * **This list is the firm's answer, not an inference.** Contact types are
 * tenant-defined — `/v3/TenantSettings` lists them per firm — so nothing here
 * could work out which words mean "not a current client". A verification run
 * against the live tenant on 2026-08-17 reported the four types actually in use
 * — `Client`, `Inactive`, `Dissolved` and `Other` — and the firm chose which to
 * exclude.
 *
 * `Dissolved` is the stronger of the two. An inactive client is a judgement
 * about the relationship; a dissolved corporation has no legal existence and
 * cannot be a party to an engagement letter at all. The same tenant also holds
 * one whose name *ends* in `- DISSOLVED`, which this does not catch and
 * deliberately does not try to — see `splitEntityName` for why a status
 * annotation inside a name is left alone.
 *
 * `Other` is not excluded. It says nothing about whether the entry is a client,
 * so dropping it would be the guess this comment exists to rule out.
 *
 * That provenance matters for the next reader: a tenant using different words
 * needs this list changed, and a value here that a tenant does not use excludes
 * nothing rather than failing. Matched case-insensitively after trimming, since
 * a type is a label somebody typed.
 *
 * Overridable per run — see `includeAllContactTypes` — because the exclusion is
 * a convenience, not a rule about what a client is.
 */
const EXCLUDED_CONTACT_TYPES = ['Inactive', 'Dissolved'];

/**
 * How many already-stored clients a **preview** re-reads to compare.
 *
 * A preview needs the detail only for clients it already holds, which sounds
 * bounded and is not: it grows with every successful import, so the screen gets
 * slower precisely as the import starts working. At Karbon's documented 120
 * requests a minute this is roughly a minute of reads, which a request survives.
 *
 * Bounded rather than removed, because the comparison is the point of a preview
 * — it is what reports a legal name that differs. The remainder is counted and
 * said out loud rather than silently omitted, and the real import compares
 * everything, since nothing is waiting on it.
 */
const MAX_COMPARED_PER_PREVIEW = 120;

export class ClientImportService {
  constructor(private readonly deps: ClientImportDeps) {}

  async run(input: ClientImportInput): Promise<ClientImportResult> {
    assertCan(input.actor, 'engagement:create');

    if (input.karbon.isMock) {
      throw new PreconditionError(
        'Karbon is not connected, so there is nothing to import. The mock adapter would add fictional sample clients to the real client list, where nothing would distinguish them from the firm’s own.',
      );
    }

    const requested = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new PreconditionError('The number of records to examine must be a positive whole number.');
    }
    const limit = Math.min(requested, MAX_LIMIT);
    const notes: string[] = [];

    if (requested > MAX_LIMIT) {
      notes.push(
        `Asked for ${requested} records; ${MAX_LIMIT} is the most one import can examine, so that is what was read.`,
      );
    }

    const source = input.source ?? 'CLIENT_LIST';

    const { entityKeys, truncated, byContactType, skippedByContactType, summaryByKey } =
      source === 'CLIENT_LIST'
        ? await this.fromClientList(input.karbon, limit, input.includeAllContactTypes === true)
        : await this.fromWorkItems(input.karbon, limit);

    const noun = source === 'CLIENT_LIST' ? 'client-list entries' : 'work items';

    if (source === 'WORK_ITEMS') {
      // The narrower question, stated as such. A count from this source is
      // "clients with recent work", and reading it as "clients" is the mistake
      // that made a firm's list look short.
      notes.push(
        'Read from work items, so this finds only clients somebody has opened work for — a new or dormant client will not appear. Karbon’s own client list is the other option.',
      );
    }

    if (byContactType.size > 0) {
      // The tenant's own vocabulary, counted. Nothing filters on it, so the only
      // way somebody discovers their Karbon holds 20 clients marked "Inactive"
      // is if the import says so — and an inactive client is one an engagement
      // letter probably should not be addressed to.
      const breakdown = [...byContactType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');
      notes.push(`Karbon contact types among them: ${breakdown}.`);
    }

    if (skippedByContactType.size > 0) {
      const skipped = [...skippedByContactType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');
      // Named as a choice with a way out, not as a fact about the data. The
      // exclusion is the firm's decision about its own Karbon labels, and a
      // client wrongly marked Inactive there must not be unreachable from here.
      notes.push(
        `Skipped ${skipped} — these Karbon contact types are not imported. Tick "include every contact type" to import them anyway.`,
      );
    }

    if (truncated) {
      // The count is a floor, not a total. Saying "22 clients" when it is
      // "22 among the first 200 records" is the kind of number somebody
      // reconciles against their client list and finds short.
      //
      // Saying so is not enough on its own: a warning a reader cannot act on
      // is just an apology. It names the control that answers it.
      notes.push(
        limit >= MAX_LIMIT
          ? `Examined ${limit} ${noun}, the most one import can read, and the supply was not exhausted — clients may exist beyond them. Import what is here, then narrow the remainder by other means.`
          : `Examined the first ${limit} ${noun} and the supply was not exhausted — there may be more clients beyond them. Run it again with a higher "records to examine" to look further.`,
      );
    }

    let tradeNamesSeparated = 0;

    const result: ClientImportResult = {
      found: entityKeys.length,
      created: [],
      unchanged: 0,
      differing: [],
      failed: [],
      backfilled: [],
      skippedByContactType: [...skippedByContactType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([contactType, count]) => ({ contactType, count })),
      dryRun: input.dryRun,
      notes,
    };

    // Which of these we already hold, in one query rather than one per client.
    //
    // This is what makes a preview affordable. Karbon documents 120 requests a
    // minute and the loop below spends one per candidate, so a preview of 1,000
    // was 1,000 throttled reads — eight minutes inside a page request, which
    // does not finish. It timed out on the live tenant, and the depth control
    // offering 5,000 made that worse rather than better.
    //
    // A dry run does not need the detail for a client it is only going to report
    // as "would be added": the client list already carried its key and its name.
    // The detail is needed to compare against a client already here, and to
    // create one for real — so only those cost a request.
    const alreadyHere = new Set(
      (
        await this.deps.prisma.client.findMany({
          where: { karbonEntityKey: { in: entityKeys } },
          select: { karbonEntityKey: true },
        })
      ).map((row) => row.karbonEntityKey as string),
    );

    // What Karbon calls each client we already hold, refreshed before anything
    // else happens.
    //
    // This is the one client field the import overwrites, and the exception is
    // deliberate. "Never overwrite" protects a value somebody here chose — a
    // legal name corrected against the articles of incorporation, a business
    // number typed from the CRA notice. There is nothing to protect in a record
    // of what the vendor said; a stale copy of it is simply wrong.
    //
    // It costs no Karbon requests. The names came from the client list, which
    // was already read to discover these keys at all, so every stored client is
    // brought up to date for the price of some UPDATEs — including the ones the
    // loop below will skip because nothing about them differs.
    const mirrored = input.dryRun
      ? 0
      : await this.refreshKarbonNames([...alreadyHere], summaryByKey);

    if (input.dryRun && summaryByKey.size > 0) {
      // Otherwise the first preview after this shipped would look like the new
      // columns had silently failed to populate. A preview changes nothing, and
      // that guarantee is worth more than the convenience of an exception.
      notes.push('Previewing does not refresh what Karbon calls each client, because a preview writes nothing. Import to update it.');
    } else if (mirrored > 0) {
      notes.push(`Refreshed the Karbon name held for ${mirrored} client(s) already here, so they can be looked up by it.`);
    }

    let compared = 0;
    let notCompared = 0;

    for (const entityKey of entityKeys) {
      if (input.dryRun && !alreadyHere.has(entityKey)) {
        const summary = summaryByKey.get(entityKey);
        // No summary means work-item discovery, which carries no name — that
        // path still has to read the client to have anything to report.
        if (summary) {
          result.created.push({ entityKey, legalName: splitEntityName(summary.fullName).legalName });
          if (splitEntityName(summary.fullName).tradeName) tradeNamesSeparated += 1;
          continue;
        }
      }

      // A preview still reads every client it already holds, to compare and to
      // find blanks — so its cost grows with every successful import. Cheap at
      // sixty stored and a timeout once a whole book is in: the same defect as
      // the unqueued import, one step behind it, arriving exactly when the
      // import finally succeeds.
      //
      // Only the preview is bounded. The real import runs in the worker with no
      // request waiting on it, and capping the comparison there would leave
      // blanks unfilled for no reason.
      const comparisonBudget = input.maxComparedPerPreview ?? MAX_COMPARED_PER_PREVIEW;
      if (input.dryRun && alreadyHere.has(entityKey) && compared >= comparisonBudget) {
        notCompared += 1;
        continue;
      }
      if (input.dryRun && alreadyHere.has(entityKey)) compared += 1;

      let karbonClient;
      try {
        karbonClient = await input.karbon.getClient(entityKey);
      } catch (error) {
        result.failed.push({ entityKey, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }

      if (!karbonClient) {
        // A key the work item carries but the client endpoint will not resolve.
        // Reported rather than skipped: it is the same shape of problem as a
        // work item key that does not read back, and it means something about
        // the tenant is not what this application assumes.
        // "Could not be read" names a symptom and no cause. Ask what the key
        // actually is, so the operator gets an answer rather than a mystery to
        // take to the vendor.
        // Not guarded on the method existing. `describeUnresolvedClient` is
        // required on `KarbonProvider` exactly so the compiler finds an adapter
        // that lacks it — a truthiness check here restores the hole that being
        // required closed, by making a missing method look like a provider that
        // legitimately declines to diagnose.
        //
        // The fallback it guarded also said "the work item names this client
        // key", which stopped being true the moment discovery could read the
        // client list instead. A sentence naming the wrong source sends the
        // reader to the wrong screen.
        const reason = await input.karbon
          .describeUnresolvedClient(entityKey)
          .catch(() => 'no organisation or contact matched this key, and it could not be identified further');

        result.failed.push({ entityKey, reason });
        continue;
      }

      // The last resort for a name, and the one that is known to work.
      //
      // `getClient` reads the detail endpoint, and `GET /Contacts/{key}` on the
      // live tenant returns no `FullName` at all — so every individual the firm
      // acts for was created with an empty legal name. The **list** endpoint
      // does return it, and this import already read that list to discover these
      // keys, so the name is sitting in `summaryByKey` at no further cost.
      //
      // This is a fallback, not a preference: the detail read stays the source
      // when it produced anything, because it is the record the rest of the
      // client is mapped from. A client with no name in either place is still
      // possible, and is handled where it is created.
      if (karbonClient.legalName.trim().length === 0) {
        const summaryName = summaryByKey.get(entityKey)?.fullName?.trim();
        if (summaryName) {
          const split = splitEntityName(summaryName);
          karbonClient = {
            ...karbonClient,
            legalName: split.legalName,
            tradeName: karbonClient.tradeName ?? split.tradeName,
          };
        }
      }

      const existing = await this.deps.prisma.client.findUnique({
        where: { karbonEntityKey: entityKey },
        include: { contacts: true },
      });

      if (existing) {
        // Filling a blank is not overwriting.
        //
        // "Never overwrite" exists to protect a value a person corrected — a
        // legal name Karbon has wrong, a business number typed from the CRA
        // notice. A field that is empty has no such value to protect, and
        // treating the two the same made re-running the import useless: the
        // firm's whole book was imported while a client read returned no
        // contacts at all, and every later run reported those clients as
        // "already here" and moved on. The contacts would never have arrived,
        // and a client with no contact has nobody to address a letter to.
        //
        // So: absent values are filled, present ones are reported and left
        // alone, exactly as before.
        const backfill = await this.backfillFromKarbon(existing, karbonClient, input.dryRun);
        if (backfill) result.backfilled.push(backfill);

        // A field that was just filled was not "left alone", and reporting it in
        // both lists at once says two opposite things about the same value.
        // `compare` reads the row as it was before the backfill, so the filled
        // ones are removed here rather than by re-reading the client.
        const filled = new Set(backfill?.fieldsFilled ?? []);
        const differences = compare(existing, karbonClient).filter(
          (difference) => !filled.has(difference.field),
        );
        if (differences.length > 0) {
          result.differing.push({ entityKey, legalName: existing.legalName, differences });
        } else if (!backfill) {
          result.unchanged += 1;
        }
        continue;
      }

      // Neither the detail read nor the client list gave this one a name. It is
      // reported rather than created: a client row with an empty legal name is
      // invisible in every list that sorts by it, cannot be picked from the menu
      // that starts an engagement, and could not produce a correct letter if it
      // were. A failure names the key, which is enough to find it in Karbon.
      if (karbonClient.legalName.trim().length === 0) {
        result.failed.push({
          entityKey,
          reason: 'Karbon returned no name for this client, on either the client list or the client itself, so it was not added.',
        });
        continue;
      }

      result.created.push({ entityKey, legalName: karbonClient.legalName });
      // Counted so the summary can say a trading name was separated off. A
      // silent rewrite of a legal name is not better than a wrong one — the
      // reader has to be able to see it happened and check a few.
      if (karbonClient.tradeName) tradeNamesSeparated += 1;

      if (input.dryRun) continue;

      await this.deps.prisma.client.create({
        data: {
          karbonEntityKey: karbonClient.entityKey,
          karbonEntityType: karbonClient.entityType,
          legalName: karbonClient.legalName,
          // Falling back to the trading name here, not only in the adapter that
          // derives it: the guarantee is that separating a name off the legal
          // name never loses it, and that has to hold at the point of storage
          // whichever provider supplied the record.
          displayName: karbonClient.displayName ?? karbonClient.tradeName ?? null,
          businessNumber: karbonClient.businessNumber ?? null,
          addressLine1: karbonClient.addressLine1 ?? null,
          addressLine2: karbonClient.addressLine2 ?? null,
          city: karbonClient.city ?? null,
          province: karbonClient.province ?? null,
          postalCode: karbonClient.postalCode ?? null,
          country: karbonClient.country ?? 'Canada',
          // Kept unsplit alongside the halves, so this client can later be found
          // by the name the firm actually uses for it. `getClient` returns the
          // name already separated, so the original only exists on the list
          // summary — which is why the fallback is a null rather than a rejoin:
          // reconstructing "legal (trade)" would be inventing a vendor string.
          karbonFullName: summaryByKey.get(entityKey)?.fullName ?? null,
          karbonContactType: summaryByKey.get(entityKey)?.contactType ?? karbonClient.contactType ?? null,
          karbonNameSyncedAt: new Date(),
          contacts: {
            create: karbonClient.contacts.map((contact) => ({
              karbonContactKey: contact.contactKey,
              // Karbon's display name, which is the best available. It is not a
              // confirmed legal name, and every engagement still makes a person
              // confirm each participant before anything is sent.
              fullLegalName: contact.fullName,
              firstName: contact.firstName ?? null,
              email: contact.email ?? null,
              telephone: contact.telephone ?? null,
              title: contact.title ?? null,
              isPrimary: contact.isPrimary ?? false,
            })),
          },
        },
      });
    }

    if (result.backfilled.length > 0) {
      const contacts = result.backfilled.reduce((total, row) => total + row.contactsAdded, 0);
      notes.push(
        `${result.backfilled.length} client(s) already here had blanks filled in${
          contacts > 0 ? `, including ${contacts} contact(s)` : ''
        }. Only empty fields were touched; anything already holding a value was left exactly as it was.`,
      );
    }

    if (result.differing.length > 0) {
      notes.push(
        `${result.differing.length} client(s) already here differ from Karbon. Nothing was changed — the details that go into a legal document are this application’s to hold, and a person may have corrected them deliberately.`,
      );
    }

    if (notCompared > 0) {
      // Said, not swallowed. A preview that quietly examined a third of what it
      // found would report "3 differ" from a sample and read as the whole answer
      // — which is the mistake the client-list count already made once.
      notes.push(
        `Compared ${compared} of the ${compared + notCompared} clients already here; the rest were not re-read this time, so differences and blanks among them are not counted above. Importing compares every one.`,
      );
    }

    if (tradeNamesSeparated > 0) {
      notes.push(
        `${tradeNamesSeparated} name(s) carried a trading name in brackets — Karbon’s “2140071 Alberta Ltd. (JC Spa and Wellness)” shape. The legal entity was kept as the legal name and the trading name became the display name, because the legal name is what prints on the letter. Worth spot-checking a few.`,
      );
    }

    await this.deps.audit.record({
      eventType: 'CONFIGURATION_CHANGED',
      objectType: 'Client',
      userId: input.actor.id,
      correlationId: input.correlationId ?? null,
      reason: input.dryRun ? 'Previewed a client import from Karbon.' : 'Imported clients from Karbon.',
      afterValue: {
        dryRun: input.dryRun,
        found: result.found,
        created: result.created.length,
        unchanged: result.unchanged,
        differing: result.differing.length,
        backfilled: result.backfilled.length,
        failed: result.failed.length,
      },
    });

    return result;
  }

  /**
   * Fills the blanks on a client already here, and only the blanks.
   *
   * Contacts are matched on Karbon's own contact key, so a second run adds
   * nothing and a contact somebody entered by hand is never duplicated or
   * displaced. Scalar fields are written only where this application currently
   * holds nothing — a value already present is left for `compare` to report,
   * because a person may have put it there on purpose.
   */
  /**
   * Brings the stored copy of Karbon's name up to date, for clients already here.
   *
   * Only the vendor's own fields are touched, and only for keys the discovery
   * pass actually saw — a client absent from this run keeps whatever it had
   * rather than being blanked, because "not read this time" is not "Karbon no
   * longer has a name for it".
   *
   * Chunked. Several hundred updates in one transaction holds row locks across
   * the whole batch for no benefit; the pass is not atomic in any sense that
   * matters, since each row is independent and re-running fixes any partial one.
   */
  private async refreshKarbonNames(
    entityKeys: string[],
    summaryByKey: Map<string, KarbonClientSummary>,
  ): Promise<number> {
    const syncedAt = new Date();
    const updates = entityKeys.flatMap((entityKey) => {
      const summary = summaryByKey.get(entityKey);
      // Work-item discovery carries no name, so there is nothing to mirror.
      if (!summary) return [];
      return [
        this.deps.prisma.client.update({
          where: { karbonEntityKey: entityKey },
          data: {
            karbonFullName: summary.fullName,
            karbonContactType: summary.contactType ?? null,
            karbonNameSyncedAt: syncedAt,
          },
        }),
      ];
    });

    for (let index = 0; index < updates.length; index += MIRROR_CHUNK) {
      await this.deps.prisma.$transaction(updates.slice(index, index + MIRROR_CHUNK));
    }

    return updates.length;
  }

  /**
   * Karbon's own client list.
   *
   * Every organisation and every contact, because both are clients here: a
   * corporation is an Organization and an individual filing a T1 is a Contact.
   *
   * `ContactType` is deliberately not filtered on. It is tenant-defined, so a
   * firm that calls its clients something other than "Client" would have every
   * one of them silently dropped — the failure this whole change exists to
   * remove, reintroduced one layer down.
   */
  private async fromClientList(
    karbon: KarbonProvider,
    limit: number,
    includeAll: boolean,
  ): Promise<Discovered> {
    const { clients, more } = await karbon.listClients({ limit });

    const byContactType = new Map<string, number>();
    const skippedByContactType = new Map<string, number>();
    const summaryByKey = new Map<string, KarbonClientSummary>();
    const kept: string[] = [];

    for (const summary of clients) {
      const type = summary.contactType?.trim();
      if (type) byContactType.set(type, (byContactType.get(type) ?? 0) + 1);

      if (!includeAll && isExcludedContactType(summary.contactType)) {
        // Counted under the type as Karbon spells it, not as the constant does,
        // so a tenant that writes "inactive" sees its own word back.
        const label = type ?? 'unlabelled';
        skippedByContactType.set(label, (skippedByContactType.get(label) ?? 0) + 1);
        continue;
      }

      if (summary.entityKey) {
        kept.push(summary.entityKey);
        summaryByKey.set(summary.entityKey, summary);
      }
    }

    return {
      entityKeys: [...new Set(kept)],
      // Reported by the provider rather than guessed from the count. A list of
      // exactly the limit may or may not have more behind it, and two lists
      // drawn from two endpoints cannot be told apart by their total at all.
      truncated: more,
      byContactType,
      skippedByContactType,
      summaryByKey,
    };
  }

  /** The distinct clients named on recent work items. */
  private async fromWorkItems(karbon: KarbonProvider, limit: number): Promise<Discovered> {
    const workItems = await karbon.searchWorkItems({ limit });
    return {
      entityKeys: [
        ...new Set(workItems.map((item) => item.clientKey).filter((key): key is string => Boolean(key))),
      ],
      truncated: workItems.length >= limit,
      // Work items carry no contact type; the clients behind them do, and this
      // path never reads them. So the exclusion cannot be applied here, which is
      // itself worth knowing rather than looking like it was applied and found
      // nothing.
      byContactType: new Map(),
      skippedByContactType: new Map(),
      // Work items carry a client key and no name, so a preview from this source
      // still has to read each client to report anything about it.
      summaryByKey: new Map(),
    };
  }

  private async backfillFromKarbon(
    existing: { id: string; legalName: string; contacts: { karbonContactKey: string | null }[] },
    karbonClient: KarbonClient,
    dryRun: boolean,
  ): Promise<ClientImportResult['backfilled'][number] | null> {
    const here = existing as unknown as Record<string, unknown>;
    const there = karbonClient as unknown as Record<string, unknown>;
    const known = new Set(existing.contacts.map((contact) => contact.karbonContactKey).filter(Boolean));
    const newContacts = karbonClient.contacts.filter(
      (contact) => contact.contactKey.length > 0 && !known.has(contact.contactKey),
    );

    const fieldsFilled: string[] = [];
    const data: Record<string, string> = {};
    for (const [column, label] of BACKFILLABLE) {
      const mine = here[column];
      const theirs = there[column];
      const hasMine = typeof mine === 'string' && mine.trim().length > 0;
      const hasTheirs = typeof theirs === 'string' && theirs.trim().length > 0;
      if (hasMine || !hasTheirs) continue;
      data[column] = (theirs as string).trim();
      fieldsFilled.push(label);
    }

    if (newContacts.length === 0 && fieldsFilled.length === 0) return null;

    if (!dryRun) {
      await this.deps.prisma.client.update({
        where: { id: existing.id },
        data: {
          ...data,
          contacts: {
            create: newContacts.map((contact) => ({
              karbonContactKey: contact.contactKey,
              fullLegalName: contact.fullName,
              firstName: contact.firstName ?? null,
              email: contact.email ?? null,
              telephone: contact.telephone ?? null,
              title: contact.title ?? null,
              isPrimary: contact.isPrimary ?? false,
            })),
          },
        },
      });
    }

    return {
      entityKey: karbonClient.entityKey,
      legalName: existing.legalName,
      contactsAdded: newContacts.length,
      fieldsFilled,
    };
  }
}

/**
 * What differs between the client here and the one in Karbon.
 *
 * Only fields Karbon actually supplies. A blank in Karbon is not a difference —
 * it is Karbon not knowing, and treating it as one would report every client as
 * differing on every empty field.
 */
/** The client fields safe to fill when they are empty here. */
const BACKFILLABLE = [
  // Included so re-running repairs the several hundred clients imported while
  // the contact detail endpoint was returning no name: they are stored with an
  // empty legal name, which is the one value that renders as nothing at all and
  // the one field an engagement letter cannot be produced without.
  //
  // Filling it is not overwriting. "Never overwrite" protects a legal name
  // somebody corrected against the articles of incorporation; there is no
  // correction to protect in an empty string, and leaving these blank until each
  // is retyped by hand is not a policy, it is a backlog.
  ['legalName', 'Legal name'],
  // Included so re-running repairs the clients imported before names were
  // separated: their legal name now matches Karbon's legal half, but their
  // display name is blank while Karbon holds the trading name.
  ['displayName', 'Display name'],
  ['businessNumber', 'Business number'],
  ['addressLine1', 'Address line 1'],
  ['addressLine2', 'Address line 2'],
  ['city', 'City'],
  ['province', 'Province'],
  ['postalCode', 'Postal code'],
] as const;

/**
 * How many differing clients are spelled out before the list is cut short.
 *
 * An import of a whole firm could differ on hundreds, and a list that long is
 * read by nobody. The cut is reported rather than silent.
 */
const DIFFERENCES_SHOWN = 10;

/**
 * What actually differs between a client here and the same client in Karbon.
 *
 * The import deliberately never overwrites: somebody may have corrected a legal
 * name Karbon has wrong, or typed a business number from the CRA notice rather
 * than the CRM. **That decision is only defensible if the person is told what
 * was left alone.** Until this existed the differences were computed, returned,
 * and dropped by the caller, so the screen reported "5 differ" while promising
 * in the same panel that differences are reported so you can decide. A count
 * with no detail is not something anybody can decide about.
 *
 * It matters most for the legal name, which is one of the compared fields and
 * prints verbatim into a legal document.
 */
/**
 * One sentence-per-count summary of what an import did.
 *
 * Lives here rather than in the caller because there are now two: the screen
 * renders it inline for a preview, and the worker writes it onto the job so the
 * System Jobs page can say what a completed import actually did. Two copies of
 * this arithmetic would drift, and the counts are subtle enough to matter — a
 * client can legitimately appear in two of them.
 */
export function summariseClientImport(result: ClientImportResult): string {
  const parts = [
    `${result.found} client(s) found in Karbon.`,
    result.dryRun ? `${result.created.length} would be added.` : `${result.created.length} added.`,
    `${result.unchanged} already here and matching.`,
  ];

  if (result.backfilled.length > 0) {
    // Said separately from "differ and were left alone", because they are
    // opposites and a reader needs to tell them apart: this is what changed on a
    // client already here, that is what deliberately did not.
    const contacts = result.backfilled.reduce((total, row) => total + row.contactsAdded, 0);
    const filled = result.dryRun ? 'would have blanks filled' : 'had blanks filled';
    parts.push(`${result.backfilled.length} ${filled}${contacts > 0 ? `, adding ${contacts} contact(s)` : ''}.`);
  }

  if (result.differing.length > 0) parts.push(`${result.differing.length} differ and were left alone.`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} could not be read.`);

  // In the summary line, not only in the notes. A skipped client is a client
  // absent from the list afterwards, and the count that explains why belongs
  // where the other counts are.
  const skipped = result.skippedByContactType.reduce((total, row) => total + row.count, 0);
  if (skipped > 0) parts.push(`${skipped} skipped by contact type.`);

  // A client whose blanks were filled may also differ on a field that already
  // held a value, so it is counted in both. Without saying so the totals do not
  // add up to the number found, and a reader who tries to reconcile them
  // concludes something was lost.
  const backfilledKeys = new Set(result.backfilled.map((row) => row.entityKey));
  const alsoDiffering = result.differing.filter((row) => backfilledKeys.has(row.entityKey)).length;
  if (alsoDiffering > 0) {
    parts.push(
      `${alsoDiffering} appear(s) in two of those counts: blanks filled, and a difference left alone elsewhere.`,
    );
  }

  return parts.join(' ');
}

export function describeDifferences(differing: ClientImportResult['differing']): string[] {
  const lines = differing.slice(0, DIFFERENCES_SHOWN).map((row) => {
    const fields = row.differences
      .map((difference) => `${difference.field}: here “${difference.here ?? '—'}”, Karbon “${difference.inKarbon ?? '—'}”`)
      .join('; ');
    return `${row.legalName} differs and was left alone — ${fields}`;
  });

  if (differing.length > DIFFERENCES_SHOWN) {
    lines.push(`…and ${differing.length - DIFFERENCES_SHOWN} more client(s) differing, not listed here.`);
  }

  return lines;
}

function compare(
  here: { legalName: string; businessNumber: string | null; city: string | null; province: string | null; postalCode: string | null },
  there: { legalName: string; businessNumber?: string | null; city?: string | null; province?: string | null; postalCode?: string | null },
): ClientDifference[] {
  const differences: ClientDifference[] = [];

  const fields: [string, string | null, string | null | undefined][] = [
    ['Legal name', here.legalName, there.legalName],
    ['Business number', here.businessNumber, there.businessNumber],
    ['City', here.city, there.city],
    ['Province', here.province, there.province],
    ['Postal code', here.postalCode, there.postalCode],
  ];

  for (const [field, mine, theirs] of fields) {
    const other = theirs?.trim() ?? '';
    if (other.length === 0) continue;
    if ((mine ?? '').trim().toLowerCase() === other.toLowerCase()) continue;
    differences.push({ field, here: mine, inKarbon: other });
  }

  return differences;
}
