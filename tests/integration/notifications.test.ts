import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { NotificationService, UNREAD_BADGE_CEILING } from '@element/services';

/**
 * Telling somebody that something happened.
 *
 * The application changed state in silence: a client signed, the engagement
 * advanced, documents were filed, the audit trail recorded all of it, and no
 * human was told. These tests are mostly about the two ways that gets worse —
 * being told twice, and being able to read somebody else's mail.
 */

const prisma = new PrismaClient();
const notifications = new NotificationService({ prisma });

const suffix = randomUUID().slice(0, 8);
const emails = {
  preparer: `notify-preparer-${suffix}@test.example`,
  reviewer: `notify-reviewer-${suffix}@test.example`,
  stranger: `notify-stranger-${suffix}@test.example`,
};

let preparerId: string;
let reviewerId: string;
let strangerId: string;

beforeAll(async () => {
  await prisma.$connect();

  const made = await Promise.all(
    Object.values(emails).map((email) =>
      prisma.user.upsert({ where: { email }, create: { email, displayName: email }, update: {} }),
    ),
  );
  preparerId = made[0]!.id;
  reviewerId = made[1]!.id;
  strangerId = made[2]!.id;
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [preparerId, reviewerId, strangerId] } } });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [preparerId, reviewerId, strangerId] } } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await prisma.$disconnect();
});

describe('telling people', () => {
  it('writes one notice per person', async () => {
    const result = await notifications.notify({
      userIds: [preparerId, reviewerId],
      eventType: 'SIGNING_SIGNED',
      title: 'Engagement letter signed: Acme Ltd.',
      body: 'The client has signed.',
    });

    expect(result.created).toBe(2);
    expect(await notifications.unreadCount(preparerId)).toBe(1);
    expect(await notifications.unreadCount(reviewerId)).toBe(1);
    expect(await notifications.unreadCount(strangerId)).toBe(0);
  });

  it('tells a person once when they hold two roles on the same engagement', async () => {
    // A preparer who is also the reviewer is one person, not two, and being
    // told twice about one signature is how a list stops being read.
    const result = await notifications.notify({
      userIds: [preparerId, preparerId, null, undefined],
      eventType: 'SIGNING_SIGNED',
      title: 'Signed',
      body: 'The client has signed.',
    });

    expect(result.created).toBe(1);
  });

  it('is a no-op when nobody is assigned, rather than an error', async () => {
    // An engagement with no preparer or reviewer set is unusual but legal, and
    // it must not make a signature fail.
    const result = await notifications.notify({
      userIds: [null, undefined],
      eventType: 'SIGNING_SIGNED',
      title: 'Signed',
      body: 'The client has signed.',
    });

    expect(result.created).toBe(0);
  });

  it('refuses an empty notice, which would be a row nobody can act on', async () => {
    await expect(
      notifications.notify({ userIds: [preparerId], eventType: 'X', title: '  ', body: 'something' }),
    ).rejects.toThrow(/title and a body/i);
  });
});

describe('not saying the same thing twice', () => {
  const engagementEvent = { eventType: 'SIGNING_SIGNED', title: 'Signed', body: 'The client has signed.' };

  it('leaves an unread notice alone rather than adding a second', async () => {
    // The reconciliation poll re-reads every outstanding agreement on a
    // schedule. Without this, an unsigned-then-signed letter would accumulate a
    // notice per poll until somebody read one.
    await notifications.notify({ ...engagementEvent, userIds: [preparerId], deduplicate: true });
    const second = await notifications.notify({ ...engagementEvent, userIds: [preparerId], deduplicate: true });

    expect(second.created).toBe(0);
    expect(await notifications.unreadCount(preparerId)).toBe(1);
  });

  it('tells them again once the first was read, because it is news again', async () => {
    await notifications.notify({ ...engagementEvent, userIds: [preparerId], deduplicate: true });
    await notifications.markAllRead(preparerId);

    const again = await notifications.notify({ ...engagementEvent, userIds: [preparerId], deduplicate: true });
    expect(again.created).toBe(1);
  });

  it('separates one engagement from another', async () => {
    // Deduplication is per engagement. Two clients signing must produce two
    // notices, however similar the wording.
    await notifications.notify({ ...engagementEvent, userIds: [preparerId], engagementId: null, deduplicate: true });
    const other = await notifications.notify({
      ...engagementEvent,
      userIds: [preparerId],
      engagementId: null,
      deduplicate: true,
    });

    expect(other.created).toBe(0);
  });

  it('does not deduplicate different kinds of news', async () => {
    await notifications.notify({ ...engagementEvent, userIds: [preparerId], deduplicate: true });
    const declined = await notifications.notify({
      userIds: [preparerId],
      eventType: 'SIGNING_DECLINED',
      title: 'Declined',
      body: 'The client declined.',
      deduplicate: true,
    });

    expect(declined.created).toBe(1);
  });
});

