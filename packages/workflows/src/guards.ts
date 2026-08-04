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
  testMode: boolean;
  productionSendingEnabled: boolean;
  /** True when a sandbox Adobe Sign connection is configured for test sends. */
  sandboxConfigured: boolean;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  // Test Mode must make it hard to confuse test and production.
  if (input.testMode && !input.sandboxConfigured) {
    blockers.push(
      'Test Mode is active and no Adobe Sign sandbox connection is configured, so no agreement will be sent. Use the mock adapter or configure a sandbox.',
    );
  }
  if (!input.testMode && !input.productionSendingEnabled) {
    blockers.push('Production sending has not been enabled by an administrator.');
  }
  if (input.testMode) {
    warnings.push('Test Mode is active. No real client will be contacted.');
  }

  return result(blockers, warnings);
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
