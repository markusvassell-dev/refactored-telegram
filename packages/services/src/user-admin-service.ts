import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import {
  NotFoundError,
  PreconditionError,
  ValidationError,
  assertCan,
  ROLES,
  type Principal,
  type Role,
} from '@element/shared';

/**
 * Roles and access.
 *
 * A role decides who may approve a client-facing legal document, so granting
 * one is not configuration in the ordinary sense — it is the control the whole
 * approval model rests on. Every grant and revocation is written to the audit
 * trail with a reason, and the operations that would leave nobody able to
 * administer the system are refused rather than warned about.
 *
 * Two things this deliberately does not do:
 *
 *   - It does not stop one person holding both a preparer and an approver role.
 *     Separation of duties here is per-document — nobody approves *their own*
 *     draft — and it is enforced at the moment of approval, where the author is
 *     actually known. Refusing the role combination would forbid the ordinary
 *     case of a small firm where a partner both prepares and approves work, for
 *     different clients, while doing nothing about the case that matters.
 *
 *   - It does not manage roles the directory owns. A role mapped from Entra ID
 *     is reapplied at every sign-in, so revoking it here would undo itself
 *     within minutes and leave the audit trail claiming otherwise.
 */

export interface UserAdminDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
}

export interface ManagedUser {
  id: string;
  displayName: string;
  email: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  roles: { role: Role; grantedBy: string | null; grantedAt: Date }[];
}

/** Roles the directory owns; this service will not touch them. */
const DIRECTORY_GRANTED = 'entra-id';

const MINIMUM_REASON_LENGTH = 5;

export class UserAdminService {
  constructor(private readonly deps: UserAdminDeps) {}

  async list(): Promise<ManagedUser[]> {
    const users = await this.deps.prisma.user.findMany({
      include: { userRoles: { orderBy: { role: 'asc' } } },
      orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }],
    });

    return users.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      roles: user.userRoles.map((row) => ({
        role: row.role as Role,
        grantedBy: row.grantedBy,
        grantedAt: row.grantedAt,
      })),
    }));
  }

  async grantRole(input: { userId: string; role: Role; reason: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'user:manage');
    const reason = this.requireReason(input.reason);
    const user = await this.requireUser(input.userId);
    this.requireKnownRole(input.role);

    const existing = await this.deps.prisma.userRole.findUnique({
      where: { userId_role: { userId: user.id, role: input.role } },
    });
    if (existing) {
      throw new ValidationError(`${user.displayName} already holds ${input.role}.`);
    }

    await this.deps.prisma.userRole.create({
      data: { userId: user.id, role: input.role, grantedBy: input.actor.id },
    });

    await this.deps.audit.record({
      eventType: 'ROLE_GRANTED',
      objectType: 'User',
      objectId: user.id,
      userId: input.actor.id,
      afterValue: { role: input.role, subject: user.email },
      reason,
    });
  }

  async revokeRole(input: { userId: string; role: Role; reason: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'user:manage');
    const reason = this.requireReason(input.reason);
    const user = await this.requireUser(input.userId);

    const existing = await this.deps.prisma.userRole.findUnique({
      where: { userId_role: { userId: user.id, role: input.role } },
    });
    if (!existing) {
      throw new ValidationError(`${user.displayName} does not hold ${input.role}.`);
    }

    if (existing.grantedBy === DIRECTORY_GRANTED) {
      throw new PreconditionError(
        `${input.role} comes from the Entra ID directory and is reapplied at every sign-in. Change the directory role mapping in Settings, or the person's directory roles, instead.`,
      );
    }

    // Removing your own administrator role locks you out of the screen that
    // would let you put it back.
    if (user.id === input.actor.id && input.role === 'ADMINISTRATOR') {
      throw new PreconditionError(
        'You cannot remove your own administrator role. Ask another administrator to do it.',
      );
    }

    if (input.role === 'ADMINISTRATOR') {
      await this.assertNotTheLastAdministrator(user.id);
    }

    await this.deps.prisma.userRole.delete({ where: { id: existing.id } });

    await this.deps.audit.record({
      eventType: 'ROLE_REVOKED',
      objectType: 'User',
      objectId: user.id,
      userId: input.actor.id,
      beforeValue: { role: input.role, subject: user.email },
      reason,
    });
  }

  async setActive(input: { userId: string; isActive: boolean; reason: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'user:manage');
    const reason = this.requireReason(input.reason);
    const user = await this.requireUser(input.userId);

    if (user.isActive === input.isActive) {
      throw new ValidationError(`${user.displayName} is already ${input.isActive ? 'active' : 'deactivated'}.`);
    }

    if (!input.isActive) {
      if (user.id === input.actor.id) {
        throw new PreconditionError('You cannot deactivate your own account.');
      }

      const isAdministrator = await this.deps.prisma.userRole.findUnique({
        where: { userId_role: { userId: user.id, role: 'ADMINISTRATOR' } },
      });
      if (isAdministrator) await this.assertNotTheLastAdministrator(user.id);
    }

    await this.deps.prisma.user.update({
      where: { id: user.id },
      data: { isActive: input.isActive },
    });

    await this.deps.audit.record({
      eventType: 'USER_ACCESS_CHANGED',
      objectType: 'User',
      objectId: user.id,
      userId: input.actor.id,
      beforeValue: { isActive: user.isActive, subject: user.email },
      afterValue: { isActive: input.isActive },
      reason,
    });
  }

  /**
   * A deactivated administrator is no administrator, so both counts matter.
   * Left with none, the only way back is a database edit — the situation this
   * whole screen exists to avoid.
   */
  private async assertNotTheLastAdministrator(excludingUserId: string): Promise<void> {
    const remaining = await this.deps.prisma.userRole.count({
      where: {
        role: 'ADMINISTRATOR',
        userId: { not: excludingUserId },
        user: { isActive: true },
      },
    });

    if (remaining === 0) {
      throw new PreconditionError(
        'This is the last active administrator. Grant the role to somebody else first, or nobody will be able to manage the system.',
      );
    }
  }

  private requireReason(reason: string): string {
    const trimmed = reason.trim();
    if (trimmed.length < MINIMUM_REASON_LENGTH) {
      throw new ValidationError('Give a reason for the change. It is recorded against the person it affects.');
    }
    return trimmed;
  }

  private requireKnownRole(role: Role): void {
    if (!ROLES.includes(role)) {
      throw new ValidationError(`${role} is not a role this application defines.`);
    }
  }

  private async requireUser(userId: string) {
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User');
    return user;
  }
}
