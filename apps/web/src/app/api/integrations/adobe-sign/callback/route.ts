import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { env, unseal } from '@element/shared';
import { container } from '@/lib/container';
import { requirePermission } from '@/lib/session';
import { ADOBE_FLOW_COOKIE, type AdobeFlowState } from '@/lib/adobe-oauth-flow';

export const dynamic = 'force-dynamic';

/**
 * Completes the Adobe Acrobat Sign authorisation.
 *
 * This is the route the setup guide has always told people to register as the
 * redirect URI, and which did not exist — so anyone following the guide
 * registered a URI that answered 404, and had no way to tell whether the fault
 * was theirs, Adobe's, or the application's.
 *
 * The authorisation code is exchanged server-side and the refresh token is
 * stored encrypted. It is never rendered, never logged, and never travels
 * through a clipboard.
 */
export async function GET(request: Request): Promise<Response> {
  const configuration = env();
  const store = await cookies();
  const url = new URL(request.url);

  const finish = (params: Record<string, string>): Response => {
    store.delete(ADOBE_FLOW_COOKIE);
    const target = new URL('/integrations', configuration.APP_BASE_URL);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return NextResponse.redirect(target, { status: 303 });
  };

  // Adobe redirects a browser here, so the person must still be the signed-in
  // administrator who started it. A redirect from a vendor is not authority.
  const actor = await requirePermission('integration:manage');

  const providerError = url.searchParams.get('error');
  if (providerError) {
    container.logger.warn('Adobe Sign authorisation was refused', { reason: providerError });
    return finish({
      adobe: 'error',
      reason: 'Adobe refused the authorisation. The commonest cause is a scope the account may not grant.',
    });
  }

  const sealed = store.get(ADOBE_FLOW_COOKIE)?.value;
  const flow = sealed ? unseal<AdobeFlowState>(sealed, configuration.SESSION_SECRET) : null;

  if (!flow) {
    return finish({ adobe: 'error', reason: 'That authorisation could not be verified. Start it again.' });
  }
  if (flow.expiresAt < Date.now()) {
    return finish({ adobe: 'error', reason: 'That authorisation expired before it completed. Start it again.' });
  }

  const state = url.searchParams.get('state');
  if (!state || state !== flow.state) {
    // The check that stops somebody else's authorisation code being stored as
    // this firm's credential.
    container.logger.warn('Adobe Sign callback state did not match');
    return finish({ adobe: 'error', reason: 'That authorisation could not be verified. Start it again.' });
  }

  const code = url.searchParams.get('code');
  if (!code) return finish({ adobe: 'error', reason: 'Adobe returned no authorisation code.' });

  try {
    await container.integrations.completeAdobeOAuth({ code, redirectUri: flow.redirectUri, actor });
  } catch (error) {
    container.logger.error('Adobe Sign token exchange failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return finish({
      adobe: 'error',
      reason: error instanceof Error ? error.message : 'The authorisation could not be completed.',
    });
  }

  return finish({ adobe: 'connected' });
}
