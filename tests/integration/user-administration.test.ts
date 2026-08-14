import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { UserAdminService } from '@element/services';
import type { Principal, Role } from '@element/shared';

/**
 * Granting and removing roles.
 *
 * A role decides who may approve a client-facing legal document, so what this
 * refuses matters more than what it allows. Two of the refusals exist because
 * the alternative is unrecoverable from inside the application: an
 * administrator who removes their own role, and the removal of the last one.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const users = new UserAdminService({ prisma, audit });

const suffix = randomUUID().slice(0, 8);
const emails = {
  admin: `admin-a-${suffix}@admin.test`,
  otherAdmin: `admin-b-${suffix}@admin.test`,
  subject: `subject-${suffix}@admin.test`,
  reader: `reader-${suffix}@admin.test`,
};

let admin: Principal;
let otherAdmin: Principal;
let subjectId: string;
let reader: Principal;

async function makeUser(email: string, roles: Role[]): Promise<{ id: string; principal: Principal }> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email },
    update: { isActive: true },
  });

  await prisma.userRole.deleteMany({ where: { userId: user.id } });
  for (const role of roles) {
    await prisma.userRole.create({ data: { userId: user.id, role, grantedBy: 'test-fixture' } });
  }

  return {
    id: user.id,
    principal: { id: user.id, displayName: user.displayName, email: user.email, roles },
  };
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  const a = await makeUser(emails.admin, ['ADMINISTRATOR']);
  const b = await makeUser(emails.otherAdmin, ['ADMINISTRATOR']);
  const s = await makeUser(emails.subject, ['PREPARER']);
  const r = await makeUser(emails.reader, ['READ_ONLY']);

  admin = a.principal;
  otherAdmin = b.principal;
  subjectId = s.id;
  reader = r.principal;
});

afterAll(async () => {
  const ids = await prisma.user.findMany({
    where: { email: { in: Object.values(emails) } },
    select: { id: true },
  });
  const userIds = ids.map((row) => row.id);

  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/**
 * Runs a scenario in which `admin` is the only active administrator.
 *
 * "The last administrator" is a property of the whole database, so testing it
 * means deactivating every other one — including the seeded accounts the
 * browser tests sign in with. Every account this touches is restored
 * afterwards, whatever the scenario does: leaving `Sample Administrator`
 * deactivated breaks the sign-in of a suite that runs much later, with an error
 * that points nowhere near here.
 */
async function asTheOnlyAdministrator(keepActiveId: string, scenario: () => Promise<void>): Promise<void> {
  const others = await prisma.user.findMany({
    where: {
      id: { not: keepActiveId },
      isActive: true,
      userRoles: { some: { role: 'ADMINISTRATOR' } },
    },
    select: { id: true },
  });

  const ids = others.map((row) => row.id);
  await prisma.user.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });

  try {
    await scenario();
  } finally {
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { isActive: true } });
  }
}

const REASON = 'Promoted to reviewer after training.';

describe('granting a role', () => {
  it('grants it, and records who did it and why', async () => {
    await users.grantRole({ userId: subjectId, role: 'REVIEWER', reason: REASON, actor: admin });

    const held = await prisma.userRole.findMany({ where: { userId: subjectId } });
    expect(held.map((row) => row.role).sort()).toEqual(['PREPARER', 'REVIEWER']);
    expect(held.find((row) => row.role === 'REVIEWER')?.grantedBy).toBe(admin.id);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'User', objectId: subjectId, eventType: 'ROLE_GRANTED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.userId).toBe(admin.id);
    expect(event.reason).toBe(REASON);
    expect(event.afterValue).toMatchObject({ role: 'REVIEWER' });
  });

  it('refuses a role the person already holds, rather than writing a duplicate record', async () => {
    await expect(
      users.grantRole({ userId: subjectId, role: 'PREPARER', reason: REASON, actor: admin }),
    ).rejects.toThrow(/already holds/i);
  });

  it('refuses a change with no real reason, because the reason is the record', async () => {
    for (const reason of ['', '   ', 'ok']) {
      await expect(
        users.grantRole({ userId: subjectId, role: 'REVIEWER', reason, actor: admin }),
      ).rejects.toThrow(/Give a reason/i);
    }
  });

  it('refuses somebody who cannot manage users', async () => {
    await expect(
      users.grantRole({ userId: subjectId, role: 'ADMINISTRATOR', reason: REASON, actor: reader }),
    ).rejects.toThrow();
  });
});

