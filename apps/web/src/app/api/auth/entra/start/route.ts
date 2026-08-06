import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { EntraIdProvider } from '@element/integrations';
import { describeEntraConfigurationProblem, env, seal } from '@element/shared';
import { ENTRA_FLOW_COOKIE, ENTRA_FLOW_TTL_SECONDS, type EntraFlowState } from '@/lib/entra-flow';

export const dynamic = 'force-dynamic';

/**
 * Begins Microsoft Entra ID sign-in.
 *
 * The `state`, `nonce` and PKCE verifier are generated here and sealed into a
 * short-lived cookie, so the callback can prove the response belongs to a flow
 * this server actually started.
 */
export async function POST(): Promise<Response> {
  const configuration = env();

  // A set-but-wrong value is refused here as firmly as a missing one. The
  // sign-in button is disabled when the configuration is bad, but the button is
  // not the guard — this route builds the Microsoft URL, so it is the last
  // place that can decline to send somebody to a vendor to be told
  // AADSTS900023 about a mistake that is visible from here.
  const problem = describeEntraConfigurationProblem({
    tenantId: configuration.ENTRA_TENANT_ID,
    clientId: configuration.ENTRA_CLIENT_ID,
    clientSecret: configuration.ENTRA_CLIENT_SECRET,
  });

  if (problem || !configuration.ENTRA_TENANT_ID || !configuration.ENTRA_CLIENT_ID || !configuration.ENTRA_CLIENT_SECRET) {
    return NextResponse.json(
      { error: `Microsoft Entra ID is not configured in this environment. ${problem ?? ''}`.trim() },
      { status: 503 },
    );
  }

  const redirectUri =
    configuration.ENTRA_REDIRECT_URI ?? new URL('/api/auth/entra/callback', configuration.APP_BASE_URL).toString();

  const provider = new EntraIdProvider({
    tenantId: configuration.ENTRA_TENANT_ID,
    clientId: configuration.ENTRA_CLIENT_ID,
    clientSecret: configuration.ENTRA_CLIENT_SECRET,
  });

  const request = await provider.beginLogin(redirectUri);

  const flow: EntraFlowState = {
    state: request.state,
    nonce: request.nonce,
    codeVerifier: request.codeVerifier,
    redirectUri,
    expiresAt: Date.now() + ENTRA_FLOW_TTL_SECONDS * 1000,
  };

  const store = await cookies();
  store.set(ENTRA_FLOW_COOKIE, seal(flow, configuration.SESSION_SECRET, 'entra-flow'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: configuration.APP_ENV !== 'development',
    path: '/',
    maxAge: ENTRA_FLOW_TTL_SECONDS,
  });

  return NextResponse.redirect(request.authorizationUrl, { status: 303 });
}
