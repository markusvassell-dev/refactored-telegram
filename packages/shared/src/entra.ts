/**
 * Whether Entra ID configuration is even the right shape.
 *
 * A placeholder is a perfectly good non-empty string, so a check for "is it
 * set" says yes to `PASTE_YOUR_TENANT_ID`. The application then presents a
 * working-looking sign-in button, sends the person to Microsoft, and Microsoft
 * answers with `AADSTS900023: Specified tenant identifier … is neither a valid
 * DNS name, nor a valid external domain` — a round trip through a vendor to
 * learn something this application could have said itself.
 *
 * These are shape checks, not proof the values are real. A well-formed GUID
 * that belongs to nobody still fails at Microsoft, and it should: only Microsoft
 * can answer that. The point is to catch the mistakes that are obvious from
 * here.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Multi-tenant authorities Microsoft accepts in place of a tenant id. */
const WELL_KNOWN_TENANTS = new Set(['common', 'organizations', 'consumers']);

/**
 * A tenant identifier is a GUID, a verified domain, or a well-known authority.
 * `contoso.onmicrosoft.com` is as valid as the directory's GUID.
 */
export function isLikelyEntraTenantId(value: string | undefined | null): boolean {
  const trimmed = value?.trim().toLowerCase() ?? '';
  if (trimmed.length === 0) return false;
  if (WELL_KNOWN_TENANTS.has(trimmed)) return true;
  if (GUID.test(trimmed)) return true;

  // A domain: at least one dot, no spaces, and nothing that looks like a
  // placeholder someone forgot to replace.
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(trimmed);
}

/** A client (application) id is always a GUID. */
export function isLikelyEntraClientId(value: string | undefined | null): boolean {
  return GUID.test(value?.trim() ?? '');
}

/**
 * Names what is wrong with the configuration, or returns null when its shape is
 * plausible. The wording is what an operator sees, so it says what to do.
 */
export function describeEntraConfigurationProblem(input: {
  tenantId?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
}): string | null {
  if (!input.tenantId?.trim() || !input.clientId?.trim() || !input.clientSecret?.trim()) {
    return 'ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET must all be set.';
  }

  if (!isLikelyEntraTenantId(input.tenantId)) {
    return `ENTRA_TENANT_ID is "${input.tenantId.trim()}", which is not a directory id. It should be the Directory (tenant) ID from the app registration overview — a GUID — or a verified domain such as contoso.onmicrosoft.com.`;
  }

  if (!isLikelyEntraClientId(input.clientId)) {
    return `ENTRA_CLIENT_ID is "${input.clientId.trim()}", which is not an application id. It should be the Application (client) ID from the app registration overview — a GUID.`;
  }

  return null;
}