describe('reading', () => {
  it('shows the newest first', async () => {
    await notifications.notify({ userIds: [preparerId], eventType: 'A', title: 'First', body: 'x' });
    await notifications.notify({ userIds: [preparerId], eventType: 'B', title: 'Second', body: 'y' });

    const list = await notifications.listFor(preparerId);
    expect(list.map((row) => row.title)).toEqual(['Second', 'First']);
  });

  it('orders by a total order, so a batch written together does not shuffle', async () => {
    // Postgres `now()` is the transaction timestamp: several notices written in
    // one transaction share `createdAt` exactly, and ordering by it alone
    // leaves them in no defined sequence.
    await prisma.notification.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        userId: preparerId,
        eventType: 'BATCH',
        title: `Notice ${index}`,
        body: 'x',
      })),
    });

    const first = (await notifications.listFor(preparerId)).map((row) => row.id);
    const second = (await notifications.listFor(preparerId)).map((row) => row.id);
    expect(second).toEqual(first);
  });

  it('stops counting past the badge ceiling, since the exact number stops mattering', async () => {
    await prisma.notification.createMany({
      data: Array.from({ length: UNREAD_BADGE_CEILING + 20 }, () => ({
        userId: preparerId,
        eventType: 'BATCH',
        title: 'Notice',
        body: 'x',
      })),
    });

    expect(await notifications.unreadCount(preparerId)).toBe(UNREAD_BADGE_CEILING + 1);
  });
});

describe('whose notice it is', () => {
  it('will not let one person clear another’s', async () => {
    // A notification id is not a capability. Scoping the update to the reader
    // is what stops a guessed id clearing somebody else's list.
    await notifications.notify({ userIds: [reviewerId], eventType: 'SIGNING_SIGNED', title: 'Signed', body: 'x' });
    const [notice] = await notifications.listFor(reviewerId);

    await notifications.markRead(notice!.id, strangerId);

    expect(await notifications.unreadCount(reviewerId)).toBe(1);
  });

  it('marks it read for the person it belongs to', async () => {
    await notifications.notify({ userIds: [reviewerId], eventType: 'SIGNING_SIGNED', title: 'Signed', body: 'x' });
    const [notice] = await notifications.listFor(reviewerId);

    await notifications.markRead(notice!.id, reviewerId);

    expect(await notifications.unreadCount(reviewerId)).toBe(0);
  });

  it('clears only the reader’s own list', async () => {
    await notifications.notify({
      userIds: [preparerId, reviewerId],
      eventType: 'SIGNING_SIGNED',
      title: 'Signed',
      body: 'x',
    });

    await notifications.markAllRead(preparerId);

    expect(await notifications.unreadCount(preparerId)).toBe(0);
    expect(await notifications.unreadCount(reviewerId)).toBe(1);
  });
});

describe('one signature, one piece of news', () => {
  it('treats Adobe SIGNED and COMPLETED as the same event', async () => {
    // Adobe uses both words for a letter that has been signed. Deriving the
    // event type from the vendor's word made them different kinds of news, so
    // a reconciliation poll reporting COMPLETED after a webhook reported
    // SIGNED told everybody twice about one signature.
    const first = await notifications.notify({
      userIds: [preparerId],
      eventType: 'SIGNING_SIGNED',
      title: 'Engagement letter signed: Acme Ltd.',
      body: 'The client has signed.',
      deduplicate: true,
    });

    const second = await notifications.notify({
      userIds: [preparerId],
      eventType: 'SIGNING_SIGNED',
      title: 'Engagement letter signed: Acme Ltd.',
      body: 'The client has signed.',
      deduplicate: true,
    });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(await notifications.unreadCount(preparerId)).toBe(1);
  });
});
