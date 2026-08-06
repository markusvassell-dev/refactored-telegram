import { PrismaClient } from '@element/database';
import { AdobeSignRestClient } from '@element/integrations';
import { createLogger, decryptSecret, loadEnv } from '@element/shared';

/**
 * Exercising Acrobat Sign against a real account.
 *
 * The companion to `verify:karbon`, and deliberately narrower.
 *
 * **This script never writes.** Karbon's writes are a note and a task on a work
 * item — untidy at worst. Adobe's principal write is an agreement, and creating
 * one emails a real person asking them to sign a document. There is no version
 * of that which belongs in a verification script, so the write path is not
 * offered at all, not even behind a flag. Verify signing by running one
 * engagement end to end in Test Mode, where the blocked adapter stands between
 * the application and the vendor.
 *
 * What it can prove without sending anything:
 *
 *   - the client id, secret and refresh token are accepted, which is the OAuth
 *     exchange and the commonest thing to have wrong;
 *   - the API base URL is the right one for the account's region, which is the
 *     second commonest;
 *   - the token's scopes reach the agreement list;
 *   - the duplicate check — the thing standing between a retried job and a
 *     client receiving a second signature request — completes rather than
 *     failing open.
 *
 * Usage:
 *   pnpm verify:adobe
 */

type Outcome = 'PASS' | 'FAIL' | 'SKIP';

const results: { capability: string; outcome: Outcome; detail: string }[] = [];

function record(capability: string, outcome: Outcome, detail: string): void {
  results.push({ capability, outcome, detail });
  const mark = outcome === 'PASS' ? '  ok  ' : outcome === 'FAIL' ? ' FAIL ' : ' skip ';
  process.stdout.write(`[${mark}] ${capability.padEnd(26)} ${detail}\n`);
}

async function attempt<T>(capability: string, run: () => Promise<T>, describe: (value: T) => string): Promise<T | null> {
  try {
    const value = await run();
    record(capability, 'PASS', describe(value));
    return value;
  } catch (error) {
    record(capability, 'FAIL', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const logger = createLogger({ level: 'warn', base: { service: 'verify-adobe-sign' } });

  try {
    const connection = await prisma.integrationConnection.findUnique({ where: { provider: 'ADOBE_SIGN' } });

    if (!connection || !connection.encryptedCredentials) {
      fail(
        'No Adobe Sign connection is configured.',
        'Open the Integrations screen, enter the client ID, client secret and refresh token, set the API base URL for your region, leave the environment set to Sandbox, and save.',
      );
    }

    let credentials: { clientId?: string; clientSecret?: string; refreshToken?: string } = {};
    try {
      credentials = JSON.parse(decryptSecret(connection.encryptedCredentials, env.ENCRYPTION_KEY));
    } catch {
      fail(
        'The stored Adobe Sign credentials could not be decrypted.',
        'ENCRYPTION_KEY has probably changed since they were entered. Re-enter them on the Integrations screen.',
      );
    }

    const missing = (['clientId', 'clientSecret', 'refreshToken'] as const).filter((key) => !credentials[key]);
    if (missing.length > 0) {
      fail(`The stored Adobe Sign connection is missing: ${missing.join(', ')}.`, 'Re-enter them on the Integrations screen.');
    }

    const baseUrl = connection.baseUrl ?? env.ADOBE_SIGN_API_BASE_URL ?? '';
    if (!baseUrl) {
      fail(
        'No Adobe Sign API base URL is set.',
        'It is region-specific and there is no safe default — for example https://api.na1.adobesign.com. Set it on the Integrations screen.',
      );
    }

    process.stdout.write('\nAdobe Acrobat Sign verification\n');
    process.stdout.write(`  base URL     ${baseUrl}\n`);
    process.stdout.write(`  environment  ${connection.isSandbox ? 'SANDBOX' : 'PRODUCTION'}\n`);
    process.stdout.write(`  used by app  ${connection.isEnabled ? 'yes' : 'NO — the application is using the mock adapter'}\n`);
    process.stdout.write('  writes       never — this script cannot create an agreement\n\n');

    if (!connection.isEnabled) {
      process.stdout.write('  NOTE: "Use this connection" is set to No on the Integrations screen, so\n');
      process.stdout.write('        everything below tests credentials the application is not using.\n\n');
    }

    const client = new AdobeSignRestClient({
      baseUrl,
      clientId: credentials.clientId as string,
      clientSecret: credentials.clientSecret as string,
      refreshToken: credentials.refreshToken as string,
      logger,
    });

    // The health check performs the OAuth refresh and one read, so a failure
    // here is almost always the refresh token or the region.
    const health = await attempt(
      'OAUTH_AND_REACHABILITY',
      () => client.healthCheck(),
      (value) => (value.ok ? 'credentials accepted and the region endpoint answered' : `refused: ${value.detail ?? 'no detail'}`),
    );

    if (!health?.ok) {
      record('DUPLICATE_CHECK', 'SKIP', 'no usable connection; nothing further was attempted');
      process.stdout.write('\nA failure above is usually one of three things:\n');
      process.stdout.write('  - the refresh token has expired or was revoked;\n');
      process.stdout.write('  - the API base URL is for a different region than the account;\n');
      process.stdout.write('  - the integration lacks the agreement_read scope.\n');
      summarise();
      return;
    }

    // Reads the agreement list under a key nothing can match. It proves the
    // scope and, more importantly, that the check completes — a duplicate
    // check that cannot read the list used to answer "no duplicate", which is
    // how a retry sends a client a second copy of a letter.
    await attempt(
      'DUPLICATE_CHECK',
      () => client.findByExternalId(`verification-probe-${Date.now()}`),
      (found) => (found === null ? 'completed, and correctly found no match for an impossible key' : `unexpectedly matched ${found}`),
    );

    record('CREATE_AGREEMENT', 'SKIP', 'never attempted: creating one emails a real person asking them to sign');
    record('DOWNLOAD_SIGNED_PDF', 'SKIP', 'needs a completed agreement; exercise it through a Test Mode engagement');
    record('WEBHOOKS', 'SKIP', 'needs a subscription and an inbound request, which no script can arrange');
  } finally {
    await prisma.$disconnect();
  }

  summarise();
}

function summarise(): void {
  const passed = results.filter((r) => r.outcome === 'PASS').length;
  const failed = results.filter((r) => r.outcome === 'FAIL').length;
  const skipped = results.filter((r) => r.outcome === 'SKIP').length;

  process.stdout.write(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.stdout.write('\nSigning itself is verified by running one engagement end to end with Test\n');
  process.stdout.write('Mode on, not from here. That is the only way to see a real agreement\n');
  process.stdout.write('without sending one to a client by accident.\n\n');

  process.exitCode = failed > 0 ? 1 : 0;
}

function fail(message: string, remedy: string): never {
  process.stderr.write(`\n${message}\n${remedy}\n\n`);
  process.exit(1);
}

await main();
