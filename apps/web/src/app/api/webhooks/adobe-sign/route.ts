import { NextResponse } from 'next/server';
import { newCorrelationId } from '@element/shared';
import { container } from '@/lib/container';

export const dynamic = 'force-dynamic';

/**
 * Adobe Acrobat Sign webhook.
 *
 * The payload is verified before it is trusted, and a duplicate delivery of the
 * same provider event id is recorded and ignored rather than processed twice.
 *
 * Always responds 200 for a verified request, including duplicates: Adobe
 * retries anything else, and a retry storm helps nobody.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  const headerRecord: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headerRecord[key.toLowerCase()] = value;
  });

  const providers = await container.providers();
  const correlationId = newCorrelationId();

  try {
    const result = await container.signing.processWebhook({
      rawBody,
      headers: headerRecord,
      adobeSign: providers.adobeSign,
      correlationId,
    });

    if (!result.handled && !result.duplicate) {
      container.logger.warn('Adobe webhook rejected', { reason: result.reason, correlationId });
      // A signature failure is a client error and must not be retried.
      return NextResponse.json({ accepted: false, reason: result.reason }, { status: 400 });
    }

    return NextResponse.json({ accepted: true, duplicate: result.duplicate, correlationId });
  } catch (error) {
    container.logger.error('Adobe webhook processing failed', {
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
    // Let Adobe retry a genuine server-side failure.
    return NextResponse.json({ accepted: false }, { status: 500 });
  }
}

/**
 * Adobe verifies the endpoint with a GET carrying the client id header.
 *
 * The header is checked against the configured client id before it is echoed.
 * This used to echo whatever it was sent, which defeats the point of the
 * handshake: Adobe's check exists to confirm that this endpoint belongs to the
 * application registering it, and an endpoint that agrees to every client id
 * confirms nothing. Any Adobe account could register this URL and start
 * delivering its events here.
 *
 * Those deliveries were already refused — the POST above verifies each one — so
 * this closes a door rather than an open path. But an endpoint that accepts a
 * registration it will then reject every event from is a source of retries and
 * of log entries that look like an attack when they are a misconfiguration.
 *
 * Verified through the provider's own `verifyWebhook`, with an empty body,
 * rather than a comparison written a second time here: the handshake and the
 * deliveries have to agree about which client id is ours.
 */
export async function GET(request: Request): Promise<Response> {
  const clientId = request.headers.get('x-adobesign-clientid');
  if (!clientId) return NextResponse.json({ error: 'Missing client id header' }, { status: 400 });

  const providers = await container.providers();
  if (!providers.adobeSign.verifyWebhook('', { 'x-adobesign-clientid': clientId })) {
    container.logger.warn("Adobe webhook verification refused: client id is not this deployment's", {
      // The value is Adobe's own identifier for an application, not a secret,
      // and knowing which one asked is the whole diagnosis.
      presentedClientId: clientId,
    });
    return NextResponse.json({ error: 'That client id is not configured for this deployment.' }, { status: 403 });
  }

  return NextResponse.json({ xAdobeSignClientId: clientId });
}
