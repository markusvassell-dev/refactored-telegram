import type { PrismaClient } from '@element/database';
import { ValidationError } from '@element/shared';

/**
 * Telling somebody that something happened.
 *
 * The application changed state silently. A client signed, the engagement
 * advanced, the signed PDF and its certificate were filed into Karbon, the
 * audit trail recorded all of it — and no human was told. Work nobody is told
 * about waits until somebody happens to look, which during a rollout is the
 * difference between noticing on Tuesday and noticing in March.
 *
 * Deliberately modest. This writes rows a person sees when they open the
 * application; it is not an email gateway. That distinction is worth keeping
 * because an in-app notice needs no vendor, no credential and no deliverability
 * story, so it works on the day it ships. Sending mail is a separate decision
 * with a separate failure mode, and it can read from this table when it arrives.
 */

export interface NotificationServiceDeps {
  prisma: PrismaClient;
}

export interface NotifyInput {
  /** Duplicates are removed, and the empty list is a no-op rather than an error. */
  userIds: readonly (string | null | undefined)[];
  eventType: string;
  title: string;
  body: string;
  link?: string | null;
  engagementId?: string | null;
  /**
   * When set, at most one unread notification with this event type will exist
   * per person per engagement. A reconciliation poll that re-observes the same
   * signature must not produce a second notice about it.
   */
  deduplicate?: boolean;
}

export interface NotificationView {
  id: string;
  eventType: string;
  title: string;
  body: string;
  link: string | null;
  engagementId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/** Anything above this is shown as "50+", because the exact number stops mattering. */
export const UNREAD_BADGE_CEILING = 50;

export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /**
   * Tells the named people. Returns how many notices were actually written,
   * which is not the number of people asked for when deduplication applies.
   */
  async notify(input: NotifyInput): Promise<{ created: number }> {
    const recipients = [...new Set(input.userIds.filter((id): id is string => Boolean(id)))];
    if (recipients.length === 0) return { created: 0 };

    if (!input.title.trim() || !input.body.trim()) {
      throw new ValidationError('A notification needs a title and a body.');
    }

    let already: string[] = [];
    if (input.deduplicate) {
      const existing = await this.deps.prisma.notification.findMany({
        where: {
          userId: { in: recipients },
          eventType: input.eventType,
          engagementId: input.engagementId ?? null,
          readAt: null,
        },
        select: { userId: true },
      });
      already = existing.map((row) => row.userId);
    }

    const pending = recipients.filter((id) => !already.includes(id));
    if (pending.length === 0) return { created: 0 };

    await this.deps.prisma.notification.createMany({
      data: pending.map((userId) => ({
        userId,
        eventType: input.eventType,
        title: input.title.trim(),
        body: input.body.trim(),
        link: input.link ?? null,
        engagementId: input.engagementId ?? null,
      })),
    });

    return { created: pending.length };
  }

  /** What one person has not read yet, newest first. */
  async unreadFor(userId: string, take = 20): Promise<NotificationView[]> {
    return this.deps.prisma.notification.findMany({
      where: { userId, readAt: null },
      // `createdAt` alone is not a total order — several notices are written in
      // one transaction and share it to the microsecond.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        eventType: true,
        title: true,
        body: true,
        link: true,
        engagementId: true,
        readAt: true,
        createdAt: true,
      },
    });
  }

  /** Everything, read or not, newest first. */
  async listFor(userId: string, take = 100): Promise<NotificationView[]> {
    return this.deps.prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        eventType: true,
        title: true,
        body: true,
        link: true,
        engagementId: true,
        readAt: true,
        createdAt: true,
      },
    });
  }

  async unreadCount(userId: string): Promise<number> {
    // Bounded: the badge says "50+" past the ceiling, so counting further is
    // work whose answer is discarded.
    return this.deps.prisma.notification.count({
      where: { userId, readAt: null },
      take: UNREAD_BADGE_CEILING + 1,
    });
  }

  /**
   * Marks one notice read.
   *
   * Scoped to the recipient: a notification id is not a capability, and one
   * person must not be able to clear another's list by guessing an id.
   */
  async markRead(id: string, userId: string): Promise<void> {
    await this.deps.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<{ cleared: number }> {
    const result = await this.deps.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { cleared: result.count };
  }
}
