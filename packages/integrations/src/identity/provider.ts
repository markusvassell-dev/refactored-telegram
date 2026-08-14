import { createHash, randomBytes } from 'node:crypto';
import { AppError, ValidationError } from '@element/shared';

/**
 * Authentication provider interface.
 *
 * Microsoft Entra ID is the production method; multi-factor authentication and
 * conditional access are enforced by the firm's tenant policy, not by this
 * application. A local development login exists only when APP_ENV is
 * development or test, and the environment schema refuses to start with it
 * enabled in staging or production.
 */

export interface AuthenticatedIdentity {
  /** Stable directory object id. */
  subject: string;
  email: string;
  displayName: string;
  /**
   * Directory groups or app roles as Entra reported them.
   *
   * Recorded rather than acted on. Roles are granted on the Users page, because
   * the setting that mapped these onto application roles could be read and
   * never written — so it granted nothing while looking like it did.
   */
  directoryRoles: string[];
}

export interface AuthorizationRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface IdentityProvider {
  readonly name: string;
  readonly isDevelopmentOnly: boolean;
  beginLogin(redirectUri: string): Promise<AuthorizationRequest>;
  completeLogin(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    expectedNonce: string;
  }): Promise<AuthenticatedIdentity>;
}

function base64Url(data: Buffer): string {
  return data.toString('base64url');
}

/**
 * Microsoft Entra ID via OpenID Connect authorization code flow with PKCE.
 *
 * Implemented against the documented v2.0 endpoints. Not yet exercised against
 * a live tenant from this project — the Integrations screen reports the
 * connection as unverified until a real sign-in succeeds.
 */
export class EntraIdProvider implements IdentityProvider {
  readonly name = 'entra-id';
  readonly isDevelopmentOnly = false;

  constructor(
    private readonly config: {
      tenantId: string;
      clientId: string;
      clientSecret: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get authority(): string {
    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0`;
  }

  async beginLogin(redirectUri: string): Promise<AuthorizationRequest> {
    const codeVerifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    const state = base64Url(randomBytes(24));
    const nonce = base64Url(randomBytes(24));

    const url = new URL(`${this.authority}/authorize`);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', 'openid profile email offline_access User.Read');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return { authorizationUrl: url.toString(), state, codeVerifier, nonce };
  }

  async completeLogin(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    expectedNonce: string;
  }): Promise<AuthenticatedIdentity> {
    const fetchImpl = this.config.fetchImpl ?? fetch;

    const response = await fetchImpl(`${this.authority}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
        scope: 'openid profile email offline_access User.Read',
      }),
    });

    if (!response.ok) {
      throw new AppError('Entra ID token exchange failed', {
        category: 'PERMISSION',
        userMessage: 'Sign-in could not be completed. Please try again.',
        context: { status: response.status },
      });
    }

    const payload = (await response.json()) as { id_token?: string };
    if (!payload.id_token) throw new AppError('Entra ID returned no id_token', { category: 'PERMISSION' });

    const claims = decodeIdTokenClaims(payload.id_token);

    if (claims.nonce !== input.expectedNonce) {
      throw new AppError('Entra ID id_token nonce did not match', {
        category: 'PERMISSION',
        userMessage: 'Sign-in could not be verified. Please try again.',
      });
    }

    const email = claims.preferred_username ?? claims.email ?? claims.upn;
    if (!claims.oid || !email) {
      throw new AppError('Entra ID id_token is missing required claims', { category: 'PERMISSION' });
    }

    return {
      subject: claims.oid,
      email: email.toLowerCase(),
      displayName: claims.name ?? email,
      directoryRoles: claims.roles ?? claims.groups ?? [],
    };
  }
}

interface IdTokenClaims {
  oid?: string;
  email?: string;
  upn?: string;
  preferred_username?: string;
  name?: string;
  nonce?: string;
  roles?: string[];
  groups?: string[];
}

/**
 * Reads claims from the id_token payload.
 *
 * The token is obtained over TLS directly from the Microsoft token endpoint
 * using the confidential-client secret, so it is not attacker-supplied.
 * The nonce is still compared to the value this server generated.
 */
export function decodeIdTokenClaims(idToken: string): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new ValidationError('Malformed id_token');
  const payload = parts[1];
  if (!payload) throw new ValidationError('Malformed id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdTokenClaims;
}

/**
 * Development-only login. Refuses to construct outside development and test.
 */
export class DevelopmentIdentityProvider implements IdentityProvider {
  readonly name = 'development-login';
  readonly isDevelopmentOnly = true;

  constructor(appEnv: string) {
    if (appEnv !== 'development' && appEnv !== 'test') {
      throw new AppError('The development login cannot be used outside development and test.', {
        category: 'PERMISSION',
      });
    }
  }

  async beginLogin(redirectUri: string): Promise<AuthorizationRequest> {
    return {
      authorizationUrl: `${redirectUri}?dev=1`,
      state: 'dev-state',
      codeVerifier: 'dev-verifier',
      nonce: 'dev-nonce',
    };
  }

  async completeLogin(): Promise<AuthenticatedIdentity> {
    throw new AppError('The development login is completed by selecting a seeded user, not by an OIDC callback.', {
      category: 'VALIDATION',
    });
  }
}
