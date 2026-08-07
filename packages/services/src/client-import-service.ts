import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import type { KarbonProvider } from '@element/integrations';
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
 *   - **It never overwrites.** A client already here may have been corrected by
 *     a person — a legal name Karbon has wrong, a business number typed from
 *     the CRA notice rather than the CRM. Karbon is the system of record for
 *     documents, not for the details that go *into* a legal document. Existing
 *     clients are reported as differing, never rewritten.
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

export interface ClientImportInput {
  karbon: KarbonProvider;
  actor: Principal;
  /** How many work items to look through for distinct clients. */
  limit?: number;
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
  dryRun: boolean;
  notes: string[];
}

/** Work items to examine. Each distinct client among them is a candidate. */
const DEFAULT_LIMIT = 200;

export class ClientImportService {
  constructor(private readonly deps: ClientImportDeps) {}

  async run(input: ClientImportInput): Promise<ClientImportResult> {
    assertCan(input.actor, 'engagement:create');

    if (input.karbon.isMock) {
      throw new PreconditionError(
        'Karbon is not connected, so there is nothing to import. The mock adapter would add fictional sample clients to the real client list, where nothing would distinguish them from the firm’s own.',
      );
    }

    const limit = input.limit ?? DEFAULT_LIMIT;
    const notes: string[] = [];

    const workItems = await input.karbon.searchWorkItems({ limit });
    const entityKeys = [...new Set(workItems.map((item) => item.clientKey).filter((key): key is string => Boolean(key)))];

    if (workItems.length >= limit) {
      // The count is a floor, not a total. Saying "22 clients" when it is
      // "22 among the first 200 work items" is the kind of number somebody
      // reconciles against their client list and finds short.
      notes.push(
        `Examined the first ${limit} work items, which is as many as were asked for — there may be more clients beyond them.`,
      );
    }

    const result: ClientImportResult = {
      found: entityKeys.length,
      created: [],
      unchanged: 0,
      differing: [],
      failed: [],
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
        result.failed.push({ entityKey, reason: 'the work item names this client key, but no organisation or contact matched it' });
        continue;
      }

      const existing = await this.deps.prisma.client.findUnique({ where: { karbonEntityKey: entityKey } });

      if (existing) {
        const differences = compare(existing, karbonClient);
        if (differences.length > 0) {
          result.differing.push({ entityKey, legalName: existing.legalName, differences });
        } else {
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
        failed: result.failed.length,
      },
    });

    return result;
  }
}

/**
 * What differs between the client here and the one in Karbon.
 *
 * Only fields Karbon actually supplies. A blank in Karbon is not a difference —
 * it is Karbon not knowing, and treating it as one would report every client as
 * differing on every empty field.
 */
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
