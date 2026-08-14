import type { PrismaClient } from '@element/database';
import {
  AWAITING_APPROVED_TEMPLATE,
  PRODUCTION_SUPPORTED_DOCUMENT_TYPES,
  inspectStorageDurability,
  type DocumentType,
} from '@element/shared';

/**
 * What a deployment still needs before it can produce a real engagement letter.
 *
 * The dashboard is a work queue: counts of engagements by status. On a freshly
 * deployed instance — mock Karbon, no firm signer, no real clients — every one
 * of those counts is legitimately zero, so the screen reports that there is
 * nothing to do. Which is true, and useless: there is nothing to do *because
 * nothing has been set up*, and the two states look identical.
 *
 * Every setting named here already has an editor. What did not exist was any
 * single place that says which of them are still empty, so "is this thing
 * configured?" meant remembering to open five screens and knowing what each
 * should say.
 *
 * This reports; it does not fix. Connecting Karbon and importing clients are
 * decisions with credentials attached, and belong to a person.
 */

export type ReadinessSeverity = 'BLOCKER' | 'ATTENTION';

export interface ReadinessItem {
  key: string;
  /** What is wrong, as a person would say it. */
  title: string;
  /** Why it matters, in one sentence. */
  detail: string;
  /** The screen that fixes it. */
  href: string;
  severity: ReadinessSeverity;
}

export interface ReadinessInput {
  prisma: PrismaClient;
  /** From `resolveProviders` — already plain language, so it is quoted rather than re-derived. */
  providerDescription: { karbon: string; adobeSign: string };
  testMode: { testMode: boolean; productionSendingEnabled: boolean };
  documentStorageDirectory: string;
}

/**
 * A mock adapter names itself. `resolveProviders` builds these strings, and
 * matching on them keeps one description of what is connected rather than two
 * that can disagree.
 */
function isMockDescription(description: string): boolean {
  return description.startsWith('mock adapter');
}

export async function checkReadiness(input: ReadinessInput): Promise<ReadinessItem[]> {
  const items: ReadinessItem[] = [];

  const [firmSigner, realClients, templates, storage] = await Promise.all([
    input.prisma.systemSetting.findUnique({ where: { key: 'firm_signer_user_id' }, select: { value: true } }),
    // Fixtures are seeded for demonstration and are not the firm's clients.
    input.prisma.client.count({ where: { isTestFixture: false } }),
    input.prisma.documentTemplate.findMany({
      where: { isProductionSupported: true },
      select: { documentType: true, versions: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 } },
    }),
    inspectStorageDurability(input.documentStorageDirectory),
  ]);

  // ---- Karbon -------------------------------------------------------------
  // First because everything else assumes it: Karbon is the system of record,
  // and against a mock every filing is recorded against an id that exists
  // nowhere.
  if (isMockDescription(input.providerDescription.karbon)) {
    items.push({
      key: 'karbon',
      title: 'Karbon is not connected',
      detail:
        'Documents cannot be filed and client information cannot be read. Signed letters would exist only inside this application.',
      href: '/integrations',
      severity: 'BLOCKER',
    });
  }

  // ---- Firm signer --------------------------------------------------------
  const firmSignerId = typeof firmSigner?.value === 'string' ? firmSigner.value : '';
  if (!firmSignerId) {
    items.push({
      key: 'firm-signer',
      title: 'No firm signer has been named',
      detail:
        'The firm signs before a letter reaches a client, so preparation cannot propose signers and nothing can be sent until one is set.',
      href: '/settings',
      severity: 'BLOCKER',
    });
  }

  // ---- Clients ------------------------------------------------------------
  if (realClients === 0) {
    items.push({
      key: 'clients',
      title: 'No clients have been imported',
      detail: 'Only sample records exist. An engagement needs a real client before it can be prepared.',
      href: '/clients',
      severity: 'BLOCKER',
    });
  }

  // ---- Templates ----------------------------------------------------------
  const withoutActiveVersion = templates
    .filter((template) => template.versions.length === 0)
    .map((template) => template.documentType);

  if (withoutActiveVersion.length > 0) {
    items.push({
      key: 'templates',
      title: `${withoutActiveVersion.length} approved template(s) have no active version`,
      detail: `Documents of these types cannot be generated: ${withoutActiveVersion.join(', ').toLowerCase().replace(/_/g, ' ')}.`,
      href: '/templates',
      severity: 'BLOCKER',
    });
  }

  // Known-absent templates are reported separately and softly: they are work
  // that has not been done, not a deployment that is broken.
  const awaiting = AWAITING_APPROVED_TEMPLATE.filter(
    (type) => !PRODUCTION_SUPPORTED_DOCUMENT_TYPES.includes(type as DocumentType),
  );
  if (awaiting.length > 0) {
    items.push({
      key: 'awaiting-templates',
      title: `${awaiting.length} document type(s) have no approved template yet`,
      detail: `Engagements of these types cannot be run at all: ${awaiting.join(', ').toLowerCase().replace(/_/g, ' ')}.`,
      href: '/templates',
      severity: 'ATTENTION',
    });
  }

  // ---- Adobe --------------------------------------------------------------
  // Attention rather than blocker: the manual signing path works without it.
  if (isMockDescription(input.providerDescription.adobeSign)) {
    items.push({
      key: 'adobe-sign',
      title: 'Adobe Acrobat Sign is not connected',
      detail:
        'Letters can still be signed by recording a signature obtained elsewhere; sending for signature from here needs a connection.',
      href: '/integrations',
      severity: 'ATTENTION',
    });
  }

  // ---- Sending ------------------------------------------------------------
  if (input.testMode.testMode) {
    items.push({
      key: 'test-mode',
      title: 'Test Mode is on',
      detail: 'Nothing reaches a real client, and nothing is written to production Karbon or Adobe Sign.',
      href: '/settings',
      severity: 'ATTENTION',
    });
  } else if (!input.testMode.productionSendingEnabled) {
    items.push({
      key: 'production-sending',
      title: 'Production sending is not armed',
      detail: 'Letters can be prepared and approved, but not sent.',
      href: '/settings',
      severity: 'ATTENTION',
    });
  }

  // ---- Storage ------------------------------------------------------------
  // Only the genuinely bad reading is reported. Documents are database rows;
  // this concerns files written before that change, which a redeploy discards.
  if (storage.durability === 'EPHEMERAL') {
    items.push({
      key: 'storage',
      title: 'Document storage is on container disk',
      detail: storage.detail,
      href: '/settings',
      severity: 'ATTENTION',
    });
  }

  return items;
}
