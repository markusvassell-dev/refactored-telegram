import { PreconditionError } from '@element/shared';

/**
 * The engagement workflow state machine.
 *
 * This module is the single source of truth for legal status transitions. The
 * same map is seeded into the `workflow_transition` table so that a database
 * trigger rejects an illegal transition even if it is attempted outside the
 * application. `workflowTransitionSeedSql()` generates that seed, and a test
 * asserts the committed migration still matches this map.
 */

export const ENGAGEMENT_STATUSES = [
  'NOT_STARTED',
  'LOCATING_SOURCE_DOCUMENTS',
  'SOURCE_DOCUMENT_REVIEW_REQUIRED',
  'EXTRACTING_DATA',
  'GENERATING',
  'GENERATION_FAILED',
  'DRAFT_READY',
  'REVIEW_REQUIRED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'REGENERATING',
  'APPROVED',
  'READY_TO_SEND',
  'SENDING_FOR_SIGNATURE',
  'SENT_FOR_SIGNATURE',
  'PARTIALLY_SIGNED',
  'SIGNED',
  'DECLINED',
  'EXPIRED',
  'NEEDS_ATTENTION',
  'COMPLETE',
  'READY_FOR_COVER_LETTER',
  'COVER_LETTER_GENERATING',
  'COVER_LETTER_REVIEW_REQUIRED',
  'COVER_LETTER_IN_REVIEW',
  'COVER_LETTER_CHANGES_REQUESTED',
  'COVER_LETTER_APPROVED',
  'READY_FOR_DELIVERY',
  'DELIVERED',
] as const;

export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

/**
 * Allowed transitions.
 *
 * Deliberate omissions:
 *  - DRAFT_READY can never reach SENT_FOR_SIGNATURE (or READY_TO_SEND) without
 *    passing through review and APPROVED.
 *  - Nothing may jump directly into APPROVED except IN_REVIEW.
 *  - Nothing may jump directly into COVER_LETTER_APPROVED except
 *    COVER_LETTER_IN_REVIEW.
 *  - NEEDS_ATTENTION can recover to operational states but never straight to
 *    an approval state.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<EngagementStatus, readonly EngagementStatus[]>> = {
  NOT_STARTED: ['LOCATING_SOURCE_DOCUMENTS', 'EXTRACTING_DATA', 'GENERATING', 'NEEDS_ATTENTION'],

  LOCATING_SOURCE_DOCUMENTS: [
    'SOURCE_DOCUMENT_REVIEW_REQUIRED',
    'EXTRACTING_DATA',
    'GENERATION_FAILED',
    'NEEDS_ATTENTION',
  ],

  SOURCE_DOCUMENT_REVIEW_REQUIRED: ['LOCATING_SOURCE_DOCUMENTS', 'EXTRACTING_DATA', 'NEEDS_ATTENTION'],

  EXTRACTING_DATA: ['GENERATING', 'SOURCE_DOCUMENT_REVIEW_REQUIRED', 'GENERATION_FAILED', 'NEEDS_ATTENTION'],

  GENERATING: ['DRAFT_READY', 'GENERATION_FAILED', 'NEEDS_ATTENTION'],

  GENERATION_FAILED: ['GENERATING', 'REGENERATING', 'LOCATING_SOURCE_DOCUMENTS', 'NEEDS_ATTENTION'],

  DRAFT_READY: ['REVIEW_REQUIRED', 'REGENERATING', 'NEEDS_ATTENTION'],

  REVIEW_REQUIRED: ['IN_REVIEW', 'CHANGES_REQUESTED', 'NEEDS_ATTENTION'],

  IN_REVIEW: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'NEEDS_ATTENTION'],

  CHANGES_REQUESTED: ['REGENERATING', 'IN_REVIEW', 'NEEDS_ATTENTION'],

  REGENERATING: ['DRAFT_READY', 'GENERATION_FAILED', 'NEEDS_ATTENTION'],

  APPROVED: ['READY_TO_SEND', 'CHANGES_REQUESTED', 'NEEDS_ATTENTION'],

  // SIGNED without passing through SENDING_FOR_SIGNATURE is the bridge for a
  // signature obtained outside this application — the only way an approved
  // letter becomes a signed one while the firm has Acrobat Pro (no API) rather
  // than Acrobat Sign Solutions (API). It is not a shortcut around review:
  // READY_TO_SEND is already past final approval. The database refuses this
  // transition unless an external_signature row with evidence exists.
  READY_TO_SEND: ['SENDING_FOR_SIGNATURE', 'SIGNED', 'CHANGES_REQUESTED', 'NEEDS_ATTENTION'],

  SENDING_FOR_SIGNATURE: ['SENT_FOR_SIGNATURE', 'READY_TO_SEND', 'NEEDS_ATTENTION'],

  SENT_FOR_SIGNATURE: ['PARTIALLY_SIGNED', 'SIGNED', 'DECLINED', 'EXPIRED', 'NEEDS_ATTENTION'],

  PARTIALLY_SIGNED: ['SIGNED', 'DECLINED', 'EXPIRED', 'NEEDS_ATTENTION'],

  SIGNED: ['COMPLETE', 'NEEDS_ATTENTION'],

  // A declined agreement is never auto-resent; a human decides what happens.
  DECLINED: ['REGENERATING', 'NEEDS_ATTENTION'],

  // An expired agreement creates a renewal task; the approved document may be
  // re-sent deliberately, but nothing resends automatically.
  EXPIRED: ['READY_TO_SEND', 'REGENERATING', 'NEEDS_ATTENTION'],

  NEEDS_ATTENTION: [
    'LOCATING_SOURCE_DOCUMENTS',
    'SOURCE_DOCUMENT_REVIEW_REQUIRED',
    'EXTRACTING_DATA',
    'GENERATING',
    'GENERATION_FAILED',
    'REGENERATING',
    'DRAFT_READY',
    'REVIEW_REQUIRED',
    'IN_REVIEW',
    'CHANGES_REQUESTED',
    'READY_TO_SEND',
    'SENDING_FOR_SIGNATURE',
    'SENT_FOR_SIGNATURE',
    'PARTIALLY_SIGNED',
    'SIGNED',
    'DECLINED',
    'EXPIRED',
    'COMPLETE',
    'READY_FOR_COVER_LETTER',
    'COVER_LETTER_GENERATING',
    'COVER_LETTER_REVIEW_REQUIRED',
    'COVER_LETTER_IN_REVIEW',
    'COVER_LETTER_CHANGES_REQUESTED',
    'READY_FOR_DELIVERY',
    'DELIVERED',
  ],

  COMPLETE: ['READY_FOR_COVER_LETTER', 'NEEDS_ATTENTION'],

  READY_FOR_COVER_LETTER: ['COVER_LETTER_GENERATING', 'NEEDS_ATTENTION'],

  COVER_LETTER_GENERATING: ['COVER_LETTER_REVIEW_REQUIRED', 'GENERATION_FAILED', 'NEEDS_ATTENTION'],

  // CHANGES_REQUESTED is reachable directly because a source document can be
  // replaced while the cover letter is still sitting in the review queue.
  COVER_LETTER_REVIEW_REQUIRED: ['COVER_LETTER_IN_REVIEW', 'COVER_LETTER_CHANGES_REQUESTED', 'NEEDS_ATTENTION'],

  COVER_LETTER_IN_REVIEW: ['COVER_LETTER_APPROVED', 'COVER_LETTER_CHANGES_REQUESTED', 'NEEDS_ATTENTION'],

  COVER_LETTER_CHANGES_REQUESTED: ['COVER_LETTER_GENERATING', 'COVER_LETTER_IN_REVIEW', 'NEEDS_ATTENTION'],

  COVER_LETTER_APPROVED: ['READY_FOR_DELIVERY', 'COVER_LETTER_CHANGES_REQUESTED', 'NEEDS_ATTENTION'],

  READY_FOR_DELIVERY: ['DELIVERED', 'COVER_LETTER_CHANGES_REQUESTED', 'NEEDS_ATTENTION'],

  // A stale source document sends an already-delivered package back for review.
  // Delivery is not undone by it — the files are in the client's Karbon
  // documents and this application cannot unsend them — but the engagement
  // stops reading as finished until somebody regenerates and approves again.
  DELIVERED: ['COVER_LETTER_CHANGES_REQUESTED', 'NEEDS_ATTENTION'],
};

/** Statuses that represent an explicit internal approval having occurred. */
export const APPROVAL_STATUSES: readonly EngagementStatus[] = [
  'APPROVED',
  'READY_TO_SEND',
  'SENDING_FOR_SIGNATURE',
  'SENT_FOR_SIGNATURE',
  'PARTIALLY_SIGNED',
  'SIGNED',
  'COMPLETE',
  'COVER_LETTER_APPROVED',
  'READY_FOR_DELIVERY',
  'DELIVERED',
];

