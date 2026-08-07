/**
 * The short-lived state an Adobe Sign authorisation carries between the start
 * route and the callback.
 *
 * It lives here rather than in either route because a Next.js route file may
 * only export route handlers and route configuration.
 */

export const ADOBE_FLOW_COOKIE = 'element_adobe_flow';

/** Ten minutes is generous for a consent screen and short enough to matter. */
export const ADOBE_FLOW_TTL_SECONDS = 600;

export interface AdobeFlowState {
  state: string;
  /**
   * Recorded rather than rebuilt. Adobe checks the redirect URI at the token
   * exchange against the one used at authorisation, so a value that changed in
   * between — a renamed domain, a different environment — must fail loudly
   * rather than silently produce a mismatch nobody can explain.
   */
  redirectUri: string;
  expiresAt: number;
}

/** The callback Adobe is told to return to. Registered in the API application. */
export function adobeRedirectUri(baseUrl: string): string {
  return new URL('/api/integrations/adobe-sign/callback', baseUrl).toString();
}
