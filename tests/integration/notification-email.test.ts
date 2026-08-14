import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { BlockedEmailSender, MockEmailSender } from '@element/integrations';
import { MAX_EMAIL_ATTEMPTS, NotificationEmailService, NotificationService } from '@element/services';
import { createLogger } from '@element/shared';

/**
 * Getting a notice out of the application and into somebody's inbox.
 *
 * The property this suite exists to hold: **a notice that cannot be emailed is
 * still a notice**. Delivery is a courtesy laid on top of a record, and losing
 * a message must never lose the fact.
 */

const prisma = new PrismaClient();
const notifications = new NotificationService({ prisma });
const logger = createLogger({ level: 'error', base: { service: 'test' } });

const suffix = randomUUID().slice(0, 8);
const emails = {
  active: `mail-active-${suffix}@test.example`,
  departed: `mail-departed-${suffix}@test.example`,
};

let activeId: string;
let departedId: string;

function service(mailer: MockEmailSender | BlockedEmailSender, testMode = false) {
  return new NotificationEmailService({
    prisma,
    mailer,
    logger,
    appBaseUrl: 'https://engagements.example.test',
    testMode,
  });
}

beforeAll(async () => {
  await prisma.$connect();
  const active = await prisma.user.upsert({
    where: { email: emails.active },
    create: { email: emails.active, displayName: 'Active Person' },
    update: { isActive: true },
  });
  const departed = await prisma.user.upsert({
    where: { email: emails.departed },
    create: { email: emails.departed, displayName: 'Departed Person', isActive: false },
    update: { isActive: false },
  });
  activeId = active.id;
  departedId = departed.id;
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [activeId, departedId] } } });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [activeId, departedId] } } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await prisma.$disconnect();
});

async function raise(userId: string, link: string | null = '/engagements/abc') {
  await notifications.notify({
    userIds: [userId],
    eventType: 'SIGNING_SIGNED',
    title: 'Engagement letter signed: Acme Ltd.',
    body: 'The client has signed.',
    link,
  });
}

describe('sending', () => {
  it('sends what is waiting and records that it went', async () => {
    await raise(activeId);
    const mailer = new MockEmailSender();

    const result = await service(mailer).drain();

    expect(result).toMatchObject({ considered: 1, sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(emails.active);
    expect(mailer.sent[0]?.subject).toContain('Acme Ltd.');

    const [notice] = await prisma.notification.findMany({ where: { userId: activeId } });
    expect(notice?.emailedAt).not.toBeNull();
    expect(notice?.emailError).toBeNull();
  });

  it('does not send the same notice twice', async () => {
    await raise(activeId);
    const mailer = new MockEmailSender();

    await service(mailer).drain();
    const second = await service(mailer).drain();

    expect(second.considered).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it('carries an absolute link, since a relative one is useless in an inbox', async () => {
    await raise(activeId, '/engagements/abc');
    const mailer = new MockEmailSender();

    await service(mailer).drain();

    expect(mailer.sent[0]?.body).toContain('https://engagements.example.test/engagements/abc');
  });

  it('keeps the client detail out of the message beyond what the subject needs', async () => {
    // A notice travels to an inbox the application does not control. The body
    // carries the fact and a link; the engagement is where the rest stays.
    await raise(activeId);
    const mailer = new MockEmailSender();

    await service(mailer).drain();

    expect(mailer.sent[0]?.body).toContain('The client has signed.');
    expect(mailer.sent[0]?.body).toMatch(/do not reply/i);
  });

  it('marks the subject in Test Mode, so a test notice is never mistaken for real', async () => {
    await raise(activeId);
    const mailer = new MockEmailSender();

    await service(mailer, true).drain();

    expect(mailer.sent[0]?.subject).toMatch(/^\[TEST MODE\]/);
  });

  it('drains oldest first, so a backlog does not strand the earliest news', async () => {
    await notifications.notify({ userIds: [activeId], eventType: 'A', title: 'First', body: 'x' });
    await notifications.notify({ userIds: [activeId], eventType: 'B', title: 'Second', body: 'y' });

    // Backdated explicitly, because two rows created back to back can share a
    // millisecond on a fast machine. `drain` orders by createdAt and breaks ties
    // on a random uuid, so with equal timestamps this asserted insertion luck
    // rather than ordering — it passed for months locally and failed on the
    // first CI run, which is the whole distinction the test claims to test.
    //
    // Equally-old notices may drain in any order; that is not a defect. What
    // must hold is that an *older* one is never stranded behind a newer one.
    await prisma.notification.updateMany({
      where: { userId: activeId, title: 'First' },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const mailer = new MockEmailSender();
    await service(mailer).drain();

    expect(mailer.sent.map((sent) => sent.subject)).toEqual(['First', 'Second']);
  });
});

describe('when the mail will not go', () => {
  it('keeps the notice, because the recipient will still see it in the application', async () => {
    // The property this whole suite is for. A mail server being unreachable is
    // not a reason to lose the fact that a client signed.
    await raise(activeId);

    const result = await service(new BlockedEmailSender('Microsoft refused.')).drain();

    expect(result).toMatchObject({ sent: 0, failed: 1 });

    const [notice] = await prisma.notification.findMany({ where: { userId: activeId } });
    expect(notice).toBeDefined();
    expect(notice?.emailedAt).toBeNull();
    expect(notice?.readAt).toBeNull();
    // Unread and undelivered: still waiting to be seen, in the app.
  });

  it('records what the vendor actually said, rather than throwing it away', async () => {
    await raise(activeId);
    await service(new BlockedEmailSender('HTTP 403: insufficient privileges')).drain();

    const [notice] = await prisma.notification.findMany({ where: { userId: activeId } });
    expect(notice?.emailError).toContain('403');
  });

  it('gives up after a bounded number of attempts', async () => {
    // A wrong address or a revoked permission is not transient. Retrying for
    // ever turns one misconfiguration into unbounded traffic against the
    // tenant.
    await raise(activeId);
    const mailer = new BlockedEmailSender('nope');

    for (let attempt = 0; attempt < MAX_EMAIL_ATTEMPTS + 2; attempt += 1) {
      await service(mailer).drain();
    }

    const [notice] = await prisma.notification.findMany({ where: { userId: activeId } });
    expect(notice?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);

    const afterwards = await service(mailer).drain();
    expect(afterwards.considered).toBe(0);
  });

  it('retries a transient failure until it succeeds', async () => {
    await raise(activeId);

    await service(new BlockedEmailSender('temporarily unavailable')).drain();

    const mailer = new MockEmailSender();
    const recovered = await service(mailer).drain();

    expect(recovered.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('who is written to', () => {
  it('does not e-mail somebody who has left, but keeps their notice', async () => {
    // A deactivated account can no longer sign in. Continuing to write to the
    // address is the application trusting for mail what it has stopped
    // trusting for access.
    await raise(departedId);
    const mailer = new MockEmailSender();

    const result = await service(mailer).drain();

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(mailer.sent).toHaveLength(0);

    const [notice] = await prisma.notification.findMany({ where: { userId: departedId } });
    expect(notice).toBeDefined();
    expect(notice?.emailError).toMatch(/not an active user/i);
  });
});
