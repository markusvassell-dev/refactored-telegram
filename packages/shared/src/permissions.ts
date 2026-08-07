import type { Role } from './domain.js';
import { PermissionError } from './errors.js';

/**
 * Role-based access control and separation of duties.
 *
 * Permissions are additive across a user's roles. Separation-of-duties rules
 * are enforced separately in `assertSeparationOfDuties` — a user can hold the
 * permission to approve a wording exception and still be barred from approving
 * their own.
 */

export const PERMISSIONS = [
  // Viewing
  'engagement:view',
  'document:view',
  'audit:view',

  // Preparation
  'engagement:create',
  'generation:start',
  'field:edit_structured',
  'source_document:select',
  'pricing:prepare',
  'review:submit',

  // Review
  'review:comment',
  'review:request_changes',
  'review:approve_ordinary',
  'cover_letter:edit',
  'exception:submit',

  // Elevated approval
  'wording:edit',
  'wording:approve',
  'fee:approve_decrease',
  'fee:approve_high_increase',
  'document:approve_final',
  'cover_letter:approve',
  'signing:send',
  'signing:record_external',

  // Administration
  'template:manage',
  'template:publish',
  'pricing_rule:manage',
  'date_rule:manage',
  'policy:manage',
  'user:manage',
  'integration:manage',
  'job:retry',
  'system:manage_test_mode',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = ['engagement:view', 'document:view'];

const PREPARER: Permission[] = [
  ...READ_ONLY,
  'engagement:create',
  'generation:start',
  'field:edit_structured',
  'source_document:select',
  'pricing:prepare',
  'review:submit',
  'review:comment',
  'exception:submit',
];

const REVIEWER: Permission[] = [
  ...PREPARER,
  'review:request_changes',
  'review:approve_ordinary',
  'cover_letter:edit',
  'audit:view',
];

const PARTNER_OR_FINAL_APPROVER: Permission[] = [
  ...REVIEWER,
  'wording:edit',
  'wording:approve',
  'fee:approve_decrease',
  'fee:approve_high_increase',
  'document:approve_final',
  'cover_letter:approve',
  'signing:send',
  // Asserting that a client signed is as consequential as authorising the
  // send: it is the step that makes the fee binding, and here there is no
  // vendor's audit trail behind it, only the assertion and the file. It sits
  // with the same people who may authorise a send, and with nobody else.
  'signing:record_external',
];

const ADMINISTRATOR: Permission[] = [
  ...REVIEWER,
  'wording:edit',
  'template:manage',
  'template:publish',
  'pricing_rule:manage',
  'date_rule:manage',
  'policy:manage',
  'user:manage',
  'integration:manage',
  'job:retry',
  'system:manage_test_mode',
  'audit:view',
];

/**
 * Note: ADMINISTRATOR deliberately does *not* receive `document:approve_final`,
 * `cover_letter:approve`, `signing:send`, `signing:record_external`,
 * `wording:approve` or the fee approval permissions. Managing the system is not
 * the same as approving client-facing legal documents; a person who needs both
 * must hold both roles explicitly.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  READ_ONLY: READ_ONLY,
  PREPARER: PREPARER,
  REVIEWER: REVIEWER,
  PARTNER_OR_FINAL_APPROVER: PARTNER_OR_FINAL_APPROVER,
  ADMINISTRATOR: ADMINISTRATOR,
};

export interface Principal {
  id: string;
  email: string;
  displayName: string;
  roles: readonly Role[];
}

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return granted;
}

export function can(principal: Pick<Principal, 'roles'>, permission: Permission): boolean {
  return permissionsFor(principal.roles).has(permission);
}

export function assertCan(principal: Pick<Principal, 'roles'>, permission: Permission): void {
  if (!can(principal, permission)) {
    throw new PermissionError(`Your role does not permit this action (${permission}).`);
  }
}

export function hasRole(principal: Pick<Principal, 'roles'>, role: Role): boolean {
  return principal.roles.includes(role);
}

export function isElevatedApprover(principal: Pick<Principal, 'roles'>): boolean {
  return hasRole(principal, 'PARTNER_OR_FINAL_APPROVER');
}

export interface SeparationOfDutiesInput {
  /** The person attempting to approve. */
  approverId: string;
  /** The person who authored the thing being approved. */
  authorId: string | null | undefined;
  /** Human-readable subject, used in the error message. */
  subject: string;
}

/**
 * A user must never approve their own exceptional wording change, their own
 * fee override, or their own document.
 */
export function assertSeparationOfDuties(input: SeparationOfDutiesInput): void {
  if (input.authorId && input.authorId === input.approverId) {
    throw new PermissionError(
      `You cannot approve your own ${input.subject}. It must be approved by a different person.`,
    );
  }
}
