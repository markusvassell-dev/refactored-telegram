import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Keeping the database password out of the deploy log.
 *
 * `prisma migrate deploy` prints its datasource on every boot — password
 * included — and that goes straight into Railway's deploy log. The live
 * credential left this deployment three times that way: screenshotted, pasted
 * into a chat, and handed to whoever was helping, before anybody noticed it was
 * there.
 *
 * Rotating a leaked credential fixes the exposure once. It does nothing about
 * the next boot, which is what these assertions are for.
 */

const root = resolve(__dirname, '..', '..');

/** Runs a snippet against the real preflight functions, as the container does. */
function inPreflight(script: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('sh', ['-c', `set -eu; . ./scripts/preflight.sh\n${script}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, status: failure.status ?? 1 };
  }
}

describe('redacting a connection string', () => {
  it('removes the password from the line Prisma actually prints', () => {
    // The real shape, taken verbatim from a production deploy log.
    const line =
      'Datasource "db": PostgreSQL database "railway", schema "public" at postgresql://postgres:s3cr3tvalue@postgres.railway.internal:5432/railway';

    const { stdout } = inPreflight(`printf '%s\\n' '${line}' | redact_secrets`);

    expect(stdout).not.toContain('s3cr3tvalue');
    expect(stdout).toContain('********');
    // The rest survives: a redacted log still has to be readable.
    expect(stdout).toContain('postgres.railway.internal:5432');
    expect(stdout).toContain('Datasource "db"');
  });

  it('leaves lines with no credential alone', () => {
    const { stdout } = inPreflight(`printf 'No pending migrations to apply.\\n' | redact_secrets`);

    expect(stdout.trim()).toBe('No pending migrations to apply.');
  });

  it('keeps a failure a failure', () => {
    /*
      The reason this is not a plain pipe. `cmd | redact_secrets` reports the
      filter's exit status, and these scripts are POSIX `sh`, where `pipefail`
      does not exist — so a failed migration would have been reported as a
      successful one and the service would have started against an unmigrated
      database. That is a far worse outcome than the leak this fixes.
    */
    const { stdout, status } = inPreflight(
      `fail() { echo 'Error: postgresql://postgres:s3cr3tvalue@host:5432/db'; return 1; }\n` +
        // Exiting with a distinct code, rather than testing through `if`, which
        // would consume the failure and leave the script itself exiting zero.
        `run_redacted fail || exit 3\n` +
        `echo UNEXPECTED_SUCCESS`,
    );

    expect(status).toBe(3);
    expect(stdout).not.toContain('s3cr3tvalue');
    expect(stdout).not.toContain('UNEXPECTED_SUCCESS');
    // The failure is still reported, just without the credential in it.
    expect(stdout).toContain('********');
  });

  it('is actually used by the commands that print one', () => {
    // The function existing is not the same as it being applied.
    const startWeb = readFileSync(resolve(root, 'scripts/start-web.sh'), 'utf8');

    expect(startWeb).toMatch(/run_redacted pnpm db:migrate/);
    expect(startWeb).toMatch(/run_redacted pnpm db:seed/);
  });
});
