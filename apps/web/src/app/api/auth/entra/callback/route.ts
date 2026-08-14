import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { EntraIdProvider } from '@element/integrations';
import { env, randomToken, unseal } from '@element/shared';
import { container } from '@/lib/container';
import { createSession, requestContext } from '@/lib/session';
import { ENTRA_FLOW_COOKIE, type EntraFlowState } from '@/lib/entra-flow';
import { grantBootstrapAdministrator } from '@/lib/bootstrap-admin';

export const dynamic = 'force-dynamic';

/**
 * Completes Microsoft Entra ID sign-in.
 *
 * Every response value is checked against the flow this server started: the
 * `state` must match, the flow must not have expired, and the id_token `nonce`
 * is verified inside the provider before any claim is trusted.
 *
 * Signing in proves who somebody is; it grants them nothing. Roles are assigned
 * on the Users page by an administrator, so a new person arrives with no
 * permissions rather than accidental ones, and `BOOTSTRAP_ADMIN_EMAILS` exists
 * to break the circle for the very first administrator.
 */
export async function GET(request: Request): Promise<Response> {
  const configuration = env();
  const store = await cookies();
  const url = new URL(request.url);

  // Always redirects back to sign-in with a safe reason; the technical detail
  // stays in the server log.
  const failure = (reason: string): Response => {
    container.logger.warn('Entra sign-in rejected', { reason });
    store.delete(ENTRA_FLOW_COOKIE);
    const target = new URL('/sign-in', configuration.APP_BASE_URL);
    target.searchParams.set('error', reason);
    return NextResponse.redirect(target, { status: 303 });
  };

  const providerError = url.searchParams.get('error');
  if (providerError) return failure('the identity provider returned an error');

  const sealed = store.get(ENTRA_FLOW_COOKIE)?.value;
  if (!sealed) return failure('the sign-in request could not be verified; please try again');

  const flow = unseal<EntraFlowState>(sealed, configuration.SESSION_SECRET);
  if (!flow) return failure('the sign-in request could not be verified; please try again');
  if (flow.expiresAt < Date.now()) return failure('the sign-in request expired; please try again');

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || state !== flow.state) return failure('the sign-in request could not be verified; please try again');
  if (!code) return failure('the identity provider returned no authorization code');

  if (!configuration.ENTRA_TENANT_ID || !configuration.ENTRA_CLIENT_ID || !configuration.ENTRA_CLIENT_SECRET) {
    return failure('Microsoft Entra ID is not configured');
  }

  const provider = new EntraIdProvider({
    tenantId: configuration.ENTRA_TENANT_ID,
    clientId: configuration.ENTRA_CLIENT_ID,
    clientSecret: configuration.ENTRA_CLIENT_SECRET,
  });

  let identity;
  try {
    identity = await provider.completeLogin({
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      expectedNonce: flow.nonce,
    });
  } catch {
    return failure('sign-in could not be completed; please try again');
  }

  store.delete(ENTRA_FLOW_COOKIE);

  // Match on the directory object id first: an email address can change, an
  // object id does not.
  const existing =
    (await container.prisma.user.findUnique({ where: { entraObjectId: identity.subject } })) ??
    (await container.prisma.user.findUnique({ where: { email: identity.email } }));

  const user = existing
    ? await container.prisma.user.update({
        where: { id: existing.id },
        data: {
          entraObjectId: identity.subject,
          email: identity.email,
          displayName: identity.displayName,
          lastLoginAt: new Date(),
        },
      })
    : await container.prisma.user.create({
        data: {
          entraObjectId: identity.subject,
          email: identity.email,
          displayName: identity.displayName,
          lastLoginAt: new Date(),
        },
      });

  if (!user.isActive) {
    return failure('this account has been deactivated');
  }

  // Only reachable once Entra ID has authenticated the address; see
  // lib/bootstrap-admin.ts for why this path exists at all.
  const bootstrap = await grantBootstrapAdministrator({
    prisma: container.prisma,
    audit: container.audit,
    authenticatedEmail: identity.email,
    userId: user.id,
    configuredEmails: configuration.BOOTSTRAP_ADMIN_EMAILS,
  });

  if (bootstrap.granted) {
    container.logger.warn('Granted ADMINISTRATOR from BOOTSTRAP_ADMIN_EMAILS', { userId: user.id });
  }

  await createSession(user.id, randomToken(24));

  const context = await requestContext();
  await container.audit.record({
    eventType: 'USER_LOGIN',
    objectType: 'User',
    objectId: user.id,
    userId: user.id,
    afterValue: {
      method: 'entra-id',
      isNewUser: !existing,
    },
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return NextResponse.redirect(new URL('/', configuration.APP_BASE_URL), { status: 303 });
}
