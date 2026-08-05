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

/** Adobe verifies the endpoint with a GET carrying the client id header. */
export async function GET(request: Request): Promise<Response> {
  const clientId = request.headers.get('x-adobesign-clientid');
  if (!clientId) return NextResponse.json({ error: 'Missing client id header' }, { status: 400 });
  return NextResponse.json({ xAdobeSignClientId: clientId });
}
