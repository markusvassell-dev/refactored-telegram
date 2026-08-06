import { PrismaClient } from '@element/database';
import { KarbonRestClient, type KarbonProvider, type KarbonWorkItem } from '@element/integrations';
import { createLogger, decryptSecret, loadEnv } from '@element/shared';

/**
 * Exercising Karbon against a real tenant.
 *
 * Every capability in the matrix is `UNVERIFIED`: implemented against Karbon's
 * published documentation and never run against a live account from this
 * project. Promoting a row is not a code change — it is evidence — and the
 * checklist step that produced that evidence was "exercise each operation
 * against the sandbox with a test work item", which is a morning of careful
 * manual work nobody repeats.
 *
 * This is that morning, as one command. It reports what each operation
 * actually did, including the vendor's own error text, so the matrix can be
 * updated from observation.
 *
 * Two safety properties, both deliberate:
 *
 *   - It uses the credentials already stored on the Integrations screen. There
 *     is no second home for a Karbon credential, and no way to pass one on the
 *     command line where it would land in a shell history.
 *   - It performs **no writes** unless asked, and refuses to write at all
 *     against a connection not marked sandbox. Reading a production tenant is
 *     harmless; writing to one from a verification script is not.
 *
 * Usage:
 *   pnpm verify:karbon                          # read-only
 *   pnpm verify:karbon --work-item <KEY>        # exercise a specific work item
 *   pnpm verify:karbon --allow-writes           # include writes (sandbox only)
 */

type Outcome = 'PASS' | 'FAIL' | 'SKIP';

interface Result {
  capability: string;
  outcome: Outcome;
  detail: string;
}

const results: Result[] = [];

function record(capability: string, outcome: Outcome, detail: string): void {
  results.push({ capability, outcome, detail });
  const mark = outcome === 'PASS' ? '  ok  ' : outcome === 'FAIL' ? ' FAIL ' : ' skip ';
  process.stdout.write(`[${mark}] ${capability.padEnd(26)} ${detail}\n`);
}

