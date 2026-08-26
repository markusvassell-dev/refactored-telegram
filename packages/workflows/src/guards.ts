import { PreconditionError } from '@element/shared';
import type { EngagementStatus } from './engagement-state-machine.js';

/**
 * Application-level workflow gates.
 *
 * The state machine says which transitions are *shaped* correctly. These guards
 * say whether the preconditions for a particular business action are actually
 * satisfied. Both must pass.
 *
 * Every guard is a pure function over a plain input object so it can be unit
 * tested without a database or an integration.
 */

export interface GateResult {
  ok: boolean;
  /** Human-readable blocking reasons, safe to show a reviewer. */
  blockers: string[];
  /** Non-blocking things the reviewer should look at. */
  warnings: string[];
}

function result(blockers: string[], warnings: string[] = []): GateResult {
  return { ok: blockers.length === 0, blockers, warnings };
}

export function assertGate(gate: GateResult, action: string): void {
  if (!gate.ok) {
    throw new PreconditionError(`${action} is blocked: ${gate.blockers.join(' ')}`, { blockers: gate.blockers });
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerationGateInput {
  documentTypeIsProductionSupported: boolean;
  hasActiveTemplateVersion: boolean;
  /** Null means "not yet confirmed by a human". Only relevant to T2. */
  compilationSelected?: boolean | null;
  requiresCompilationConfirmation: boolean;
  /** Every fee the engagement needs must be resolved and unblocked. */
  blockedFeeKinds: readonly string[];
  unresolvedConflicts: number;
  missingRequiredFields: readonly string[];
}

export function evaluateGenerationGate(input: GenerationGateInput): GateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.documentTypeIsProductionSupported) {
    blockers.push(
      'This document type has no approved master template. An administrator must upload and activate one before it can be generated.',
    );
  }
  if (!input.hasActiveTemplateVersion) {
    blockers.push('No active template version is available for this document type.');
  }
  if (input.requiresCompilationConfirmation && (input.compilationSelected === null || input.compilationSelected === undefined)) {
    blockers.push('A reviewer must confirm whether CSRS 4200 compilation services are included this year.');
  }
  if (input.blockedFeeKinds.length > 0) {
    blockers.push(`A confirmed fee is required for: ${input.blockedFeeKinds.join(', ')}.`);
  }
  if (input.missingRequiredFields.length > 0) {
    blockers.push(`Required information is missing: ${input.missingRequiredFields.join(', ')}.`);
  }
  if (input.unresolvedConflicts > 0) {
    warnings.push(`${input.unresolvedConflicts} conflicting value(s) still need a reviewer decision.`);
  }

  return result(blockers, warnings);
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface ApprovalGateInput {
  validationErrorCount: number;
  unresolvedConflicts: number;
  unconfirmedDates: readonly string[];
  unconfirmedFees: readonly string[];
  /** Wording exceptions still awaiting partner sign-off. */
  pendingWordingExceptions: number;
  /** Fee movements that require elevated approval and have not received it. */
  pendingFeeApprovals: readonly string[];
  hasRenderedDocx: boolean;
  hasRenderedPdf: boolean;
}

export function evaluateApprovalGate(input: ApprovalGateInput): GateResult {
  const blockers: string[] = [];

  if (!input.hasRenderedDocx || !input.hasRenderedPdf) {
    blockers.push('Both the Word document and the PDF must be generated before approval.');
  }
  if (input.validationErrorCount > 0) {
    blockers.push(`${input.validationErrorCount} document validation error(s) must be resolved.`);
  }
  if (input.unresolvedConflicts > 0) {
    blockers.push(`${input.unresolvedConflicts} conflicting value(s) must be resolved.`);
  }
  if (input.unconfirmedDates.length > 0) {
    blockers.push(`These dates must be confirmed by a reviewer: ${input.unconfirmedDates.join(', ')}.`);
  }
  if (input.unconfirmedFees.length > 0) {
    blockers.push(`These fees must be confirmed: ${input.unconfirmedFees.join(', ')}.`);
  }
  if (input.pendingWordingExceptions > 0) {
    blockers.push(`${input.pendingWordingExceptions} wording change(s) still require partner approval.`);
  }
  if (input.pendingFeeApprovals.length > 0) {
    blockers.push(`These fee changes require partner approval: ${input.pendingFeeApprovals.join(', ')}.`);
  }

  return result(blockers);
}

// ---------------------------------------------------------------------------
// Sending for signature
// ---------------------------------------------------------------------------

export interface SendGateInput {
  status: EngagementStatus;
  hasApprovedPdf: boolean;
  /** An explicit Approval row of type FINAL_DOCUMENT or SEND_AUTHORIZATION. */
  hasInternalApprovalEvent: boolean;
  signers: readonly { name: string; email: string; confirmed: boolean; signingOrder: number }[];
  signingOrderConfirmed: boolean;
  validationErrorCount: number;
  /**
   * Whether a signature copy — the render carrying Adobe's tags — exists for the
   * version about to be sent.
   *
   * Separate from `hasApprovedPdf` because they are different files. What was
   * approved is the readable draft; what Adobe needs is the tagged copy. Sending
   * the draft is what the code did before, and it meant every agreement went out
   * with no signature fields in it at all.
   */
  hasSignatureCopy: boolean;
  /**
   * Roles the template requires a signature from that no participant holds.
   *
   * Non-empty means the signature copy could not name everyone the document
   * needs. Sending anyway produces an agreement that completes without a
   * signature the letter says is required.
   */
  unfilledSignatureRoles: readonly string[];
  /**
   * Whether the signer roster differs from the one the signature copy was
   * rendered against.
   *
   * Compared as a roster snapshot rather than by timestamp: a `max(updatedAt)`
   * check cannot see a *removed* signer, because the rows that remain are
   * untouched and look older than the document version.
   */
  signersChangedSinceGeneration: boolean;
  testMode: boolean;
  productionSendingEnabled: boolean;
  /**
   * Which Adobe adapter the caller actually got. Named rather than reduced to
   * a boolean, because the four ways a Test Mode send can be wrong need four
   * different sentences: the fix for "switched off" is a click on Integrations,
   * and the fix for "no connection" is an afternoon with Adobe.
   */
  adobeSignMode: 'sandbox' | 'production' | 'mock' | 'blocked' | 'disabled';
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Why a Test Mode send is refused, by cause.
 *
 * Each names the next action, because "no sandbox is configured" is the same
 * sentence for a connection somebody finished and forgot to switch on as for
 * one that does not exist — and those are minutes apart in effort.
 */
const ADOBE_MODE_BLOCKERS: Record<SendGateInput['adobeSignMode'], string> = {
  sandbox: '',
  disabled:
    'The Adobe Sign connection is saved but switched off, so nothing would be sent to a signer. Open Integrations, set "Use this connection" to Yes, and save.',
  mock: 'Test Mode is active and no Adobe Sign connection is configured, so no agreement would be sent to anybody.',
  production:
    'Test Mode is active and this is a production Adobe Sign connection, so sending is refused. Connect a Developer Edition or sandbox account for test sends.',
  blocked:
    'No Adobe Sign connection is configured, so no agreement would be sent to anybody. Connect one on Integrations.',
};

export function evaluateSendGate(input: SendGateInput): GateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.status !== 'READY_TO_SEND') {
    blockers.push(`The engagement must be in READY_TO_SEND, not ${input.status}.`);
  }
  if (!input.hasApprovedPdf) {
    blockers.push('An approved PDF is required before sending.');
  }
  if (!input.hasInternalApprovalEvent) {
    blockers.push('An explicit internal approval is required before sending.');
  }
  if (input.validationErrorCount > 0) {
    blockers.push(`All ${input.validationErrorCount} validation error(s) must be resolved before sending.`);
  }
  if (input.signers.length === 0) {
    blockers.push('At least one signer is required.');
  }
  for (const signer of input.signers) {
    if (!signer.name.trim()) blockers.push('Every signer must have a confirmed name.');
    if (!EMAIL_SHAPE.test(signer.email ?? '')) {
      blockers.push(`Signer "${signer.name || 'unnamed'}" needs a valid email address.`);
    }
    if (!signer.confirmed) {
      blockers.push(`Signer "${signer.name || 'unnamed'}" has not been confirmed by a reviewer.`);
    }
  }
  if (!input.signingOrderConfirmed) {
    blockers.push('The signing order must be confirmed.');
  }

  // The document that goes to Adobe is not the one a reviewer read. The draft
  // shows blank signature lines; the signature copy carries Adobe's tags in
  // their place. Sending the draft — which is what happened before this copy
  // existed — produces an agreement with no signature fields at all, which
  // Adobe accepts without complaint and nobody can sign.
  if (!input.hasSignatureCopy) {
    blockers.push(
      'This version has no signature copy, so there is nothing carrying signature fields to send. Regenerate the document after naming the signers.',
    );
  }
  if (input.unfilledSignatureRoles.length > 0) {
    blockers.push(
      `The letter requires a signature from ${input.unfilledSignatureRoles
        .map((role) => role.replace(/_/g, ' ').toLowerCase())
        .join(', ')}, and nobody on this engagement holds that role.`,
    );
  }
  if (input.signersChangedSinceGeneration) {
    // The tags in the stored copy address participant *sets* by position, so a
    // roster edit after generation silently re-points every field at somebody
    // else. Regenerating is cheap; sending a letter whose signature blocks
    // belong to the wrong people is not recoverable once it has gone out.
    blockers.push(
      'The signers changed after this document was generated, so its signature fields no longer match them. Regenerate before sending.',
    );
  }

  // Test Mode must make it hard to confuse test and production.
  //
  // This used to be one boolean derived from a description string, and a
  // sandbox connection that was merely switched off slipped through it: the
  // adapter fell back to the mock, the mock's description does not begin with
  // "blocked", and the guard concluded a sandbox was configured. The send then
  // went to a mock that fabricates an agreement id and answers SUCCEEDED,
  // while every screen said the letter was out for signature.
  if (input.testMode && input.adobeSignMode !== 'sandbox') {
    blockers.push(ADOBE_MODE_BLOCKERS[input.adobeSignMode]);
  }
  if (!input.testMode && !input.productionSendingEnabled) {
    blockers.push('Production sending has not been enabled by an administrator.');
  }

  // With Test Mode off, a mock is worse than useless: the send reports an
  // agreement id, the engagement moves to SENT_FOR_SIGNATURE, and no client
  // was ever asked to sign anything. Test Mode at least labels what happened;
  // outside it there is nothing to distinguish a fabricated send from a real
  // one until somebody wonders why the client has not replied.
  if (!input.testMode && (input.adobeSignMode === 'mock' || input.adobeSignMode === 'disabled')) {
    blockers.push(ADOBE_MODE_BLOCKERS[input.adobeSignMode]);
  }
  if (input.testMode) {
    warnings.push('Test Mode is active. No real client will be contacted.');
  }

  return result(blockers, warnings);
}

