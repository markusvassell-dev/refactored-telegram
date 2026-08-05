import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  ENGAGEMENT_STATUSES,
  assertTransition,
  canTransition,
  evaluateApprovalGate,
  evaluateCoverLetterDeliveryGate,
  evaluateCoverLetterTriggerGate,
  evaluateGenerationGate,
  evaluateSendGate,
  transitionPairs,
  workflowTransitionSeedSql,
} from '@element/workflows';

describe('engagement state machine', () => {
  it('covers every declared status', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ENGAGEMENT_STATUSES].sort());
  });

  it('never allows a transition to an unknown status', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const to of targets) {
        expect(ENGAGEMENT_STATUSES, `${from} -> ${to}`).toContain(to);
      }
    }
  });

  it('refuses to jump from DRAFT_READY straight to sending', () => {
    expect(canTransition('DRAFT_READY', 'SENT_FOR_SIGNATURE')).toBe(false);
    expect(canTransition('DRAFT_READY', 'READY_TO_SEND')).toBe(false);
    expect(canTransition('DRAFT_READY', 'APPROVED')).toBe(false);
    expect(() => assertTransition('DRAFT_READY', 'SENT_FOR_SIGNATURE')).toThrow(/cannot move/i);
  });

  it('only reaches APPROVED from IN_REVIEW', () => {
    const sources = ENGAGEMENT_STATUSES.filter((status) => canTransition(status, 'APPROVED'));
    expect(sources).toEqual(['IN_REVIEW']);
  });

  it('only reaches COVER_LETTER_APPROVED from COVER_LETTER_IN_REVIEW', () => {
    const sources = ENGAGEMENT_STATUSES.filter((status) => canTransition(status, 'COVER_LETTER_APPROVED'));
    expect(sources).toEqual(['COVER_LETTER_IN_REVIEW']);
  });

  it('does not let NEEDS_ATTENTION recovery skip an approval', () => {
    expect(canTransition('NEEDS_ATTENTION', 'APPROVED')).toBe(false);
    expect(canTransition('NEEDS_ATTENTION', 'COVER_LETTER_APPROVED')).toBe(false);
  });

  it('requires the review path before an approval', () => {
    expect(canTransition('DRAFT_READY', 'REVIEW_REQUIRED')).toBe(true);
    expect(canTransition('REVIEW_REQUIRED', 'IN_REVIEW')).toBe(true);
    expect(canTransition('IN_REVIEW', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'READY_TO_SEND')).toBe(true);
    expect(canTransition('READY_TO_SEND', 'SENDING_FOR_SIGNATURE')).toBe(true);
  });

  it('never resends an expired or declined agreement automatically', () => {
    expect(canTransition('EXPIRED', 'SENT_FOR_SIGNATURE')).toBe(false);
    expect(canTransition('DECLINED', 'SENT_FOR_SIGNATURE')).toBe(false);
    // A human can deliberately re-send an already-approved document.
    expect(canTransition('EXPIRED', 'READY_TO_SEND')).toBe(true);
  });

  it('treats a same-status transition as a no-op rather than an error', () => {
    expect(() => assertTransition('IN_REVIEW', 'IN_REVIEW')).not.toThrow();
  });
});

describe('database seed stays in step with the state machine', () => {
  it('matches the committed migrations exactly', () => {
    const migrationsDir = join(process.cwd(), 'packages/database/prisma/migrations');

    // Migrations are append-only, so the seed is the union of every
    // workflow_transition insert across all of them.
    const seeded = new Set<string>();
    for (const directory of readdirSync(migrationsDir)) {
      let sql: string;
      try {
        sql = readFileSync(join(migrationsDir, directory, 'migration.sql'), 'utf8');
      } catch {
        continue;
      }
      // Only the INSERT statements count; other statements in the same file
      // contain unrelated tuples such as a status IN (...) predicate.
      for (const statement of sql.matchAll(
        /INSERT INTO "workflow_transition"[\s\S]*?VALUES([\s\S]*?);/g,
      )) {
        for (const match of (statement[1] ?? '').matchAll(/\('([A-Z_]+)',\s*'([A-Z_]+)'\)/g)) {
          seeded.add(`${match[1]}->${match[2]}`);
        }
      }
    }

    const expected = new Set(transitionPairs().map(({ from, to }) => `${from}->${to}`));

    // If this fails, the state machine changed without a matching migration:
    // the application and the database would disagree about what is legal.
    expect([...seeded].sort()).toEqual([...expected].sort());
  });

  it('produces one seed row per declared transition', () => {
    const pairs = transitionPairs();
    const rows = workflowTransitionSeedSql().split('\n').filter((line) => line.trim().startsWith("('"));
    expect(rows).toHaveLength(pairs.length);
  });
});

