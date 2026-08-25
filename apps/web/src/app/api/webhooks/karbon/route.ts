import { NextResponse } from 'next/server';
import { env, newCorrelationId, verifySignature, webhookEventIdempotencyKey } from '@element/shared';
import { container } from '@/lib/container';

export const dynamic = 'force-dynamic';

/**
 * Karbon webhook.
 *
 * Karbon events are treated as hints, never as automation commands. A work item
 * status change may *trigger* generation only when an administrator has
 * configured that exact status as a trigger; free-text comments never do.
 */
export async function POST(request: Request): Promise<Response> {
  const configuration = env();
  const rawBody = await request.text();
  const signature = request.headers.get('x-karbon-signature') ?? '';

  if (!configuration.KARBON_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Karbon webhooks are not configured.' }, { status: 503 });
  }

  if (!verifySignature(rawBody, signature, configuration.KARBON_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Malformed payload.' }, { status: 400 });
  }

  const correlationId = newCorrelationId();
  const eventId = String(payload.EventId ?? payload.eventId ?? '');
  const workItemKey = String(payload.WorkItemKey ?? payload.workItemKey ?? '');
  const workStatus = String(payload.WorkStatus ?? payload.workStatus ?? '');
  const workType = String(payload.WorkType ?? payload.workType ?? '');

  if (!eventId || !workItemKey) {
    return NextResponse.json({ accepted: false, reason: 'The event carried no work item.' }, { status: 400 });
  }

  // Refresh our copy of the work item regardless of what the event says.
  const syncResult = await container.queue.enqueue({
    jobType: 'KARBON_SYNC',
    idempotencyKey: webhookEventIdempotencyKey('karbon', eventId),
    payload: { workItemKey },
    correlationId,
  });

  // A redelivery of the same event no longer ends the request here.
  //
  // Returning early on a deduplicated sync was safe while the only thing below
  // was a search that would be re-run anyway. It is not safe now: the work
  // below decides whether an engagement gets created, and a vendor redelivering
  // an event it thinks failed would silently skip that. Every enqueue below
  // carries its own deterministic key, which is the right place for
  // deduplication to happen — once per unit of work rather than once per
  // delivery.
  const duplicateDelivery = syncResult.deduplicated;

  // Only a configured status triggers anything.
  const triggers = await container.settings.karbonStatusTriggers();
  const matched = triggers.find(
    (trigger) =>
      trigger.status.toLowerCase() === workStatus.toLowerCase() &&
      (!trigger.workType || trigger.workType.toLowerCase() === workType.toLowerCase()),
  );

  if (!matched) {
    return NextResponse.json({ accepted: true, triggered: false, duplicateDelivery, correlationId });
  }

  // Whether or not an engagement exists yet.
  //
  // This used to look for one already linked to the work item and, finding
  // none, report that and stop — which is every rollover, because next year's
  // work item has no engagement until something makes one. The whole pipeline
  // behind this point was reachable only for engagements somebody had already
  // created by hand.
  //
  // The decision moves into `ROLL_OVER_ENGAGEMENT`, which reads the work item
  // fresh rather than depending on the `KARBON_SYNC` queued above having run
  // first, and converges on the existing engagement when there is one.
  await container.queue.enqueue({
    jobType: 'ROLL_OVER_ENGAGEMENT',
    // Unchanged in shape from the key this route has always used: the work item
    // plus the status that matched, so a work item moving through two
    // configured statuses is evaluated twice and a redelivery is not.
    idempotencyKey: `rollover_${workItemKey}_${matched.status}`,
    payload: {
      workItemKey,
      engagementType: matched.engagementType,
      triggerStatus: matched.status,
    },
    correlationId,
  });

  return NextResponse.json({ accepted: true, triggered: true, duplicateDelivery, correlationId });
}
