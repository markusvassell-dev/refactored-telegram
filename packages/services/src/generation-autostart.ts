import type { PrismaClient } from '@element/database';
import { documentTypeForEngagement, generationIdempotencyKey } from '@element/shared';
import type { GenerationService } from './generation-service.js';
import type { JobQueue } from './jobs/queue.js';
import { SYSTEM_ACTOR_ID } from './system-actor.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * Generating the engagement letter the moment it becomes possible.
 *
 * Preparation used to end by parking the engagement in
 * `SOURCE_DOCUMENT_REVIEW_REQUIRED` with the note "preparation proposes; a
 * person confirms". That was a deliberate rule, and it is being deliberately
 * changed: a Karbon status trigger is supposed to leave the firm a finished
 * draft, and stopping one step short meant every automatic rollover still
 * waited on somebody to press Generate.
 *
 * **What this does not change is who decides anything.** The draft is still
 * reviewed, still approved by a second person, and still sent only by a partner.
 * Every gate that existed before this is still in front of the client. What
 * moved is when the document is rendered, not who is accountable for it.
 *
 * The honest cost: a fee or date confirmed *after* the draft exists makes the
 * draft stale, and it has to be regenerated. That is already a supported path —
 * `REGENERATING` exists, and the send gate refuses a document whose signers
 * changed after it was rendered — so the cost is a wasted render rather than a
 * wrong letter.
 */

export interface GenerationAutostartDeps {
  prisma: PrismaClient;
  queue: JobQueue;
  workflow: WorkflowService;
  generation: GenerationService;
}

export interface GenerationAutostartOutcome {
  started: boolean;
  /** Why nothing happened, in words a reviewer can act on. Null when it did. */
  reason: string | null;
}

/**
 * Statuses from which an automatic generation may start.
 *
 * Both are states preparation can legitimately leave an engagement in. Anything
 * further along already has a draft, or is somewhere a person put it on purpose,
 * and neither is somewhere to quietly render a document.
 */
const STARTABLE: ReadonlySet<string> = new Set(['EXTRACTING_DATA', 'SOURCE_DOCUMENT_REVIEW_REQUIRED']);

export async function maybeStartGeneration(
  deps: GenerationAutostartDeps,
  engagementId: string,
  correlationId?: string,
): Promise<GenerationAutostartOutcome> {
  const status = await deps.workflow.currentStatus(engagementId);
  if (!STARTABLE.has(status)) {
    return { started: false, reason: `The engagement is ${status}; generation starts from a freshly prepared one.` };
  }

  const engagement = await deps.prisma.engagement.findUniqueOrThrow({
    where: { id: engagementId },
    select: { clientId: true, engagementType: true, taxYear: true },
  });

  const documentType = documentTypeForEngagement(engagement.engagementType);

  // The same gate the Generate button consults. Nothing is relaxed for the
  // automatic path: a missing template, an unconfirmed compilation answer or a
  // fee awaiting approval refuses here exactly as it would refuse a person.
  const gate = await deps.generation.evaluateGate(engagementId, documentType);
  if (!gate.ok) {
    // Deliberately quiet. The workspace already lists these blockers against
    // the engagement, and this runs unattended on every rollover — a
    // notification per rollover saying "waiting for a confirmed fee" is noise.
    return { started: false, reason: gate.blockers.join(' ') };
  }

  // Counted rather than assumed: the key carries an attempt number so a
  // deliberate regeneration supersedes the draft instead of deduplicating
  // against it, and re-running this after a failed render does not.
  const attempt = await deps.prisma.documentVersion.count({ where: { engagementId, documentType } });

  const enqueued = await deps.queue.enqueue({
    jobType: 'GENERATE_ENGAGEMENT_LETTER',
    idempotencyKey: generationIdempotencyKey({
      clientId: engagement.clientId,
      engagementType: engagement.engagementType,
      taxYear: engagement.taxYear,
      documentType,
      attempt: attempt + 1,
    }),
    payload: { engagementId, documentType, actorId: SYSTEM_ACTOR_ID },
    engagementId,
    correlationId,
  });

  return {
    started: !enqueued.deduplicated,
    reason: enqueued.deduplicated ? 'A draft for this engagement is already being generated.' : null,
  };
}