describe('removing a role', () => {
  it('removes it and records what was taken away', async () => {
    await users.revokeRole({ userId: subjectId, role: 'PREPARER', reason: REASON, actor: admin });

    expect(await prisma.userRole.count({ where: { userId: subjectId } })).toBe(0);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'User', objectId: subjectId, eventType: 'ROLE_REVOKED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.beforeValue).toMatchObject({ role: 'PREPARER' });
  });

  it('refuses a role the person does not hold', async () => {
    await expect(
      users.revokeRole({ userId: subjectId, role: 'ADMINISTRATOR', reason: REASON, actor: admin }),
    ).rejects.toThrow(/does not hold/i);
  });

  it('refuses to remove your own administrator role, which would lock you out of undoing it', async () => {
    await expect(
      users.revokeRole({ userId: admin.id, role: 'ADMINISTRATOR', reason: REASON, actor: admin }),
    ).rejects.toThrow(/cannot remove your own administrator role/i);

    expect(
      await prisma.userRole.count({ where: { userId: admin.id, role: 'ADMINISTRATOR' } }),
    ).toBe(1);
  });

  it('refuses to remove the last active administrator', async () => {
    await asTheOnlyAdministrator(admin.id, async () => {
      await expect(
        users.revokeRole({ userId: admin.id, role: 'ADMINISTRATOR', reason: REASON, actor: otherAdmin }),
      ).rejects.toThrow(/last active administrator/i);
    });
  });

  it('revokes a legacy directory-granted role, since nothing reapplies it now', async () => {
    // This was once refused, on the grounds that the sign-in mapping would put
    // the role straight back and a revocation that undid itself would be a lie.
    // The mapping is gone, so the refusal would now strand the role instead:
    // unrevokable, with nothing on the other side maintaining it.
    await prisma.userRole.updateMany({
      where: { userId: subjectId, role: 'PREPARER' },
      data: { grantedBy: 'entra-id' },
    });

    await users.revokeRole({ userId: subjectId, role: 'PREPARER', reason: REASON, actor: admin });

    expect(await prisma.userRole.count({ where: { userId: subjectId, role: 'PREPARER' } })).toBe(0);
  });
});

describe('deactivating an account', () => {
  it('deactivates it and records the change', async () => {
    await users.setActive({ userId: subjectId, isActive: false, reason: REASON, actor: admin });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: subjectId } })).isActive).toBe(false);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'User', objectId: subjectId, eventType: 'USER_ACCESS_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.beforeValue).toMatchObject({ isActive: true });
    expect(event.afterValue).toMatchObject({ isActive: false });
  });

  it('refuses to deactivate your own account', async () => {
    await expect(
      users.setActive({ userId: admin.id, isActive: false, reason: REASON, actor: admin }),
    ).rejects.toThrow(/your own account/i);
  });

  it('refuses to deactivate the last active administrator', async () => {
    await asTheOnlyAdministrator(admin.id, async () => {
      await expect(
        users.setActive({ userId: admin.id, isActive: false, reason: REASON, actor: otherAdmin }),
      ).rejects.toThrow(/last active administrator/i);
    });
  });

  it('refuses a change that changes nothing', async () => {
    await expect(
      users.setActive({ userId: subjectId, isActive: true, reason: REASON, actor: admin }),
    ).rejects.toThrow(/already active/i);
  });

  it('reactivates, so a deactivation is not one-way', async () => {
    await users.setActive({ userId: subjectId, isActive: false, reason: REASON, actor: admin });
    await users.setActive({ userId: subjectId, isActive: true, reason: 'Returned from leave.', actor: admin });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: subjectId } })).isActive).toBe(true);
  });
});

describe('what the screen is shown', () => {
  it('reports each role with who granted it, so a directory role can be told apart', async () => {
    await prisma.userRole.updateMany({
      where: { userId: subjectId, role: 'PREPARER' },
      data: { grantedBy: 'entra-id' },
    });

    const listed = await users.list();
    const subject = listed.find((user) => user.id === subjectId);

    expect(subject?.roles).toEqual([
      expect.objectContaining({ role: 'PREPARER', grantedBy: 'entra-id' }),
    ]);
  });
});
