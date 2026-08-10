import { existsSync, globSync, readFileSync } from 'node:fs';
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
    // Entra values of a real shape, so this test fails for its own reason
    // rather than incidentally tripping the Entra check.
    expect(() =>
      loadEnv({
        ...MINIMUM,
        APP_ENV: 'staging',
        DEV_LOGIN_ENABLED: 'true',
        ENTRA_TENANT_ID: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        ENTRA_CLIENT_ID: '4e4b1a2c-9f3d-4f2a-8c1b-0d5e6f7a8b9c',
        ENTRA_CLIENT_SECRET: 'a-client-secret-value',
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

  it('starts through the one entrypoint that decides its own role', () => {
    expect(dockerfile).toMatch(/CMD \["\.\/scripts\/start\.sh"\]/);
  });
});

describe('how the web server is started', () => {
  it('does not build a standalone bundle it will never serve', () => {
    // The image ships the whole workspace, so `output: 'standalone'` produced
    // a second copy of the server that nothing ran — and `next start` warned
    // "does not work with output: standalone" on every deploy while serving
    // anyway. A production warning that must be ignored teaches people to
    // ignore production warnings; either the config or the start command had
    // to go, and the config was the unused half.
    // Anchored to a real config line: the comment explaining the removal is
    // allowed to name the thing it removed.
    expect(read('apps/web/next.config.mjs')).not.toMatch(/^\s*output:\s*['"]standalone['"]/m);
  });

  it('names every ignored vendor-credential variable, because they were found set', () => {
    // A bearer token in the service variables and an Integrations screen
    // saying "not configured" is two sources of truth, one of them dead.
    const checkEnv = read('scripts/check-env.ts');
    for (const name of ['KARBON_BEARER_TOKEN', 'KARBON_ACCESS_KEY', 'ADOBE_SIGN_REFRESH_TOKEN']) {
      expect(checkEnv).toContain(name);
    }
  });
});

describe('what the application is allowed to frame', () => {
  const config = read('apps/web/next.config.mjs');

  /**
   * Every place the application embeds something in an iframe.
   *
   * Discovered rather than listed, because a hand-maintained list is exactly
   * what failed: a second viewer was added, the framing exception still named
   * only the first, and the browser replaced a perfectly correct PDF with
   * "refused to connect". A new entry here fails this test until whoever added
   * it has decided what the framed response's headers should be.
   */
  const VIEWERS: Record<string, string> = {
    // The src is built in lib/document-links.ts rather than written inline.
    'apps/web/src/app/engagements/[id]/workspace.tsx': '/api/documents',
    'apps/web/src/app/templates/[documentType]/page.tsx': '/api/templates',
  };

  const found = globSync('apps/web/src/**/*.tsx', { cwd: root })
    .filter((file) => read(file).includes('<iframe'))
    .sort();

  it('knows about every viewer in the application', () => {
    // Fails when an iframe appears somewhere new. That is the point: the
    // framed route needs its own exception, and nothing else will say so.
    expect(found).toEqual(Object.keys(VIEWERS).sort());
  });

  it('grants each framed route its own frame-ancestors exception', () => {
    // The blanket policy is `X-Frame-Options: DENY` and `frame-ancestors
    // 'none'`, which refuses even a same-origin parent. A framed route must
    // opt out, and `frame-src 'self'` on the page is not enough on its own.
    for (const [file, path] of Object.entries(VIEWERS)) {
      expect(read(file), `${file} frames ${path}`).toBeTruthy();
      expect(config, `${path} is framed but has no framing exception in next.config.mjs`).toContain(`${path}/:path*`);
    }
  });

  it('narrows the exception to this origin rather than lifting it', () => {
    expect(config).toMatch(/X-Frame-Options', value: 'SAMEORIGIN'/);
    expect(config).toMatch(/frame-ancestors 'self'/);
    // And the default stays closed.
    expect(config).toMatch(/frame-ancestors 'none'/);
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

describe('the Railway service definition', () => {
  const railway = JSON.parse(read('railway.json')) as { deploy: Record<string, unknown> };

  it('is the only one, because Railway reads only the root file', () => {
    // A second config that has to be selected per service is a setting nobody
    // remembers, and missing it makes the worker run the web service's command
    // and answer for the web service's health path.
    expect(existsSync(resolve(root, 'railway.worker.json'))).toBe(false);
  });

  it('gates the deploy on liveness, so start-up order cannot fail a deployment', () => {
    expect(railway.deploy.healthcheckPath).toBe('/api/health');
  });

  it('allows migrations time to run before the first probe gives up', () => {
    expect(Number(railway.deploy.healthcheckTimeout)).toBeGreaterThanOrEqual(300);
  });

  it('starts through the entrypoint rather than a chained command that hides its failure', () => {
    expect(railway.deploy.startCommand).toBe('./scripts/start.sh');
  });
});

describe('choosing which service a container becomes', () => {
  const entrypoint = read('scripts/start.sh');

  it('defaults to the web service, so an unset role is not a broken deployment', () => {
    expect(entrypoint).toMatch(/ROLE="\$\{SERVICE_ROLE:-web\}"/);
  });

  it('dispatches to both, and refuses a role it does not recognise', () => {
    expect(entrypoint).toMatch(/exec \.\/scripts\/start-web\.sh/);
    expect(entrypoint).toMatch(/exec \.\/scripts\/start-worker\.sh/);
    expect(entrypoint).toMatch(/FATAL: SERVICE_ROLE is/);
  });

  it('says so when it defaults, because a worker started as a web service looks healthy', () => {
    expect(entrypoint).toMatch(/NOTE: SERVICE_ROLE is not set/);
  });

  it('lets the worker answer the same health path, so one config serves both', () => {
    const worker = read('apps/worker/src/index.ts');
    expect(worker).toMatch(/'\/api\/health'/);
    expect(worker).toMatch(/'\/api\/ready'/);
  });

  it('takes the port the platform assigns rather than one of its own choosing', () => {
    const worker = read('apps/worker/src/index.ts');
    expect(worker).toMatch(/process\.env\.PORT/);
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
    expect(webScript).toMatch(/require_database_url/);
    expect(webScript).toMatch(/FATAL: database migrations failed/);
    expect(workerScript).toMatch(/require_database_url/);
  });

  it('share their checks, so the same fault reads the same way from either service', () => {
    expect(webScript).toMatch(/\. \.\/scripts\/preflight\.sh/);
    expect(workerScript).toMatch(/\. \.\/scripts\/preflight\.sh/);
  });

  it('leaves migrations to the web service alone, so two services cannot race', () => {
    expect(webScript).toMatch(/pnpm db:migrate/);
    expect(workerScript).not.toMatch(/pnpm db:migrate/);
  });

  it('seeds after migrating, because a migrated schema is not a usable application', () => {
    // Without this the deployment comes up with no approved templates, no
    // pricing rules and no date rules: every screen renders, nothing can be
    // generated, and the Templates page reports all eight document types as
    // awaiting a template that is sitting in the image the whole time.
    expect(webScript).toMatch(/pnpm db:seed/);
    expect(webScript.indexOf('pnpm db:migrate')).toBeLessThan(webScript.indexOf('pnpm db:seed'));

    // One writer, same reason migrations have one.
    expect(workerScript).not.toMatch(/pnpm db:seed/);
  });

  it('seeds with a command that works in an image with no .env', () => {
    // `.dockerignore` excludes `.env` deliberately — a developer's copy would
    // otherwise override the platform's variables. A seed command that
    // *required* that file would therefore fail in the one place it matters.
    const scripts = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(scripts.scripts['db:seed']).not.toMatch(/--env-file=/);
    expect(scripts.scripts['db:seed']).toMatch(/--env-file-if-exists=/);
  });

  it('check configuration before starting, so a missing key fails the deploy rather than every page', () => {
    expect(webScript).toMatch(/check_environment/);
    expect(workerScript).toMatch(/check_environment/);
    expect(read('scripts/preflight.sh')).toMatch(/scripts\/check-env\.ts/);
  });

  it('check configuration before touching the database, so the clearer error surfaces first', () => {
    expect(webScript.indexOf('check_environment')).toBeLessThan(webScript.indexOf('pnpm db:migrate'));
  });

  it('abort on an unset variable rather than starting with a blank one', () => {
    expect(webScript).toMatch(/^set -eu$/m);
    expect(workerScript).toMatch(/^set -eu$/m);
  });
});

describe('telling an empty variable from a missing one', () => {
  const preflight = read('scripts/preflight.sh');

  it('distinguishes the two, because the fix is different', () => {
    // A reference that did not resolve leaves the variable present and empty.
    // Reporting that as "not set" sends someone to add a variable they can see
    // is already there.
    expect(preflight).toMatch(/DATABASE_URL is set but empty/);
    expect(preflight).toMatch(/DATABASE_URL is not set/);
    expect(preflight).toMatch(/\$\{DATABASE_URL\+isset\}/);
  });

  it('names what actually breaks a Railway reference', () => {
    expect(preflight).toMatch(/same project and environment/);
    expect(preflight).toMatch(/named exactly what the reference says/);
  });
});
