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

/*
 * `enqueuePriorYearSearch` was here, and is deliberately gone.
 *
 * The scan below reads the same three scopes, scores the same candidates and
 * hands them to the same chooser — so keeping a second button that searched the
 * same places more narrowly would have asked a reviewer to know which of two
 * searches they wanted. Every caller now enqueues the scan.
 *
 * It could not simply stay unused: the reachability guard reads these files for
 * `jobType:` strings, so an enqueue helper nothing calls would have gone on
 * reporting `LOCATE_PRIOR_YEAR_DOCUMENTS` as reachable. A guard satisfied by a
 * dead reference is worse than the dead code, because it is the one thing that
 * was supposed to notice.
 *
 * Its handler survives as a shim that enqueues the scan, for rows already in
 * flight in the live database when this ships; that is what the guard's
 * unreachable-by-design list now records, and it can be deleted a release later.
 */


/**
 * Queueing the scan of everything Karbon holds for this client.
 *
 * The same guards as the search above, and the same states: a scan begins by
 * locating documents, so an engagement already past extraction cannot accept
 * one. Deliberately a sibling rather than a replacement — the search answers a
 * narrower question and stays available on its own button.
 */
export async function enqueueClientDocumentScan(
  deps: PriorYearSearchDeps,
  engagementId: string,
  correlationId: string,
  options: { force?: boolean; actorId?: string | null } = {},
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

  if (!engagement.client.karbonEntityKey && !engagement.karbonWorkItem?.karbonKey) {
    return {
      enqueued: false,
      deduplicated: false,
      reason:
        'This engagement is not linked to Karbon — neither the client nor a work item carries a Karbon key — so there is nothing to read. Attach documents by hand below.',
    };
  }

  if (!PRIOR_YEAR_SEARCH_STATES.has(engagement.status)) {
    return {
      enqueued: false,
      deduplicated: false,
      reason: `Reading the client's documents would move this engagement back to locating source documents, which is not allowed from ${engagement.status
        .replace(/_/g, ' ')
        .toLowerCase()}.`,
    };
  }

  const result = await deps.queue.enqueue({
    jobType: 'SCAN_CLIENT_DOCUMENTS',
    // Stable per engagement per day, so the automatic run and a person pressing
    // Prepare do not read the whole library twice; an explicit re-run asks for
    // a fresh look and gets its own key.
    idempotencyKey: options.force
      ? `scan_documents_${engagementId}_${Date.now()}`
      : `scan_documents_${engagementId}_${new Date().toISOString().slice(0, 10)}`,
    payload: { engagementId, actorId: options.actorId ?? null },
    engagementId,
    correlationId,
  });

  return { enqueued: true, deduplicated: result.deduplicated };
}