describe('generation gate', () => {
  const base = {
    documentTypeIsProductionSupported: true,
    hasActiveTemplateVersion: true,
    compilationSelected: true,
    requiresCompilationConfirmation: true,
    blockedFeeKinds: [],
    unresolvedConflicts: 0,
    missingRequiredFields: [],
  };

  it('passes when everything is in place', () => {
    expect(evaluateGenerationGate(base).ok).toBe(true);
  });

  it('blocks a document type with no approved template', () => {
    const gate = evaluateGenerationGate({ ...base, documentTypeIsProductionSupported: false });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/no approved master template/i);
  });

  it('blocks a T2 until the compilation selection is confirmed', () => {
    const gate = evaluateGenerationGate({ ...base, compilationSelected: null });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/csrs 4200/i);
  });

  it('does not demand compilation confirmation for other engagement types', () => {
    const gate = evaluateGenerationGate({
      ...base,
      compilationSelected: null,
      requiresCompilationConfirmation: false,
    });
    expect(gate.ok).toBe(true);
  });

  it('blocks when a fee is unresolved', () => {
    const gate = evaluateGenerationGate({ ...base, blockedFeeKinds: ['T2_PREPARATION'] });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/confirmed fee/i);
  });
});

describe('approval gate', () => {
  const clean = {
    validationErrorCount: 0,
    unresolvedConflicts: 0,
    unconfirmedDates: [],
    unconfirmedFees: [],
    pendingWordingExceptions: 0,
    pendingFeeApprovals: [],
    hasRenderedDocx: true,
    hasRenderedPdf: true,
  };

  it('passes a clean draft', () => {
    expect(evaluateApprovalGate(clean).ok).toBe(true);
  });

  it('blocks on any validation error', () => {
    expect(evaluateApprovalGate({ ...clean, validationErrorCount: 1 }).ok).toBe(false);
  });

  it('blocks on an unconfirmed date', () => {
    const gate = evaluateApprovalGate({ ...clean, unconfirmedDates: ['dates.filing_due'] });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/confirmed by a reviewer/i);
  });

  it('blocks on a wording change awaiting partner approval', () => {
    expect(evaluateApprovalGate({ ...clean, pendingWordingExceptions: 1 }).ok).toBe(false);
  });

  it('blocks when a document was not rendered', () => {
    expect(evaluateApprovalGate({ ...clean, hasRenderedPdf: false }).ok).toBe(false);
  });
});

describe('send gate', () => {
  const ready = {
    status: 'READY_TO_SEND' as const,
    hasApprovedPdf: true,
    hasInternalApprovalEvent: true,
    signers: [{ name: 'Sample Officer', email: 'officer@example.test', confirmed: true, signingOrder: 1 }],
    signingOrderConfirmed: true,
    validationErrorCount: 0,
    testMode: false,
    productionSendingEnabled: true,
    sandboxConfigured: false,
  };

  it('passes when every precondition is satisfied', () => {
    expect(evaluateSendGate(ready).ok).toBe(true);
  });

  it('refuses without an explicit internal approval event', () => {
    const gate = evaluateSendGate({ ...ready, hasInternalApprovalEvent: false });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/internal approval/i);
  });

  it('refuses without an approved PDF', () => {
    expect(evaluateSendGate({ ...ready, hasApprovedPdf: false }).ok).toBe(false);
  });

  it('refuses an unconfirmed or invalid signer', () => {
    expect(evaluateSendGate({ ...ready, signers: [{ ...ready.signers[0]!, confirmed: false }] }).ok).toBe(false);
    expect(evaluateSendGate({ ...ready, signers: [{ ...ready.signers[0]!, email: 'not-an-email' }] }).ok).toBe(false);
    expect(evaluateSendGate({ ...ready, signers: [] }).ok).toBe(false);
  });

  it('refuses when the engagement is not in READY_TO_SEND', () => {
    expect(evaluateSendGate({ ...ready, status: 'DRAFT_READY' }).ok).toBe(false);
  });

  it('refuses in Test Mode with no sandbox configured', () => {
    const gate = evaluateSendGate({ ...ready, testMode: true, productionSendingEnabled: false });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/test mode/i);
  });

  it('warns but allows a sandbox send in Test Mode', () => {
    const gate = evaluateSendGate({
      ...ready,
      testMode: true,
      productionSendingEnabled: false,
      sandboxConfigured: true,
    });
    expect(gate.ok).toBe(true);
    expect(gate.warnings.join(' ')).toMatch(/no real client/i);
  });

  it('refuses a production send that an administrator has not armed', () => {
    const gate = evaluateSendGate({ ...ready, productionSendingEnabled: false });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/production sending/i);
  });
});

