import type { PrismaClient } from '@element/database';
import type { JobQueue } from './jobs/queue.js';

/**
 * Queueing preparation, independent of any document.
 *
 * `PREPARE_ENGAGEMENT` used to be enqueued from exactly one place: the last line
 * of `EXTRACT_DOCUMENT_TEXT`. So preparation was hostage to finding a prior-year
 * letter — and preparation is what records the client's own details, proposes
 * the signers, computes every deadline and prices the fee, none of which reads a
 * source document at all.
 *
 * The result was an engagement whose Client Information tab reported the
 * corporation's legal name outstanding because no prior-year letter had turned
 * up, when the name was sitting on the client record the whole time. The
 * application asked somebody to go and find a document before it would tell them
 * something it already knew.
 *
 * Safe to run more than once, and expected to be: `putExtractedField` never
 * rewrites a value a person has confirmed, dates and services keep their
 * confirmations, and a later run with a document in hand simply adds what the
 * document supplied.
 */

export interface PreparationEnqueueOutcome {
  enqueued: boolean;
  deduplicated: boolean;
  /** Why it was not started, in words a reviewer can act on. */
  reason?: string;
}

export interface PreparationEnqueueDeps {
  prisma: PrismaClient;
  queue: JobQueue;
}

/**
 * States where preparing again is meaningful.
 *
 * Deliberately wider than the prior-year search's set, because preparation moves
 * nothing on its own — it writes values and leaves the status alone. The states
 * left out are the ones where the letter is already with a person or a client:
 * re-pricing a fee under an approver, or under a client's pen, is not something
 * a background job should do.
 */
export const PREPARATION_STATES: ReadonlySet<string> = new Set([
  'NOT_STARTED',
  'LOCATING_SOURCE_DOCUMENTS',
  'SOURCE_DOCUMENT_REVIEW_REQUIRED',
  'EXTRACTING_DATA',
  'DRAFT_READY',
  'GENERATION_FAILED',
  'NEEDS_ATTENTION',
]);

export async function enqueuePreparation(
  deps: PreparationEnqueueDeps,
  engagementId: string,
  correlationId: string,
  options: { reason?: string; force?: boolean } = {},
): Promise<PreparationEnqueueOutcome> {
  const engagement = await deps.prisma.engagement.findUnique({
    where: { id: engagementId },
    select: { status: true },
  });

  if (!engagement) return { enqueued: false, deduplicated: false, reason: 'The engagement no longer exists.' };

  if (!PREPARATION_STATES.has(engagement.status)) {
    return {
      enqueued: false,
      deduplicated: false,
      reason: `This engagement is ${engagement.status
        .replace(/_/g, ' ')
        .toLowerCase()}, so preparing it again would rewrite values somebody is already reviewing.`,
    };
  }

  const result = await deps.queue.enqueue({
    jobType: 'PREPARE_ENGAGEMENT',
    // Distinct from the `prepare_${id}_${fileHash}` key the extraction path
    // uses, so reading a document still prepares again with what it found.
    idempotencyKey: options.force
      ? `prepare_${engagementId}_${Date.now()}`
      : `prepare_${engagementId}_initial`,
    payload: { engagementId, reason: options.reason ?? 'Preparing from the client record.' },
    engagementId,
    correlationId,
  });

  return { enqueued: true, deduplicated: result.deduplicated };
}
