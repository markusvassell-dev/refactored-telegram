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

  if (syncResult.deduplicated) {
    return NextResponse.json({ accepted: true, duplicate: true, correlationId });
  }

  // Only a configured status triggers generation.
  const triggers = await container.settings.karbonStatusTriggers();
  const matched = triggers.find(
    (trigger) =>
      trigger.status.toLowerCase() === workStatus.toLowerCase() &&
      (!trigger.workType || trigger.workType.toLowerCase() === workType.toLowerCase()),
  );

  if (!matched) {
    return NextResponse.json({ accepted: true, triggered: false, correlationId });
  }

  const engagement = await container.prisma.engagement.findFirst({
    where: { karbonWorkItem: { karbonKey: workItemKey } },
    select: { id: true, status: true },
  });

  if (!engagement) {
    return NextResponse.json({ accepted: true, triggered: false, reason: 'No engagement is linked to this work item.' });
  }

  await container.queue.enqueue({
    jobType: 'LOCATE_PRIOR_YEAR_DOCUMENTS',
    idempotencyKey: `karbon_trigger_${engagement.id}_${matched.status}`,
    payload: { engagementId: engagement.id },
    engagementId: engagement.id,
    correlationId,
  });

  return NextResponse.json({ accepted: true, triggered: true, correlationId });
}
