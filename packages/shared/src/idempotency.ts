import { createHash } from 'node:crypto';
import type { DocumentType, EngagementType } from './domain.js';

/**
 * Deterministic idempotency keys.
 *
 * The same logical operation must always produce the same key so that a retry
 * — whether from the job runner, a duplicated webhook, or an impatient user —
 * can never create a duplicate draft, a duplicate Karbon upload, or a duplicate
 * Adobe Sign agreement.
 */

function digest(parts: readonly (string | number | null | undefined)[]): string {
  const canonical = parts.map((part) => (part === null || part === undefined ? '' : String(part))).join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 40);
}

function prefixed(prefix: string, parts: readonly (string | number | null | undefined)[]): string {
  return `${prefix}_${digest([prefix, ...parts])}`;
}

/** One active generation per client + engagement type + tax year. */
export function generationIdempotencyKey(input: {
  clientId: string;
  engagementType: EngagementType;
  taxYear: number;
  documentType: DocumentType;
  /** Increment to deliberately supersede an existing draft. */
  attempt?: number;
}): string {
  return prefixed('gen', [
    input.clientId,
    input.engagementType,
    input.taxYear,
    input.documentType,
    input.attempt ?? 1,
  ]);
}

/**
 * Adobe Sign agreement key.
 *
 * Bound to the approved document version so that regenerating a draft after a
 * rejection produces a genuinely new agreement, while a transport-level retry
 * of the same approved version does not.
 */
export function adobeAgreementIdempotencyKey(input: {
  clientId: string;
  engagementType: EngagementType;
  taxYear: number;
  approvedDocumentVersionId: string;
  signingAttempt: number;
}): string {
  return prefixed('adobe', [
    input.clientId,
    input.engagementType,
    input.taxYear,
    input.approvedDocumentVersionId,
    input.signingAttempt,
  ]);
}

/** One upload per (work item, document version, file role). */
export function karbonUploadIdempotencyKey(input: {
  karbonWorkItemKey: string;
  documentVersionId: string;
  fileRole: string;
}): string {
  return prefixed('kbupload', [input.karbonWorkItemKey, input.documentVersionId, input.fileRole]);
}

export function karbonCommentIdempotencyKey(input: {
  karbonWorkItemKey: string;
  documentVersionId: string;
  kind: string;
}): string {
  return prefixed('kbcomment', [input.karbonWorkItemKey, input.documentVersionId, input.kind]);
}

/** Webhook de-duplication: same provider event id must only be processed once. */
export function webhookEventIdempotencyKey(provider: string, providerEventId: string): string {
  return prefixed('hook', [provider, providerEventId]);
}

export function coverLetterIdempotencyKey(input: {
  engagementId: string;
  documentType: DocumentType;
  /** Distinguishes per-taxpayer T1 cover letters. */
  participantId?: string | null;
  sourceDocumentFingerprint: string;
}): string {
  return prefixed('cover', [
    input.engagementId,
    input.documentType,
    input.participantId ?? 'primary',
    input.sourceDocumentFingerprint,
  ]);
}

/**
 * Fingerprint of the exact set of source documents a cover letter was built
 * from. When any source document changes, the fingerprint changes and the
 * cover letter is marked stale.
 */
export function sourceDocumentFingerprint(documents: readonly { id: string; fileHash: string }[]): string {
  const sorted = [...documents].sort((a, b) => a.id.localeCompare(b.id));
  return digest(sorted.flatMap((doc) => [doc.id, doc.fileHash]));
}

/**
 * Stops one batch queueing the same work twice — a double-submitted preview.
 *
 * Includes the tax year: a rollout is scoped to one year, but `run` accepts a
 * list of ids, and without the year two engagements of the same client and type
 * from different years would collide and one would be silently dropped.
 *
 * Cross-batch protection is separate, and comes from the per-engagement
 * generation key the bulk item re-enqueues under.
 */
export function bulkRolloutIdempotencyKey(input: {
  batchId: string;
  clientId: string;
  taxYear: number;
  documentType: DocumentType;
}): string {
  return prefixed('bulk', [input.batchId, input.clientId, input.taxYear, input.documentType]);
}