describe('cover-letter trigger gate', () => {
  const ready = {
    missingRequiredSourceDocuments: [],
    internalApprovalTaskComplete: true,
    status: 'READY_FOR_COVER_LETTER' as const,
    hasApprovedCoverLetterTemplate: true,
    clientIdentityMatches: true,
    periodMatches: true,
    allSourceDocumentsFinal: true,
    anySourceDocumentSuperseded: false,
    unreadableSourceDocuments: [],
    missingRequiredAmounts: [],
    missingRequiredDeadlines: [],
  };

  it('requires all three trigger conditions', () => {
    expect(evaluateCoverLetterTriggerGate(ready).ok).toBe(true);

    expect(evaluateCoverLetterTriggerGate({ ...ready, missingRequiredSourceDocuments: ['FINAL_T2_RETURN'] }).ok).toBe(
      false,
    );
    expect(evaluateCoverLetterTriggerGate({ ...ready, internalApprovalTaskComplete: false }).ok).toBe(false);
    expect(evaluateCoverLetterTriggerGate({ ...ready, status: 'COMPLETE' }).ok).toBe(false);
  });

  it('blocks when no approved cover-letter template exists', () => {
    const gate = evaluateCoverLetterTriggerGate({ ...ready, hasApprovedCoverLetterTemplate: false });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/no approved cover-letter template/i);
  });

  it('blocks on a mismatched client or period', () => {
    expect(evaluateCoverLetterTriggerGate({ ...ready, clientIdentityMatches: false }).ok).toBe(false);
    expect(evaluateCoverLetterTriggerGate({ ...ready, periodMatches: false }).ok).toBe(false);
  });

  it('blocks when a source document has been superseded or is a draft', () => {
    expect(evaluateCoverLetterTriggerGate({ ...ready, anySourceDocumentSuperseded: true }).ok).toBe(false);
    expect(evaluateCoverLetterTriggerGate({ ...ready, allSourceDocumentsFinal: false }).ok).toBe(false);
  });
});

describe('cover-letter delivery gate', () => {
  it('prevents delivery of an unapproved or stale cover letter', () => {
    expect(
      evaluateCoverLetterDeliveryGate({
        isApproved: false,
        isStale: false,
        unconfirmedFields: [],
        hasFinalDocx: true,
        hasFinalPdf: true,
      }).ok,
    ).toBe(false);

    const stale = evaluateCoverLetterDeliveryGate({
      isApproved: true,
      isStale: true,
      unconfirmedFields: [],
      hasFinalDocx: true,
      hasFinalPdf: true,
    });
    expect(stale.ok).toBe(false);
    expect(stale.blockers.join(' ')).toMatch(/source document changed/i);
  });

  it('requires every extracted value to be confirmed', () => {
    expect(
      evaluateCoverLetterDeliveryGate({
        isApproved: true,
        isStale: false,
        unconfirmedFields: ['amounts.total_balance'],
        hasFinalDocx: true,
        hasFinalPdf: true,
      }).ok,
    ).toBe(false);
  });
});