/** Statuses where a reviewer is expected to act. Drives the Review Queue. */
export const REVIEW_QUEUE_STATUSES: readonly EngagementStatus[] = [
  'SOURCE_DOCUMENT_REVIEW_REQUIRED',
  'REVIEW_REQUIRED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'COVER_LETTER_REVIEW_REQUIRED',
  'COVER_LETTER_IN_REVIEW',
  'COVER_LETTER_CHANGES_REQUESTED',
];

export function canTransition(from: EngagementStatus, to: EngagementStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: EngagementStatus, to: EngagementStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new PreconditionError(`Cannot move an engagement from ${from} to ${to}.`, { from, to });
  }
}

export function nextStatuses(from: EngagementStatus): readonly EngagementStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

/** Flattened (from, to) pairs in a deterministic order. */
export function transitionPairs(): { from: EngagementStatus; to: EngagementStatus }[] {
  const pairs: { from: EngagementStatus; to: EngagementStatus }[] = [];
  for (const from of ENGAGEMENT_STATUSES) {
    for (const to of ALLOWED_TRANSITIONS[from] ?? []) {
      pairs.push({ from, to });
    }
  }
  return pairs;
}

/**
 * Generates the deterministic seed for the `workflow_transition` table.
 * The committed migration must contain exactly this text.
 */
export function workflowTransitionSeedSql(): string {
  const values = transitionPairs()
    .map(({ from, to }) => `  ('${from}', '${to}')`)
    .join(',\n');

  return [
    'INSERT INTO "workflow_transition" ("fromStatus", "toStatus") VALUES',
    values + '',
    'ON CONFLICT DO NOTHING;',
  ].join('\n');
}
