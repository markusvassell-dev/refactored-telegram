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
  /** Reminder cadence, expressed in business days. */
  reminderEveryBusinessDays: number;
  locale: string;
  /** Whether a signer may delegate. Off by default. */
  allowDelegation: boolean;
  /** Identity verification: email verification by default. */
  authenticationMethod: 'EMAIL' | 'PHONE' | 'KBA';
  engagementType: EngagementType;
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

/**
 * Default signing order per engagement type.
 *
 * T1 joint  — both taxpayers in parallel, firm signer afterwards.
 * T2        — signing officer first, firm representative last.
 * T3        — authorised representative first, firm signer last.
 */
export function defaultSigningOrder(engagementType: EngagementType, role: SignerRole): number {
  if (role === 'FIRM_SIGNER') return 2;
  if (engagementType === 'T1_JOINT') return 1; // Taxpayer 1 and 2 both order 1.
  return 1;
}

export const DEFAULT_AGREEMENT_SETTINGS = {
  expiresInDays: 30,
  reminderEveryBusinessDays: 3,
  locale: 'en_US',
  allowDelegation: false,
  authenticationMethod: 'EMAIL' as const,
};