/** Runs one capability, turning any throw into a recorded failure. */
async function attempt<T>(capability: string, run: () => Promise<T>, describe: (value: T) => string): Promise<T | null> {
  try {
    const value = await run();
    record(capability, 'PASS', describe(value));
    return value;
  } catch (error) {
    // The vendor's own message is the point of this script.
    record(capability, 'FAIL', error instanceof Error ? error.message : String(error));
    return null;
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const allowWrites = process.argv.includes('--allow-writes');

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const logger = createLogger({ level: 'warn', base: { service: 'verify-karbon' } });

  try {
    const connection = await prisma.integrationConnection.findUnique({ where: { provider: 'KARBON' } });

    if (!connection || !connection.encryptedCredentials) {
      fail(
        'No Karbon connection is configured.',
        'Open the Integrations screen, enter the bearer token and access key, leave the environment set to Sandbox, and save.',
      );
    }

    let credentials: { bearerToken?: string; accessKey?: string } = {};
    try {
      credentials = JSON.parse(decryptSecret(connection.encryptedCredentials, env.ENCRYPTION_KEY));
    } catch {
      fail(
        'The stored Karbon credentials could not be decrypted.',
        'ENCRYPTION_KEY has probably changed since they were entered. Re-enter them on the Integrations screen.',
      );
    }

    if (!credentials.bearerToken || !credentials.accessKey) {
      fail('The stored Karbon connection is missing a bearer token or an access key.', 'Re-enter both on the Integrations screen.');
    }

    const environment = connection.isSandbox ? 'SANDBOX' : 'PRODUCTION';
    process.stdout.write(`\nKarbon verification\n`);
    process.stdout.write(`  base URL     ${connection.baseUrl ?? env.KARBON_API_BASE_URL}\n`);
    process.stdout.write(`  environment  ${environment}\n`);
    process.stdout.write(`  used by app  ${connection.isEnabled ? 'yes' : 'NO — the application is using the mock adapter'}\n`);
    process.stdout.write(`  writes       ${writeMode(connection.isSandbox)}\n\n`);

    // This script reads the credentials directly, so it verifies a connection
    // the application itself may not be using. Passing every check while the
    // app quietly runs on a mock is exactly the kind of mismatch that makes an
    // integration look finished when nothing is wired to it.
    if (!connection.isEnabled) {
      process.stdout.write('  NOTE: "Use this connection" is set to No on the Integrations screen, so\n');
      process.stdout.write('        everything below tests credentials the application is not using.\n');
      process.stdout.write('        Set it to Yes once these checks pass.\n\n');
    }

    if (allowWrites && !connection.isSandbox) {
      fail(
        'Refusing to write to a production Karbon tenant.',
        'This script writes test comments, tasks and documents. Point it at a sandbox connection, or run it without --allow-writes.',
      );
    }

    const client: KarbonProvider = new KarbonRestClient({
      baseUrl: connection.baseUrl ?? env.KARBON_API_BASE_URL,
      bearerToken: credentials.bearerToken,
      accessKey: credentials.accessKey,
      logger,
    });

    await verify(client, argument('work-item'));
  } finally {
    await prisma.$disconnect();
  }

  summarise();
}

function writeMode(isSandbox: boolean): string {
  if (!allowWrites) return 'read-only (pass --allow-writes to include them)';
  return isSandbox ? 'ENABLED — this will create test data in the sandbox' : 'refused (not a sandbox connection)';
}

async function verify(client: KarbonProvider, workItemKey: string | undefined): Promise<void> {
  // ---- Connectivity -------------------------------------------------------
  const health = await attempt(
    'HEALTH_CHECK',
    () => client.healthCheck(),
    (value) => (value.ok ? 'reachable and authenticated' : `reachable, not accepted: ${value.detail ?? 'no detail'}`),
  );

  if (!health?.ok) {
    record('SEARCH_WORK_ITEMS', 'SKIP', 'no usable connection; nothing further was attempted');
    return;
  }

  // ---- Reads --------------------------------------------------------------
  // Bounded deliberately. Search now pages until the result set is exhausted,
  // and walking an entire tenant to prove that search works would spend the
  // account's request budget to learn nothing extra.
  const found = await attempt(
    'SEARCH_WORK_ITEMS',
    () => client.searchWorkItems({ limit: 5 }),
    (items) => `${items.length} work item(s) returned (asked for at most 5)`,
  );

  const subject: KarbonWorkItem | null =
    (workItemKey ? await attempt('READ_WORK_ITEM', () => client.getWorkItem(workItemKey), (item) => (item ? `"${item.title}"` : 'not found')) : null) ??
    found?.[0] ??
    null;

  if (!subject) {
    for (const capability of ['READ_WORK_ITEM', 'READ_CLIENT', 'LIST_DOCUMENTS', 'DOWNLOAD_DOCUMENT']) {
      record(capability, 'SKIP', 'no work item available; pass --work-item <KEY> to name one');
    }
  } else {
    if (!workItemKey) {
      await attempt('READ_WORK_ITEM', () => client.getWorkItem(subject.workItemKey), (item) => (item ? `"${item.title}"` : 'not found'));
    }

    if (subject.clientKey) {
      await attempt(
        'READ_CLIENT',
        () => client.getClient(subject.clientKey as string),
        (found) => (found ? `${found.legalName} (${found.entityType})` : 'no organisation or contact matched that key'),
      );
    } else {
      record('READ_CLIENT', 'SKIP', 'the work item carries no client key');
    }

    const documents = await attempt(
      'LIST_DOCUMENTS',
      () => client.listDocuments({ workItemKey: subject.workItemKey }),
      (list) => `${list.length} document(s)`,
    );

    if (documents && documents.length > 0) {
      await attempt(
        'DOWNLOAD_DOCUMENT',
        () => client.downloadDocument(documents[0]!.documentId),
        (file) => `${file.fileName}, ${file.content.byteLength} bytes, ${file.mimeType}`,
      );
    } else {
      record('DOWNLOAD_DOCUMENT', 'SKIP', 'the work item has no documents to download');
    }
  }

  // ---- Writes -------------------------------------------------------------
  if (!allowWrites) {
    for (const capability of ['ADD_COMMENT', 'CREATE_TASK', 'UPDATE_WORK_ITEM_STATUS']) {
      record(capability, 'SKIP', 'read-only run');
    }
    return;
  }

  if (!subject) {
    for (const capability of ['ADD_COMMENT', 'CREATE_TASK', 'UPDATE_WORK_ITEM_STATUS']) {
      record(capability, 'SKIP', 'no work item to write to');
    }
    return;
  }

  const stamp = new Date().toISOString();

  await attempt(
    'ADD_COMMENT',
    () =>
      client.addComment({
        workItemKey: subject.workItemKey,
        body: `Element Engagements verification run at ${stamp}. This note was posted by a test and can be deleted.`,
        idempotencyKey: `verify_comment_${stamp}`,
      }),
    (result) => `${result.outcome}${result.objectId ? ` (${result.objectId})` : ''}`,
  );

  // The interesting outcome here is SKIPPED_UNSUPPORTED, not failure: task
  // availability varies by tenant and plan, and the fallback is the design.
  await attempt(
    'CREATE_TASK',
    () =>
      client.createTask({
        workItemKey: subject.workItemKey,
        title: 'Element Engagements verification task',
        description: `Created by a verification run at ${stamp}. Safe to delete.`,
        idempotencyKey: `verify_task_${stamp}`,
      }),
    (result) =>
      result.outcome === 'SKIPPED_UNSUPPORTED'
        ? `tasks unavailable on this tenant; fell back to a note — ${result.message ?? ''}`
        : `${result.outcome}${result.objectId ? ` (${result.objectId})` : ''}`,
  );

  record('UPDATE_WORK_ITEM_STATUS', 'SKIP', 'not attempted: status values are tenant-specific and changing one alters real workflow state');
  record('UPLOAD_DOCUMENT', 'SKIP', 'not attempted: verify uploads deliberately, against a work item you have chosen');
}

function summarise(): void {
  const passed = results.filter((r) => r.outcome === 'PASS').length;
  const failed = results.filter((r) => r.outcome === 'FAIL').length;
  const skipped = results.filter((r) => r.outcome === 'SKIP').length;

  process.stdout.write(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  if (failed > 0) {
    process.stdout.write('\nA failure here is information, not necessarily a defect: it may mean the\n');
    process.stdout.write('operation is genuinely unavailable on this tenant. Record it as UNSUPPORTED\n');
    process.stdout.write('with its fallback rather than leaving it UNVERIFIED.\n');
  }

  process.stdout.write('\nNext: update packages/integrations/src/karbon/capabilities.ts and\n');
  process.stdout.write('docs/karbon-capability-matrix.md from what you just saw. A row stays\n');
  process.stdout.write('UNVERIFIED until it has been observed working here.\n\n');

  // A failed operation is a finding to record, not a broken script.
  process.exitCode = results.some((r) => r.capability === 'HEALTH_CHECK' && r.outcome === 'FAIL') ? 1 : 0;
}

function fail(message: string, remedy: string): never {
  process.stderr.write(`\n${message}\n${remedy}\n\n`);
  process.exit(1);
}

await main();
