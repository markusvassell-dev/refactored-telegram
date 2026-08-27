import { PrismaClient } from '@element/database';
import { AdobeSignRestClient } from '@element/integrations';
import { createLogger, decryptSecret, describeBuild, loadEnv } from '@element/shared';

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

/**
 * Runs one capability and decides whether the result is evidence.
 *
 * `proves` is separate from `describe` on purpose. Without it, "did it throw?"
 * becomes the whole test, and a call that returns something unexpected is
 * reported as a pass — which is how this project once promoted a capability to
 * "supported" on the strength of a line reading `ok  not found`. A check that
 * cannot fail is not a check.
 */
async function attempt<T>(
  capability: string,
  run: () => Promise<T>,
  describe: (value: T) => string,
  proves: (value: T) => boolean = () => true,
): Promise<T | null> {
  try {
    const value = await run();
    const outcome: Outcome = proves(value) ? 'PASS' : 'FAIL';
    record(capability, outcome, describe(value));
    return outcome === 'PASS' ? value : null;
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
    let connection;
    try {
      connection = await prisma.integrationConnection.findUnique({ where: { provider: 'ADOBE_SIGN' } });
    } catch (error) {
      // Every other precondition here explains itself. This one used to exit
      // with a raw Prisma stack trace, in a script whose whole purpose is to
      // say what is wrong and what to do about it.
      fail(
        `The database could not be reached, so the stored connection could not be read: ${firstLine(error)}`,
        'Check DATABASE_URL and that the database is running. Nothing was sent to Adobe.',
      );
    }

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
    // First, because a run that reports failures already fixed and pushed is
    // indistinguishable from a vendor refusing them.
    process.stdout.write(`  build        ${describeBuild()}\n`);
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

    // The health check performs the OAuth refresh and reads one page of
    // agreements, so it proves three things at once: the credentials are
    // accepted, the base URL is the right region, and the token carries
    // `agreement_read` — the scope every operation this application performs
    // depends on. It used to read `/users/me`, which needs `user_read` and
    // therefore said nothing about whether a letter could be sent.
    const health = await attempt(
      'OAUTH_AND_AGREEMENT_READ',
      () => client.healthCheck(),
      (value) =>
        value.ok
          ? 'credentials accepted, region correct, and the token can read agreements'
          : `refused: ${value.detail ?? 'no detail'}`,
      (value) => value.ok,
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
      (found) =>
        found === null
          ? 'completed, and correctly found no match for an impossible key'
          : `unexpectedly matched ${found} — the externalId filter is not being applied`,
      // A match against a key containing the current millisecond cannot be
      // real. If one comes back, Adobe ignored the filter and returned some
      // other agreement — which would make the duplicate check suppress a
      // genuine send rather than prevent a repeat one. That is a failure, and
      // reporting it as a pass is how it would go unnoticed.
      (found) => found === null,
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

/**
 * The line of a database error that actually says what went wrong.
 *
 * Prisma spreads one fault over a dozen lines: a blank first line, then
 * `Invalid \`prisma.x.findUnique()\` invocation in`, then a file and line
 * number, and only then the sentence a person needs — "Can't reach database
 * server at localhost:5432". Neither `split('\n')[0]` nor "the first non-empty
 * line" reaches it; both were tried here and both printed the preamble.
 *
 * So the diagnosis is looked for by what it says, with the first non-empty
 * line as a fallback for a shape not seen before.
 */
const DIAGNOSTIC = /can't reach|cannot reach|authentication failed|does not exist|timed out|ECONNREFUSED|ENOTFOUND/i;

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.find((line) => DIAGNOSTIC.test(line)) ?? lines[0] ?? 'no detail';
}

function fail(message: string, remedy: string): never {
  process.stderr.write(`\n${message}\n${remedy}\n\n`);
  process.exit(1);
}

await main();
