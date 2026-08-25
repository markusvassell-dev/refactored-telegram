import type { PrismaClient } from '@element/database';
import type { JobQueue } from './jobs/queue.js';

/**
 * Queueing the Karbon search for last year's engagement letter.
 *
 * The worker has been able to do this since the first release: it searches the
 * current work item, then the prior year's work items, then the client's own
 * document area, and scores each candidate on its text rather than its
 * filename. What was missing was anybody asking.
 *
 * This lived inside the web app's server actions, private to it, which was fine
 * while a person pressing something was the only way in. A rollover starts in
 * the worker, and the second caller is exactly when a private helper becomes
 * two copies of the same guards drifting apart — so it moved here, and both
 * callers use it.
 *
 * The guards are the point. Enqueuing a job the workflow will refuse does not
 * fail at the moment somebody can see it; it fails minutes later inside the
 * worker, in a place only the log shows.
 */

/**
 * `LOCATING_SOURCE_DOCUMENTS` is the job's first act, so an engagement that has
 * already moved past extraction cannot accept it. `NOT_STARTED` is in the set,
 * which is what lets a freshly rolled-forward engagement go straight in.
 */
export const PRIOR_YEAR_SEARCH_STATES: ReadonlySet<string> = new Set([
  'NOT_STARTED',
  'SOURCE_DOCUMENT_REVIEW_REQUIRED',
  'GENERATION_FAILED',
  'NEEDS_ATTENTION',
]);

export interface PriorYearSearchOutcome {
  enqueued: boolean;
  deduplicated: boolean;
  /** Why it was not started, in words a reviewer can act on. */
  reason?: string;
}

export interface PriorYearSearchDeps {
  prisma: PrismaClient;
  queue: JobQueue;
}

export async function enqueuePriorYearSearch(
  deps: PriorYearSearchDeps,
  engagementId: string,
  correlationId: string,
  options: { force?: boolean } = {},
): Promise<PriorYearSearchOutcome> {
  const engagement = await deps.prisma.engagement.findUnique({
    where: { id: engagementId },
    select: {
      status: true,
      client: { select: { karbonEntityKey: true } },
      karbonWorkItem: { select: { karbonKey: true } },
    },
  });

  if (!engagement) return { enqueued: false, deduplicated: false, reason: 'The engagement no longer exists.' };

  // Nothing to search. Saying which link is missing is the difference between
  // a fixable message and "no documents found".
  if (!engagement.client.karbonEntityKey && !engagement.karbonWorkItem?.karbonKey) {
    return {
      enqueued: false,
      deduplicated: false,
      reason:
        'This engagement is not linked to Karbon — neither the client nor a work item carries a Karbon key — so there is nowhere to search. Attach last year’s letter below.',
    };
  }

  if (!PRIOR_YEAR_SEARCH_STATES.has(engagement.status)) {
    return {
      enqueued: false,
      deduplicated: false,
      reason: `Searching would move this engagement back to locating source documents, which is not allowed from ${engagement.status
        .replace(/_/g, ' ')
        .toLowerCase()}.`,
    };
  }

  const result = await deps.queue.enqueue({
    jobType: 'LOCATE_PRIOR_YEAR_DOCUMENTS',
    // Stable per engagement so re-running preparation does not search twice;
    // an explicit re-run asks for a fresh look and gets its own key.
    idempotencyKey: options.force
      ? `locate_prior_year_${engagementId}_${Date.now()}`
      : `locate_prior_year_${engagementId}`,
    payload: { engagementId },
    engagementId,
    correlationId,
  });

  return { enqueued: true, deduplicated: result.deduplicated };
}
