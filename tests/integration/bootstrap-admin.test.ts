import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { grantBootstrapAdministrator } from '../../apps/web/src/lib/bootstrap-admin';

/**
 * The first administrator.
 *
 * This is the only way a role is granted without an existing administrator, so
 * what it refuses matters more than what it does. It must grant exactly one
 * role, to exactly the configured addresses, and leave a record.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);

const userIds: string[] = [];

async function newUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email, displayName: `Bootstrap ${email}` },
  });
  userIds.push(user.id);
  return user.id;
}

function unique(local: string): string {
  return `${local}-${randomUUID().slice(0, 8)}@bootstrap.test`;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('who it grants to', () => {
  it('grants ADMINISTRATOR to a listed address, and records it', async () => {
    const email = unique('listed');
    const userId = await newUser(email);

    const result = await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: email,
      userId,
      configuredEmails: [email],
    });

    expect(result).toEqual({ granted: true, listed: true });

    const roles = await prisma.userRole.findMany({ where: { userId } });
    expect(roles).toHaveLength(1);
    expect(roles[0]?.role).toBe('ADMINISTRATOR');
    expect(roles[0]?.grantedBy).toBe('bootstrap');

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'User', objectId: userId, eventType: 'ROLE_GRANTED' },
    });
    expect(event.afterValue).toMatchObject({ role: 'ADMINISTRATOR', grantedBy: 'bootstrap' });
    expect(event.reason).toMatch(/BOOTSTRAP_ADMIN_EMAILS/);
  });

  it('matches case-insensitively, because a directory address is not case-sensitive', async () => {
    const email = unique('mixedcase');
    const userId = await newUser(email);

    const result = await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: email.toUpperCase(),
      userId,
      configuredEmails: [email.toLowerCase()],
    });

    expect(result.granted).toBe(true);
  });

  it('ignores the spaces a person leaves around a pasted address', async () => {
    const email = unique('padded');
    const userId = await newUser(email);

    const result = await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: `  ${email}  `,
      userId,
      configuredEmails: [email],
    });

    expect(result.granted).toBe(true);
  });
});

describe('who it refuses', () => {
  it('grants nothing when the list is empty, which is the default', async () => {
    const email = unique('unlisted');
    const userId = await newUser(email);

    const result = await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: email,
      userId,
      configuredEmails: [],
    });

    expect(result).toEqual({ granted: false, listed: false });
    expect(await prisma.userRole.count({ where: { userId } })).toBe(0);
  });

  it('grants nothing to an address that is not on the list', async () => {
    const userId = await newUser(unique('someone'));

    const result = await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: unique('someone'),
      userId,
      configuredEmails: [unique('partner')],
    });

    expect(result.granted).toBe(false);
    expect(await prisma.userRole.count({ where: { userId } })).toBe(0);
  });

  it('refuses a near miss rather than matching loosely', async () => {
    const userId = await newUser(unique('near'));

    for (const attempt of ['partner@firm.ca.evil.test', 'xpartner@firm.ca', 'partner@firm.c']) {
      const result = await grantBootstrapAdministrator({
        prisma,
        audit,
        authenticatedEmail: attempt,
        userId,
        configuredEmails: ['partner@firm.ca'],
      });
      expect(result.granted).toBe(false);
    }

    expect(await prisma.userRole.count({ where: { userId } })).toBe(0);
  });

  it('grants nothing for an empty address, however the list is configured', async () => {
    const userId = await newUser(unique('empty'));

    const result = await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: '   ',
      userId,
      configuredEmails: [''],
    });

    expect(result.granted).toBe(false);
    expect(await prisma.userRole.count({ where: { userId } })).toBe(0);
  });
});

describe('signing in again', () => {
  it('is a no-op, and does not bury the original grant under duplicates', async () => {
    const email = unique('repeat');
    const userId = await newUser(email);
    const input = { prisma, audit, authenticatedEmail: email, userId, configuredEmails: [email] };

    expect((await grantBootstrapAdministrator(input)).granted).toBe(true);
    expect((await grantBootstrapAdministrator(input)).granted).toBe(false);
    expect((await grantBootstrapAdministrator(input)).granted).toBe(false);

    expect(await prisma.userRole.count({ where: { userId } })).toBe(1);
    expect(
      await prisma.auditEvent.count({ where: { objectId: userId, eventType: 'ROLE_GRANTED' } }),
    ).toBe(1);
  });

  it('leaves a role an administrator granted by hand exactly as it was', async () => {
    const email = unique('already');
    const userId = await newUser(email);

    await prisma.userRole.create({
      data: { userId, role: 'ADMINISTRATOR', grantedBy: 'some-administrator' },
    });

    const result = await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: email,
      userId,
      configuredEmails: [email],
    });

    expect(result).toEqual({ granted: false, listed: true });

    const role = await prisma.userRole.findFirstOrThrow({ where: { userId } });
    expect(role.grantedBy).toBe('some-administrator');
  });
});

describe('what it never does', () => {
  it('grants ADMINISTRATOR and nothing else', async () => {
    const email = unique('onlyadmin');
    const userId = await newUser(email);

    await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: email,
      userId,
      configuredEmails: [email],
    });

    const roles = await prisma.userRole.findMany({ where: { userId } });
    expect(roles.map((role) => role.role)).toEqual(['ADMINISTRATOR']);
  });

  it('grants only to the user it was given, not to everyone on the list', async () => {
    const listed = unique('listed-other');
    const otherUserId = await newUser(listed);
    const signingIn = unique('signing-in');
    const signingInUserId = await newUser(signingIn);

    await grantBootstrapAdministrator({
      prisma,
      audit,
      authenticatedEmail: signingIn,
      userId: signingInUserId,
      configuredEmails: [listed, signingIn],
    });

    expect(await prisma.userRole.count({ where: { userId: signingInUserId } })).toBe(1);
    expect(await prisma.userRole.count({ where: { userId: otherUserId } })).toBe(0);
  });
});