// ---------------------------------------------------------------------------
// Recording a signature obtained outside this application
// ---------------------------------------------------------------------------

export interface ExternalSignatureGateInput {
  status: EngagementStatus;
  hasApprovedPdf: boolean;
  /** An explicit Approval row of type FINAL_DOCUMENT or SEND_AUTHORIZATION. */
  hasInternalApprovalEvent: boolean;
  /** Everyone the engagement says must sign, and whether the recorder confirmed each. */
  expectedSigners: readonly { name: string; confirmed: boolean }[];
  /** True when the uploaded bytes really are a PDF. */
  evidenceIsPdf: boolean;
  evidenceByteLength: number;
  /** The date asserted for the signature, and today, both as YYYY-MM-DD. */
  signedOnIso: string;
  todayIso: string;
  /** A live Adobe agreement means the two records would contradict each other. */
  hasOpenAdobeAgreement: boolean;
  reason: string;
}

/** Ten characters is not a quality bar; it is a bar against an empty box. */
const MINIMUM_REASON_LENGTH = 10;

export function evaluateExternalSignatureGate(input: ExternalSignatureGateInput): GateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.status !== 'READY_TO_SEND') {
    blockers.push(
      `A signature can only be recorded against an engagement in READY_TO_SEND, not ${input.status}. Everything before that is still a draft.`,
    );
  }

  // The same two preconditions the Adobe path enforces. Obtaining a signature
  // elsewhere changes who collected it, not whether the firm approved the
  // wording and the fee first.
  if (!input.hasApprovedPdf) {
    blockers.push('There is no approved PDF, so there is nothing that could have been signed.');
  }
  if (!input.hasInternalApprovalEvent) {
    blockers.push('An explicit internal approval is required before a signature can be recorded.');
  }

  if (!input.evidenceIsPdf) {
    blockers.push('The signed document must be a PDF. Its contents are checked, not its file name.');
  }
  if (input.evidenceByteLength === 0) {
    blockers.push('Attach the signed document. A signature with no document behind it is not a record of anything.');
  }

  if (input.expectedSigners.length === 0) {
    blockers.push('This engagement names nobody who must sign, so there is nothing to confirm.');
  }
  // The joint-return case: one spouse signing is not the letter being signed.
  // Without this, a half-signed joint letter is indistinguishable in the file
  // from a complete one.
  for (const signer of input.expectedSigners) {
    if (!signer.confirmed) {
      blockers.push(`Confirm that ${signer.name || 'each named signer'} signed, or this is not a fully signed letter.`);
    }
  }

  if (input.hasOpenAdobeAgreement) {
    blockers.push(
      'This engagement already has an open Adobe Sign agreement. Cancel it first, or the two records will disagree about how the client signed.',
    );
  }

  if (input.reason.trim().length < MINIMUM_REASON_LENGTH) {
    blockers.push('Say why the signature was obtained outside this application. It goes in the permanent record.');
  }

  // A signature cannot have happened after today, and one dated long ago is
  // more likely a typo than a letter that sat in someone's inbox since spring.
  if (input.signedOnIso > input.todayIso) {
    blockers.push(`The signature is dated ${input.signedOnIso}, which is in the future.`);
  } else if (daysBetweenIso(input.signedOnIso, input.todayIso) > 90) {
    warnings.push(
      `The signature is dated ${input.signedOnIso}, more than 90 days ago. Check the date is right before recording it.`,
    );
  }

  warnings.push(
    'This records a signature this application did not collect. The file will show it was obtained elsewhere, and by whom it was recorded.',
  );

  return result(blockers, warnings);
}

