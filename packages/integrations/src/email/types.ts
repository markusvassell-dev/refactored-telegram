/**
 * Sending mail to firm staff.
 *
 * Staff only. Nothing in this application emails a client — a client hears from
 * Acrobat Sign, which is where the signing record belongs. That boundary is
 * worth keeping sharp: it means a misconfigured sender address can embarrass
 * the firm but cannot reach a client, and it is why staff mail is permitted in
 * Test Mode when contacting a client is not.
 */

export interface OutgoingEmail {
  /** A firm address, taken from a user record. Never typed in by hand. */
  to: string;
  subject: string;
  /** Plain text. Deliberately not HTML: nothing here needs formatting. */
  body: string;
}

export interface EmailSendResult {
  ok: boolean;
  /** The vendor's own words when it refused, for the operator to read. */
  detail?: string;
}

export interface EmailSender {
  readonly name: string;
  /** True when this adapter performs no real network call. */
  readonly isMock: boolean;
  /** True when this adapter refuses to send at all, and why. */
  readonly isBlocked: boolean;

  send(email: OutgoingEmail): Promise<EmailSendResult>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
