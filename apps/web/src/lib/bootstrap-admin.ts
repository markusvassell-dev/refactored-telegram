import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';

/**
 * The first administrator.
 *
 * Directory role mapping starts empty, so on a first deployment the first
 * person to sign in gets a user record and no roles — and granting a role
 * requires an administrator who does not exist yet. Without a way out of that,
 * a correctly deployed application is unusable.
 *
 * This is the only path to a role that does not go through an existing
 * administrator, so it is deliberately narrow:
 *
 *   - it grants nothing on its own; the caller must have completed a real
 *     Entra ID sign-in first, so the address is one the directory vouched for;
 *   - it matches the configured list exactly, case-folded, and nothing else;
 *   - it grants ADMINISTRATOR and no other role;
 *   - the grant is recorded in the audit trail, which cannot be rewritten.
 *
 * Re-granting on every subsequent sign-in is a no-op, and only the first one is
 * audited — otherwise the entry that matters would be buried under a login's
 * worth of duplicates.
 */

export interface BootstrapAdminInput {
  prisma: PrismaClient;
  audit: AuditLogger;
  /** The address Entra ID authenticated, not one supplied by the caller. */
  authenticatedEmail: string;
  userId: string;
  /** `BOOTSTRAP_ADMIN_EMAILS`, already normalised by the environment schema. */
  configuredEmails: readonly string[];
}

export interface BootstrapAdminResult {
  /** True only for the sign-in that actually created the grant. */
  granted: boolean;
  /** True whenever the address is listed, whether or not it changed anything. */
  listed: boolean;
}

export async function grantBootstrapAdministrator(input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
  const email = input.authenticatedEmail.trim().toLowerCase();
  if (email.length === 0 || !input.configuredEmails.includes(email)) {
    return { granted: false, listed: false };
  }

  const existing = await input.prisma.userRole.findUnique({
    where: { userId_role: { userId: input.userId, role: 'ADMINISTRATOR' } },
    select: { id: true },
  });

  if (existing) return { granted: false, listed: true };

  await input.prisma.userRole.create({
    data: { userId: input.userId, role: 'ADMINISTRATOR', grantedBy: 'bootstrap' },
  });

  await input.audit.record({
    eventType: 'ROLE_GRANTED',
    objectType: 'User',
    objectId: input.userId,
    userId: input.userId,
    afterValue: { role: 'ADMINISTRATOR', grantedBy: 'bootstrap' },
    reason: 'BOOTSTRAP_ADMIN_EMAILS lists this address.',
  });

  return { granted: true, listed: true };
}
