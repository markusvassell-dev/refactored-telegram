import { NextResponse } from 'next/server';
import { EntraIdProvider } from '@element/integrations';
import { env } from '@element/shared';
import { container } from '@/lib/container';
import { developmentLoginAvailable } from '@/lib/dev-login';
import { currentUser, destroySession } from '@/lib/session';

/**
 * Signing out of this application, and out of Microsoft.
 *
 * Deleting our own cookie used to be the whole of it, which meant signing out
 * did far less than it appeared to. Microsoft kept its session in the same
 * browser, so the next person to open the application and press "Sign in with
 * Microsoft" was returned to the previous user's account immediately, with no
 * prompt and nothing on screen to suggest anything unusual had happened. On a
 * shared machine in an accounting office that is the precise situation signing
 * out exists to prevent.
 *
 * Order matters. The local session is destroyed and the event recorded *before*
 * the redirect is worked out, so a sign-out still signs the person out here even
 * if the trip to Microsoft never happens.
 */
export async function POST(): Promise<Response> {
  const configuration = env();
  const user = await currentUser().catch(() => null);
  await destroySession();

  if (user) {
    await container.audit
      .record({ eventType: 'USER_LOGOUT', objectType: 'User', objectId: user.id, userId: user.id })
      .catch(() => undefined);
  }

  const signInUrl = new URL('/sign-in', configuration.APP_BASE_URL).toString();

  // Not "whenever Entra is configured". The end-to-end suite configures a fake
  // tenant so the sign-in button renders, and federating on that would send a
  // browser to Microsoft with a tenant that does not exist — a real outbound
  // request from a suite designed to contact nobody. An environment offering the
  // development login has no Microsoft session to end.
  const federates =
    !developmentLoginAvailable(configuration) &&
    Boolean(configuration.ENTRA_TENANT_ID && configuration.ENTRA_CLIENT_ID && configuration.ENTRA_CLIENT_SECRET);

  if (federates) {
    const provider = new EntraIdProvider({
      tenantId: configuration.ENTRA_TENANT_ID as string,
      clientId: configuration.ENTRA_CLIENT_ID as string,
      clientSecret: configuration.ENTRA_CLIENT_SECRET as string,
    });

    const endSession = provider.endSessionUrl(signInUrl);
    if (endSession) return NextResponse.redirect(endSession, { status: 303 });
  }

  return NextResponse.redirect(signInUrl, { status: 303 });
}
