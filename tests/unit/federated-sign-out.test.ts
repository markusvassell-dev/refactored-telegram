import { describe, expect, it } from 'vitest';
import { DevelopmentIdentityProvider, EntraIdProvider } from '@element/integrations';
import { developmentLoginAvailable } from '../../apps/web/src/lib/dev-login';

/**
 * Signing out of Microsoft, not merely out of this application.
 *
 * Deleting the local cookie was the whole of sign-out, so Microsoft kept its
 * session in the same browser: the next person to press "Sign in with Microsoft"
 * was returned to the previous user's account with no prompt at all. On a shared
 * office machine that is the entire point of signing out, absent.
 *
 * The endpoint here is not recalled. Microsoft's discovery document at
 * `login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`
 * publishes `end_session_endpoint`, and it is `{authority}/logout` — the same
 * authority `/authorize` and `/token` are built from. Checked 2026-08-18.
 */

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const POST_LOGOUT = 'https://elementweb-production.up.railway.app/sign-in';

function provider(): EntraIdProvider {
  return new EntraIdProvider({ tenantId: TENANT, clientId: 'client', clientSecret: 'secret' });
}

describe('where a sign-out sends the browser', () => {
  it('uses the tenant end-session endpoint Microsoft publishes', () => {
    const url = new URL(provider().endSessionUrl(POST_LOGOUT));

    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/logout`);
  });

  it('carries where to come back to, encoded', () => {
    // Read back through URLSearchParams rather than asserting on the raw string:
    // what matters is that Microsoft receives the value, not how it is spelled.
    const url = new URL(provider().endSessionUrl(POST_LOGOUT));

    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(POST_LOGOUT);
  });

  it('builds the logout URL from the same authority as sign-in', () => {
    // A logout pointed at a different tenant would end a session nobody has,
    // and would look exactly like success.
    const request = provider();
    const logout = new URL(request.endSessionUrl(POST_LOGOUT));

    expect(logout.pathname.startsWith(`/${TENANT}/oauth2/v2.0/`)).toBe(true);
  });

  it('has nothing to end for the development login, and says so', () => {
    // Not a URL that would perform no sign-out while appearing to.
    expect(new DevelopmentIdentityProvider('test').endSessionUrl()).toBeNull();
  });
});

describe('whether an environment has a Microsoft session to end', () => {
  it('is true exactly where the development login is offered', () => {
    expect(developmentLoginAvailable({ DEV_LOGIN_ENABLED: true, APP_ENV: 'development' })).toBe(true);
    expect(developmentLoginAvailable({ DEV_LOGIN_ENABLED: true, APP_ENV: 'test' })).toBe(true);
  });

  it('is false in production even if the flag is left on', () => {
    // The flag alone must never be enough. A production deployment that shipped
    // with DEV_LOGIN_ENABLED set would otherwise stop federating sign-out, and
    // the failure would be invisible: sign-out would still appear to work.
    expect(developmentLoginAvailable({ DEV_LOGIN_ENABLED: true, APP_ENV: 'production' })).toBe(false);
  });

  it('is false when the flag is off, whatever the environment', () => {
    expect(developmentLoginAvailable({ DEV_LOGIN_ENABLED: false, APP_ENV: 'development' })).toBe(false);
    expect(developmentLoginAvailable({ DEV_LOGIN_ENABLED: false, APP_ENV: 'test' })).toBe(false);
    expect(developmentLoginAvailable({ DEV_LOGIN_ENABLED: false, APP_ENV: 'production' })).toBe(false);
  });
});
