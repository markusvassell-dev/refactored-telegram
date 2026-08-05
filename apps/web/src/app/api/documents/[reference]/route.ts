import { NextResponse } from 'next/server';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Signed temporary document download.
 *
 * Two independent checks: the caller must be signed in with permission to view
 * documents, and the link itself must carry a valid, unexpired signature. A
 * link cannot be forwarded to an outsider and cannot outlive its expiry.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ reference: string }> },
): Promise<Response> {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: 'Sign in to download documents.' }, { status: 401 });
  }

  const { reference: encoded } = await context.params;
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get('expires'));
  const signature = url.searchParams.get('signature') ?? '';

  const reference = Buffer.from(decodeURIComponent(encoded), 'base64url').toString('utf8');

  if (!container.store.verifySignedLink(reference, expires, signature)) {
    return NextResponse.json({ error: 'This download link is invalid or has expired.' }, { status: 403 });
  }

  try {
    const content = await container.store.get(reference);
    const isPdf = reference.toLowerCase().endsWith('.pdf');

    return new NextResponse(new Uint8Array(content), {
      headers: {
        'content-type': isPdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-disposition': `${isPdf ? 'inline' : 'attachment'}; filename="${reference.split('/').pop() ?? 'document'}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'This working copy has passed its retention period. Regenerate it, or open the copy in Karbon.' },
      { status: 404 },
    );
  }
}
