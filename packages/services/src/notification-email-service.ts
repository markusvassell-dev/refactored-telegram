import type { PrismaClient } from '@element/database';
import type { EmailSender } from '@element/integrations';
import type { Logger } from '@element/shared';

/**
 * Getting a notice out of the application and into somebody's inbox.
 *
 * Separate from raising the notice, deliberately and in three ways.
 *
 * **In time.** Raising a notice is part of recording that a client signed;
 * sending mail is not. Signing must never fail because a mail server was
 * briefly unreachable, so the notice is written first and delivered afterwards
 * by this, from a background job.
 *
 * **In state.** `emailedAt` is not the same fact as `readAt`. A notice may be
 * emailed and unread, read and never emailed, or neither.
 *
 * **In consequence.** A notice that cannot be emailed is still a notice: it is
 * in the application, where the recipient will see it. Failing to deliver
 * degrades the service, it does not lose the information.
 */

export interface NotificationEmailServiceDeps {
  prisma: PrismaClient;
  mailer: EmailSender;
  logger: Logger;
  /** Absolute, for the link in the message. */
  appBaseUrl: string;
  /** Marks every subject while Test Mode is on, so a test notice is obvious. */
  testMode: boolean;
}

export interface DrainResult {
  considered: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * How many times a single notice is retried before it is left alone.
 *
 * Past this the failure is not transient — a wrong address, a revoked
 * permission — and re-sending forever turns one misconfiguration into an
 * unbounded number of requests against the tenant.
 */
export const MAX_EMAIL_ATTEMPTS = 4;

export class NotificationEmailService {
  constructor(private readonly deps: NotificationEmailServiceDeps) {}

  /**
   * Sends what is waiting.
   *
   * Ordered oldest first, so a backlog drains in the order things happened
   * rather than newest-first, which would leave the oldest news never sent.
   */
  async drain(limit = 50): Promise<DrainResult> {
    const pending = await this.deps.prisma.notification.findMany({
      where: { emailedAt: null, emailAttempts: { lt: MAX_EMAIL_ATTEMPTS } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        title: true,
        body: true,
        link: true,
        user: { select: { email: true, isActive: true, displayName: true } },
      },
    });

    const result: DrainResult = { considered: pending.length, sent: 0, failed: 0, skipped: 0 };

    for (const notice of pending) {
      // A deactivated account keeps its notices in the application but is not
      // mailed: the person has left, and the firm should not keep writing to
      // an address it has stopped trusting for sign-in.
      if (!notice.user.isActive || !notice.user.email) {
        await this.deps.prisma.notification.update({
          where: { id: notice.id },
          data: { emailAttempts: MAX_EMAIL_ATTEMPTS, emailError: 'The recipient is not an active user.' },
        });
        result.skipped += 1;
        continue;
      }

      const subject = this.deps.testMode ? `[TEST MODE] ${notice.title}` : notice.title;
      const outcome = await this.deps.mailer.send({
        to: notice.user.email,
        subject,
        body: this.compose(notice.body, notice.link),
      });

      if (outcome.ok) {
        await this.deps.prisma.notification.update({
          where: { id: notice.id },
          data: { emailedAt: new Date(), emailError: null, emailAttempts: { increment: 1 } },
        });
        result.sent += 1;
        continue;
      }

      await this.deps.prisma.notification.update({
        where: { id: notice.id },
        // Recorded, not thrown away: "we tried four times and Microsoft said
        // this" is what an administrator needs at 8am.
        data: { emailAttempts: { increment: 1 }, emailError: (outcome.detail ?? 'unknown').slice(0, 500) },
      });
      result.failed += 1;

      this.deps.logger.warn('A notification could not be e-mailed', {
        notificationId: notice.id,
        reason: outcome.detail ?? 'unknown',
      });
    }

    return result;
  }

  /**
   * The message body.
   *
   * Plain text, short, and carrying a link rather than the detail. Nothing
   * about an engagement belongs in an inbox that does not need to be there —
   * a client's name is already more than a notice needs to travel with, and
   * the application is where the confidential part stays.
   */
  private compose(body: string, link: string | null): string {
    const lines = [body];

    if (link) {
      const absolute = new URL(link, this.deps.appBaseUrl).toString();
      lines.push('', absolute);
    }

    lines.push('', 'This is an automatic message from Element Engagements. Do not reply to it.');
    return lines.join('\n');
  }
}
