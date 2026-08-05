import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@element/shared';

/**
 * The deployment contract.
 *
 * A misconfigured deployment does not announce itself: Railway reports every
 * start-up failure as "healthcheck failed", which is never the actual reason.
 * These tests pin the properties that make the difference between a legible
 * failure and an opaque one.
 */

const root = resolve(import.meta.dirname, '..', '..');
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

// NODE_ENV is declared required on NodeJS.ProcessEnv by the Next type
// definitions, so it appears here to satisfy the signature rather than because
// any of these assertions depend on it.
const MINIMUM = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@host:5432/db',
  ENCRYPTION_KEY: '0'.repeat(64),
  SESSION_SECRET: '0'.repeat(64),
} satisfies NodeJS.ProcessEnv;

describe('the first administrator', () => {
  it('is nobody by default, so a deployment grants no accidental access', () => {
    expect(loadEnv({ ...MINIMUM }).BOOTSTRAP_ADMIN_EMAILS).toEqual([]);
    expect(loadEnv({ ...MINIMUM, BOOTSTRAP_ADMIN_EMAILS: '' }).BOOTSTRAP_ADMIN_EMAILS).toEqual([]);
    expect(loadEnv({ ...MINIMUM, BOOTSTRAP_ADMIN_EMAILS: '  ,  , ' }).BOOTSTRAP_ADMIN_EMAILS).toEqual([]);
  });

  it('is matched case-insensitively, because a directory address is not case-sensitive', () => {
    const parsed = loadEnv({ ...MINIMUM, BOOTSTRAP_ADMIN_EMAILS: 'Partner@Firm.CA' });
    expect(parsed.BOOTSTRAP_ADMIN_EMAILS).toEqual(['partner@firm.ca']);
  });

  it('accepts a list, tolerating the spaces a person types after a comma', () => {
    const parsed = loadEnv({ ...MINIMUM, BOOTSTRAP_ADMIN_EMAILS: 'a@firm.ca, b@firm.ca ,c@firm.ca' });
    expect(parsed.BOOTSTRAP_ADMIN_EMAILS).toEqual(['a@firm.ca', 'b@firm.ca', 'c@firm.ca']);
  });
});

describe('what the environment schema refuses', () => {
  it('refuses to boot in production without Entra ID, rather than serving with no way in', () => {
    expect(() => loadEnv({ ...MINIMUM, APP_ENV: 'production' })).toThrow(/Microsoft Entra ID/i);
  });

  it('refuses the development login outside development', () => {
    expect(() =>
      loadEnv({
        ...MINIMUM,
        APP_ENV: 'staging',
        DEV_LOGIN_ENABLED: 'true',
        ENTRA_TENANT_ID: 't',
        ENTRA_CLIENT_ID: 'c',
        ENTRA_CLIENT_SECRET: 's',
      }),
    ).toThrow(/development login cannot be enabled/i);
  });

  it('names the missing key, so a deploy log says which one', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: '0'.repeat(64), SESSION_SECRET: '0'.repeat(64) }),
    ).toThrow(/DATABASE_URL/);
  });
});

describe('the image', () => {
  const dockerfile = read('Dockerfile');

  it('exposes one port, because two make the health-check target a coin toss', () => {
    const exposed = dockerfile.match(/^EXPOSE .*/gm) ?? [];
    expect(exposed).toHaveLength(1);
    expect(exposed[0]).toBe('EXPOSE 3000');
  });

  it('keeps the pnpm corepack cache outside a user home, so the runtime user can read it', () => {
    expect(dockerfile).toMatch(/COREPACK_HOME=/);
  });

  it('starts through the scripts that report why a start-up failed', () => {
    expect(dockerfile).toMatch(/CMD \["\.\/scripts\/start-web\.sh"\]/);
  });
});

describe('the build context', () => {
  const dockerignore = read('.dockerignore');

  it('excludes anything that could carry a credential into a layer', () => {
    expect(dockerignore).toMatch(/^\.env$/m);
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^!\.env\.example$/m);
  });

  it('excludes the artefacts the build regenerates', () => {
    for (const entry of ['node_modules', '.next', 'storage']) {
      expect(dockerignore).toMatch(new RegExp(`^${entry.replace('.', '\\.')}$`, 'm'));
    }
  });
});

describe('the Railway service definitions', () => {
  const web = JSON.parse(read('railway.json')) as { deploy: Record<string, unknown> };
  const worker = JSON.parse(read('railway.worker.json')) as { deploy: Record<string, unknown> };

  it('gates each deploy on liveness, so start-up order cannot fail a deployment', () => {
    expect(web.deploy.healthcheckPath).toBe('/api/health');
    expect(worker.deploy.healthcheckPath).toBe('/health');
  });

  it('allows migrations time to run before the first probe gives up', () => {
    expect(Number(web.deploy.healthcheckTimeout)).toBeGreaterThanOrEqual(300);
    expect(Number(worker.deploy.healthcheckTimeout)).toBeGreaterThanOrEqual(300);
  });

  it('starts through the scripts rather than a chained shell command that hides its failure', () => {
    expect(web.deploy.startCommand).toBe('./scripts/start-web.sh');
    expect(worker.deploy.startCommand).toBe('./scripts/start-worker.sh');
  });
});

describe('the start scripts', () => {
  const webScript = read('scripts/start-web.sh');
  const workerScript = read('scripts/start-worker.sh');

  it('listen on the port the platform assigns rather than one of their own choosing', () => {
    expect(webScript).toMatch(/PORT="\$\{PORT:-3000\}"/);
    expect(workerScript).toMatch(/PORT="\$\{PORT:-\$\{WORKER_HEALTH_PORT:-3001\}\}"/);
  });

  it('say which failure happened instead of letting it read as a health-check failure', () => {
    expect(webScript).toMatch(/FATAL: DATABASE_URL is not set/);
    expect(webScript).toMatch(/FATAL: database migrations failed/);
    expect(workerScript).toMatch(/FATAL: DATABASE_URL is not set/);
  });

  it('leaves migrations to the web service alone, so two services cannot race', () => {
    expect(webScript).toMatch(/pnpm db:migrate/);
    expect(workerScript).not.toMatch(/pnpm db:migrate/);
  });

  it('check configuration before starting, so a missing key fails the deploy rather than every page', () => {
    expect(webScript).toMatch(/scripts\/check-env\.ts/);
    expect(workerScript).toMatch(/scripts\/check-env\.ts/);
  });

  it('check configuration before touching the database, so the clearer error surfaces first', () => {
    expect(webScript.indexOf('check-env.ts')).toBeLessThan(webScript.indexOf('pnpm db:migrate'));
  });

  it('abort on an unset variable rather than starting with a blank one', () => {
    expect(webScript).toMatch(/^set -eu$/m);
    expect(workerScript).toMatch(/^set -eu$/m);
  });
});
