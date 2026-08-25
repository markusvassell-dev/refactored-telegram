import type { EngagementType } from '@element/shared';

/**
 * Adobe Acrobat Sign provider interface.
 *
 * Signature placement uses Adobe text tags embedded in the generated document
 * at manifest-defined anchors. An actual signature or signed date is never
 * prefilled — only names, email addresses, roles and titles.
 */

export type SignerRole =
  | 'TAXPAYER_1'
  | 'TAXPAYER_2'
  | 'AUTHORIZED_SIGNING_OFFICER'
  | 'AUTHORIZED_REPRESENTATIVE'
  | 'FIRM_SIGNER';

export interface AgreementSigner {
  role: SignerRole;
  name: string;
  email: string;
  /** Signers sharing an order sign in parallel. */
  order: number;
  title?: string | null;
}

export interface CreateAgreementRequest {
  /** Deterministic key. A retry with the same key must not create a second agreement. */
  idempotencyKey: string;
  title: string;
  /** The approved PDF. Nothing unapproved is ever sent. */
  pdf: Uint8Array | Buffer;
  fileName: string;
  signers: AgreementSigner[];
  ccEmails: string[];
  message?: string;
  /** Days until the agreement expires. */
  expiresInDays: number;
  /**
   * Reminder cadence, expressed in business days.
   *
   * Adobe publishes two cadences and no others, so this is a request rather
   * than an instruction — see `adobeReminderFrequency`, which is what actually
   * goes on the wire and what the agreement record should be written from.
   */
  reminderEveryBusinessDays: number;
  locale: string;
  /**
   * Whether a signer may hand the letter to somebody else to sign.
   *
   * NOT YET HONOURED, and deliberately left that way rather than guessed. The
   * field a request uses to forbid delegation could not be confirmed against
   * Adobe's specification from this environment, and inventing a field name is
   * worse than sending none: an unrecognised key is ignored silently, which
   * would leave this reading as enforced while Adobe applied its own default.
   *
   * `AdobeSignRestClient.createAgreement` logs a warning when this is false so
   * the gap is visible in the record of every send that assumed otherwise.
   * Resolve it against the published spec before relying on it.
   */
  allowDelegation: boolean;
  /**
   * Identity verification: email verification by default.
   *
   * `PHONE` is refused rather than sent. Adobe's `ParticipantSecurityOption`
   * requires a `phoneInfo` — a country code and a number — for phone
   * verification, and nothing on this request carries a signer's telephone
   * number. Sending `PHONE` without one is the shape of failure this project
   * has hit twice already: the field is accepted, the check is not applied, and
   * every signal says the letter went out verified.
   */
  authenticationMethod: 'EMAIL' | 'PHONE' | 'KBA';
  engagementType: EngagementType;
}

/**
 * The reminder cadence Adobe will actually apply.
 *
 * `AgreementInfo.reminderFrequency` publishes exactly two values. This client
 * used to send `EVERY_THIRD_DAY_UNTIL_SIGNED`, which is not one of them, on
 * every agreement — the default cadence is three business days, so that was
 * every send. Anything above daily becomes weekly, and the label says weekly
 * too, so the record on the agreement matches what the client will experience
 * rather than what was asked for.
 */
export function adobeReminderFrequency(everyBusinessDays: number): {
  value: 'DAILY_UNTIL_SIGNED' | 'WEEKLY_UNTIL_SIGNED';
  label: string;
} {
  return everyBusinessDays <= 1
    ? { value: 'DAILY_UNTIL_SIGNED', label: 'Every day until signed' }
    : { value: 'WEEKLY_UNTIL_SIGNED', label: 'Every week until signed' };
}

export type AgreementStatus =
  | 'CREATED'
  | 'OUT_FOR_SIGNATURE'
  | 'PARTIALLY_SIGNED'
  | 'SIGNED'
  | 'COMPLETED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED';

export type SignerStatus =
  | 'NOT_YET_NOTIFIED'
  | 'WAITING_FOR_OTHERS'
  | 'OUT_FOR_SIGNATURE'
  | 'VIEWED'
  | 'SIGNED'
  | 'DECLINED'
  | 'DELEGATED'
  | 'EXPIRED';

export interface AgreementState {
  agreementId: string;
  status: AgreementStatus;
  signers: { email: string; role: SignerRole; status: SignerStatus; signedAt?: string | null; viewedAt?: string | null }[];
  createdAt?: string | null;
  completedAt?: string | null;
  declineReason?: string | null;
}

export interface CreateAgreementResult {
  agreementId: string;
  status: AgreementStatus;
  /** True when an existing agreement was returned instead of creating a new one. */
  deduplicated: boolean;
}

export interface AdobeWebhookEvent {
  /** Adobe's event id. Used for de-duplication. */
  eventId: string;
  eventType: string;
  agreementId: string | null;
  participantEmail?: string | null;
  occurredAt: string;
  raw: unknown;
}

export interface AdobeSignProvider {
  readonly name: string;
  readonly isMock: boolean;

  createAgreement(request: CreateAgreementRequest): Promise<CreateAgreementResult>;
  /**
   * The agreement already created under this idempotency key, if any.
   *
   * On the interface rather than only on the REST client, because it is the last
   * defence against sending a client two copies of the same engagement letter.
   * It existed on the client, documented as preventing duplicates, and was never
   * on the interface and never called — so it prevented nothing. Required, so a
   * new adapter cannot omit it and quietly lose the protection.
   *
   * Throws rather than returning null when the lookup itself fails: "no
   * agreement" and "could not check" must not be the same answer, because the
   * caller creates one on the first and must not on the second.
   */
  findByExternalId(idempotencyKey: string): Promise<string | null>;
  getAgreement(agreementId: string): Promise<AgreementState | null>;
  cancelAgreement(agreementId: string, reason: string): Promise<void>;

  /** The completed, signed PDF. */
  downloadSignedPdf(agreementId: string): Promise<Buffer>;
  /** The signing certificate / audit report. */
  downloadAuditReport(agreementId: string): Promise<Buffer>;

  /** Verifies a webhook payload's authenticity before it is trusted. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): boolean;
  parseWebhook(rawBody: string): AdobeWebhookEvent | null;

  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export const DEFAULT_AGREEMENT_SETTINGS = {
  expiresInDays: 30,
  reminderEveryBusinessDays: 3,
  locale: 'en_US',
  allowDelegation: false,
  authenticationMethod: 'EMAIL' as const,
};