/**
 * Whole days between two YYYY-MM-DD dates. Both are treated as UTC midnight, so
 * the difference is an exact multiple of a day and integer division is exact —
 * no rounding, and no daylight-saving hour to lose.
 */
function daysBetweenIso(earlier: string, later: string): number {
  const from = Date.parse(`${earlier}T00:00:00Z`);
  const to = Date.parse(`${later}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.trunc((to - from) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Cover letters
// ---------------------------------------------------------------------------

export interface CoverLetterTriggerInput {
  /** Condition 1: every required final source document is present. */
  missingRequiredSourceDocuments: readonly string[];
  /** Condition 2: the designated internal approval task is complete. */
  internalApprovalTaskComplete: boolean;
  /** Condition 3: the engagement or Karbon work item says READY_FOR_COVER_LETTER. */
  status: EngagementStatus;
  hasApprovedCoverLetterTemplate: boolean;
  clientIdentityMatches: boolean;
  periodMatches: boolean;
  allSourceDocumentsFinal: boolean;
  anySourceDocumentSuperseded: boolean;
  unreadableSourceDocuments: readonly string[];
  missingRequiredAmounts: readonly string[];
  missingRequiredDeadlines: readonly string[];
}

/**
 * A completion cover letter may be generated only when all three trigger
 * conditions are met. Uploading a PDF is never sufficient on its own.
 */
export function evaluateCoverLetterTriggerGate(input: CoverLetterTriggerInput): GateResult {
  const blockers: string[] = [];

  if (input.missingRequiredSourceDocuments.length > 0) {
    blockers.push(`These final source documents are missing: ${input.missingRequiredSourceDocuments.join(', ')}.`);
  }
  if (!input.internalApprovalTaskComplete) {
    blockers.push('The internal approval task for this engagement is not complete.');
  }
  if (input.status !== 'READY_FOR_COVER_LETTER' && input.status !== 'COVER_LETTER_CHANGES_REQUESTED') {
    blockers.push(`The engagement must be READY_FOR_COVER_LETTER, not ${input.status}.`);
  }
  if (!input.hasApprovedCoverLetterTemplate) {
    blockers.push(
      'No approved cover-letter template exists for this engagement type. An administrator must upload and activate one.',
    );
  }
  if (!input.clientIdentityMatches) {
    blockers.push('The client identity on the source documents does not match this engagement.');
  }
  if (!input.periodMatches) {
    blockers.push('The tax year or fiscal period on the source documents does not match this engagement.');
  }
  if (!input.allSourceDocumentsFinal) {
    blockers.push('Every source document must be marked final.');
  }
  if (input.anySourceDocumentSuperseded) {
    blockers.push('A newer version has replaced one of the selected source documents.');
  }
  if (input.unreadableSourceDocuments.length > 0) {
    blockers.push(`These documents could not be read: ${input.unreadableSourceDocuments.join(', ')}.`);
  }
  if (input.missingRequiredAmounts.length > 0) {
    blockers.push(`Required tax amounts are unavailable: ${input.missingRequiredAmounts.join(', ')}.`);
  }
  if (input.missingRequiredDeadlines.length > 0) {
    blockers.push(`Required deadlines are unavailable: ${input.missingRequiredDeadlines.join(', ')}.`);
  }

  return result(blockers);
}

export interface CoverLetterDeliveryGateInput {
  isApproved: boolean;
  isStale: boolean;
  /** Every extracted value must be either confirmed or explicitly overridden. */
  unconfirmedFields: readonly string[];
  hasFinalDocx: boolean;
  hasFinalPdf: boolean;
}

export function evaluateCoverLetterDeliveryGate(input: CoverLetterDeliveryGateInput): GateResult {
  const blockers: string[] = [];

  if (!input.isApproved) {
    blockers.push('A person must review and approve the cover letter before it can be delivered.');
  }
  if (input.isStale) {
    blockers.push('A source document changed after this cover letter was generated. It must be regenerated and re-approved.');
  }
  if (input.unconfirmedFields.length > 0) {
    blockers.push(`These extracted values still need confirmation: ${input.unconfirmedFields.join(', ')}.`);
  }
  if (!input.hasFinalDocx || !input.hasFinalPdf) {
    blockers.push('The final Word document and PDF must both exist.');
  }

  return result(blockers);
}
