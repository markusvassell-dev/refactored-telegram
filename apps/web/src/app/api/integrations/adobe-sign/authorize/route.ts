import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { env, randomToken, seal } from '@element/shared';
import { container } from '@/lib/container';
import { requirePermission } from '@/lib/session';
import { ADOBE_FLOW_COOKIE, ADOBE_FLOW_TTL_SECONDS, adobeRedirectUri, type AdobeFlowState } from '@/lib/adobe-oauth-flow';

export const dynamic = 'force-dynamic';

/**
 * Starts the Adobe Acrobat Sign authorisation.
 *
 * Sends an administrator to Adobe's consent screen and remembers, in a sealed
 * cookie, the one-time `state` that the callback must see returned. Without
 * that check anyone could hand this application an authorisation code of their
 * choosing and have it stored as the firm's credential.
 */
export async function GET(): Promise<Response> {
  const configuration = env();
  const actor = await requirePermission('integration:manage');

  const redirectUri = adobeRedirectUri(configuration.APP_BASE_URL);
  const state = randomToken(24);

  let authorizeUrl: string;
  try {
    authorizeUrl = await container.integrations.adobeAuthorizeUrl({ redirectUri, state, actor });
  } catch (error) {
    // A precondition failure here is an ordinary "you have not filled that in
    // yet", and belongs on the screen the person came from rather than in a
    // stack trace.
    const target = new URL('/integrations', configuration.APP_BASE_URL);
    target.searchParams.set('adobe', 'error');
    target.searchParams.set(
      'reason',
      error instanceof Error ? error.message : 'Adobe Sign could not be authorised.',
    );
    return NextResponse.redirect(target, { status: 303 });
  }

  const store = await cookies();
  const flow: AdobeFlowState = {
    state,
    redirectUri,
    expiresAt: Date.now() + ADOBE_FLOW_TTL_SECONDS * 1000,
  };

  store.set(ADOBE_FLOW_COOKIE, seal(flow, configuration.SESSION_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure: configuration.APP_BASE_URL.startsWith('https://'),
    path: '/',
    maxAge: ADOBE_FLOW_TTL_SECONDS,
  });

  return NextResponse.redirect(authorizeUrl, { status: 303 });
}
