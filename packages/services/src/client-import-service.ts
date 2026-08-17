import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import type { KarbonClient, KarbonProvider } from '@element/integrations';
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

/**
 * The most work items one import may examine.
 *
 * Clients are derived from work items, so a firm whose whole book does not
 * appear in the first `DEFAULT_LIMIT` needs to look further — but not without
 * a ceiling. Each distinct client costs a `getClient` call against a
 * rate-limited API, and this runs inside a request.
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
 * against the live tenant on 2026-08-17 reported the two types actually in use,
 * `Client` and `Inactive`, and the firm chose to exclude the latter.
 *
 * That provenance matters for the next reader: a tenant using different words
 * needs this list changed, and a value here that a tenant does not use excludes
 * nothing rather than failing. Matched case-insensitively after trimming, since
 * a type is a label somebody typed.
 *
 * Overridable per run — see `includeAllContactTypes` — because the exclusion is
 * a convenience, not a rule about what a client is.
 */
const EXCLUDED_CONTACT_TYPES = ['Inactive'];

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

    const { entityKeys, truncated, byContactType, skippedByContactType } =
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

    for (const entityKey of entityKeys) {
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

        const differences = compare(existing, karbonClient);
        if (differences.length > 0) {
          result.differing.push({ entityKey, legalName: existing.legalName, differences });
        } else if (!backfill) {
          result.unchanged += 1;
        }
        continue;
      }

      result.created.push({ entityKey, legalName: karbonClient.legalName });

      if (input.dryRun) continue;

      await this.deps.prisma.client.create({
        data: {
          karbonEntityKey: karbonClient.entityKey,
          karbonEntityType: karbonClient.entityType,
          legalName: karbonClient.legalName,
          displayName: karbonClient.displayName ?? null,
          businessNumber: karbonClient.businessNumber ?? null,
          addressLine1: karbonClient.addressLine1 ?? null,
          addressLine2: karbonClient.addressLine2 ?? null,
          city: karbonClient.city ?? null,
          province: karbonClient.province ?? null,
          postalCode: karbonClient.postalCode ?? null,
          country: karbonClient.country ?? 'Canada',
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

      if (summary.entityKey) kept.push(summary.entityKey);
    }

    return {
      entityKeys: [...new Set(kept)],
      // Reported by the provider rather than guessed from the count. A list of
      // exactly the limit may or may not have more behind it, and two lists
      // drawn from two endpoints cannot be told apart by their total at all.
      truncated: more,
      byContactType,
      skippedByContactType,
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
