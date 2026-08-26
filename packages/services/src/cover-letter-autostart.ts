import type { PrismaClient } from '@element/database';
import { sourceDocumentFingerprint } from '@element/shared';
import type { CoverLetterService } from './cover-letter-service.js';
import type { JobQueue } from './jobs/queue.js';
import { SYSTEM_ACTOR_ID } from './system-actor.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * Starting the completion cover letter the moment it becomes possible.
 *
 * The whole cover-letter phase was unreachable. Its trigger gate requires the
 * engagement to be `READY_FOR_COVER_LETTER`, and **nothing anywhere moved an
 * engagement into that status** — `COMPLETE → READY_FOR_COVER_LETTER` was a
 * legal transition with no caller. So the Generate button refused every time it
 * was pressed, always for the same reason, and the cover letter, the enclosure
 * rules, the narrative editor and the delivery gate all sat behind a door
 * nobody could open.
 *
 * Two things have to be true before a cover letter can exist, and they arrive
 * in either order: the engagement letter is signed and filed, and the final
 * documents — the T2 return, the financial statements, the compilation report —
 * are uploaded and marked final. So this is called from both sides, and does
 * nothing until whichever is last lands.
 *
 * **It does not approve anything.** Generation produces a draft that a person
 * reviews; `CoverLetterService.approve` still enforces separation of duties and
 * there is still no automatic-approval path. What is automatic here is the
 * starting, which is work nobody was choosing to do — not the judgement, which
 * is work only a person should.
 */

export interface CoverLetterAutostartDeps {
  prisma: PrismaClient;
  queue: JobQueue;
  workflow: WorkflowService;
  coverLetters: CoverLetterService;
}

export interface CoverLetterAutostartOutcome {
  started: boolean;
  /** Why nothing happened, in words a reviewer can act on. Null when it did. */
  reason: string | null;
}

/**
 * Statuses from which the cover letter may be started.
 *
 * `COMPLETE` is the ordinary one: the engagement letter is signed and filed.
 * `READY_FOR_COVER_LETTER` is here so a second call after the transition but
 * before the job ran still enqueues, rather than reporting the wrong status at
 * an engagement that is in exactly the right one.
 */
const STARTABLE: ReadonlySet<string> = new Set(['COMPLETE', 'READY_FOR_COVER_LETTER']);

export async function maybeStartCoverLetter(
  deps: CoverLetterAutostartDeps,
  engagementId: string,
  correlationId?: string,
): Promise<CoverLetterAutostartOutcome> {
  const status = await deps.workflow.currentStatus(engagementId);

  if (!STARTABLE.has(status)) {
    return {
      started: false,
      reason: `The engagement is ${status}; a cover letter starts once the engagement letter is complete.`,
    };
  }

  // Every condition except the status, which is the one thing this function
  // exists to change.
  const gate = await deps.coverLetters.evaluateTriggerGate(engagementId, { assumeStatusReady: true });
  if (!gate.ok) {
    // Deliberately quiet. The workspace already renders these blockers, and
    // this runs on every document upload — a notification per upload saying
    // "still waiting for the financial statements" is noise, not news. The
    // next upload tries again.
    return { started: false, reason: gate.blockers.join(' ') };
  }

  if (status === 'COMPLETE') {
    await deps.workflow.transition({
      engagementId,
      to: 'READY_FOR_COVER_LETTER',
      userId: SYSTEM_ACTOR_ID,
      reason: 'The engagement letter is complete and the final documents are in; starting the cover letter.',
      correlationId,
    });
  }

  // Keyed on the source documents rather than the engagement alone. A cover
  // letter is a statement about a particular set of final documents, so
  // replacing one of them is a *new* letter to generate rather than a
  // duplicate of the old one — and re-running with the same documents is a
  // no-op, which is what makes calling this from five places safe.
  const sources = await deps.prisma.sourceDocument.findMany({
    where: { engagementId, includedInPackage: true },
    select: { id: true, fileHash: true },
  });
  const fingerprint = sourceDocumentFingerprint(sources);

  const enqueued = await deps.queue.enqueue({
    jobType: 'GENERATE_COVER_LETTER',
    idempotencyKey: `coverletter_auto_${engagementId}_${fingerprint}`,
    payload: { engagementId, actorId: SYSTEM_ACTOR_ID },
    engagementId,
    correlationId,
  });

  return {
    started: !enqueued.deduplicated,
    reason: enqueued.deduplicated ? 'A cover letter for these documents is already being generated.' : null,
  };
}
