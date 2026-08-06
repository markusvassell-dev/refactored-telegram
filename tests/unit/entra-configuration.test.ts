import { describe, expect, it } from 'vitest';
import {
  describeEntraConfigurationProblem,
  isLikelyEntraClientId,
  isLikelyEntraTenantId,
  loadEnv,
} from '@element/shared';

/**
 * The shape of Entra ID configuration.
 *
 * These checks exist because "is it set" answers yes to `PASTE_YOUR_TENANT_ID`.
 * A deployment carrying that value builds a valid-looking authorization URL,
 * redirects to Microsoft, and gets `AADSTS900023` back — a round trip through a
 * vendor to learn something this application could have said itself.
 *
 * They are shape checks and nothing more. A well-formed GUID belonging to
 * nobody still fails at Microsoft, and it should: only Microsoft can answer
 * that.
 */

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const CLIENT = '4e4b1a2c-9f3d-4f2a-8c1b-0d5e6f7a8b9c';
const SECRET = 'a-client-secret-value';

describe('what counts as a tenant identifier', () => {
  it('accepts a directory GUID, in either case', () => {
    expect(isLikelyEntraTenantId(TENANT)).toBe(true);
    expect(isLikelyEntraTenantId(TENANT.toUpperCase())).toBe(true);
  });

  it('accepts a verified domain, which Microsoft treats as equivalent', () => {
    expect(isLikelyEntraTenantId('contoso.onmicrosoft.com')).toBe(true);
    expect(isLikelyEntraTenantId('elementcpa.ca')).toBe(true);
  });

  it('accepts the multi-tenant authorities', () => {
    for (const authority of ['common', 'organizations', 'consumers']) {
      expect(isLikelyEntraTenantId(authority), authority).toBe(true);
    }
  });

  it('rejects the placeholder that shipped in the variables file', () => {
    // The whole reason this module exists.
    expect(isLikelyEntraTenantId('PASTE_YOUR_TENANT_ID')).toBe(false);
    expect(isLikelyEntraTenantId('paste_your_tenant_id')).toBe(false);
    expect(isLikelyEntraTenantId('<your-tenant-id>')).toBe(false);
  });

  it('rejects nothing at all, including whitespace someone pasted by mistake', () => {
    expect(isLikelyEntraTenantId(undefined)).toBe(false);
    expect(isLikelyEntraTenantId(null)).toBe(false);
    expect(isLikelyEntraTenantId('')).toBe(false);
    expect(isLikelyEntraTenantId('   ')).toBe(false);
  });

  it('rejects a bare word, which is neither a GUID nor a domain', () => {
    expect(isLikelyEntraTenantId('tenant')).toBe(false);
    expect(isLikelyEntraTenantId('my tenant.com')).toBe(false);
    expect(isLikelyEntraTenantId('.com')).toBe(false);
  });

  it('rejects a truncated GUID, which is the likeliest paste error', () => {
    expect(isLikelyEntraTenantId(TENANT.slice(0, -1))).toBe(false);
    expect(isLikelyEntraTenantId(`${TENANT}0`)).toBe(false);
  });

  it('tolerates surrounding whitespace, because a copied value often carries it', () => {
    expect(isLikelyEntraTenantId(`  ${TENANT}  `)).toBe(true);
  });
});

describe('what counts as an application identifier', () => {
  it('is a GUID and only a GUID — a domain is not a client id', () => {
    expect(isLikelyEntraClientId(CLIENT)).toBe(true);
    expect(isLikelyEntraClientId('contoso.onmicrosoft.com')).toBe(false);
    expect(isLikelyEntraClientId('common')).toBe(false);
  });

  it('rejects the placeholder', () => {
    expect(isLikelyEntraClientId('PASTE_YOUR_CLIENT_ID')).toBe(false);
  });
});

describe('naming the problem', () => {
  it('says nothing when the configuration is plausible', () => {
    expect(
      describeEntraConfigurationProblem({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET }),
    ).toBeNull();
  });

  it('reports the missing values together, since all three are needed', () => {
    const problem = describeEntraConfigurationProblem({ tenantId: TENANT, clientId: CLIENT, clientSecret: '' });
    expect(problem).toMatch(/ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET must all be set/);
  });

  it('names the offending value and where to find the real one', () => {
    const problem = describeEntraConfigurationProblem({
      tenantId: 'PASTE_YOUR_TENANT_ID',
      clientId: CLIENT,
      clientSecret: SECRET,
    });

    expect(problem).toContain('PASTE_YOUR_TENANT_ID');
    expect(problem).toMatch(/Directory \(tenant\) ID/);
  });

  it('distinguishes a bad client id from a bad tenant id', () => {
    const problem = describeEntraConfigurationProblem({
      tenantId: TENANT,
      clientId: 'PASTE_YOUR_CLIENT_ID',
      clientSecret: SECRET,
    });

    expect(problem).toContain('ENTRA_CLIENT_ID');
    expect(problem).toMatch(/Application \(client\) ID/);
  });

  it('never puts the secret in the message, because that message reaches a log', () => {
    const problem = describeEntraConfigurationProblem({
      tenantId: 'nonsense',
      clientId: CLIENT,
      clientSecret: 'super-secret-value',
    });

    expect(problem).not.toContain('super-secret-value');
  });
});

describe('what a production deployment refuses to boot with', () => {
  const MINIMUM = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@host:5432/db',
    ENCRYPTION_KEY: '0'.repeat(64),
    SESSION_SECRET: '0'.repeat(64),
    APP_ENV: 'production',
  } satisfies NodeJS.ProcessEnv;

  it('refuses a placeholder as firmly as a missing value', () => {
    // Previously this booted green, served a sign-in button, and failed at
    // Microsoft. A failed deploy naming the variable is the better outcome.
    expect(() =>
      loadEnv({
        ...MINIMUM,
        ENTRA_TENANT_ID: 'PASTE_YOUR_TENANT_ID',
        ENTRA_CLIENT_ID: 'PASTE_YOUR_CLIENT_ID',
        ENTRA_CLIENT_SECRET: 'PASTE_YOUR_CLIENT_SECRET',
      }),
    ).toThrow(/not a directory id/i);
  });

  it('starts with real-shaped values', () => {
    const parsed = loadEnv({
      ...MINIMUM,
      ENTRA_TENANT_ID: TENANT,
      ENTRA_CLIENT_ID: CLIENT,
      ENTRA_CLIENT_SECRET: SECRET,
    });

    expect(parsed.ENTRA_TENANT_ID).toBe(TENANT);
  });

  it('leaves development alone, where Entra is not the way in', () => {
    expect(() => loadEnv({ ...MINIMUM, APP_ENV: 'development' })).not.toThrow();
  });
});
