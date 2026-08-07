import type { EmailSendResult, EmailSender, OutgoingEmail } from './types.js';

/**
 * A mailer that records instead of sending.
 *
 * Used when no mail is configured, and by tests. Always labelled as a mock, so
 * "notifications are being emailed" can never be believed on the strength of a
 * green tick when nothing is leaving the building.
 */
export class MockEmailSender implements EmailSender {
  readonly name = 'mock';
  readonly isMock = true;
  readonly isBlocked = false;

  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    this.sent.push(email);
    return { ok: true };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'Mock mailer. Nothing is sent.' };
  }
}

/**
 * A mailer that refuses, and says why.
 *
 * The difference from the mock matters: a mock quietly succeeds, which is right
 * when nobody asked for mail. This is for when somebody did ask and it must not
 * happen — so it reports a failure the operator can read rather than a success
 * that never left.
 */
export class BlockedEmailSender implements EmailSender {
  readonly name = 'blocked';
  readonly isMock = false;
  readonly isBlocked = true;

  constructor(private readonly reason: string) {}

  async send(): Promise<EmailSendResult> {
    return { ok: false, detail: this.reason };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: this.reason };
  }
}
