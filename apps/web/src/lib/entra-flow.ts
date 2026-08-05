/**
 * The short-lived state an Entra ID sign-in carries between the start route and
 * the callback.
 *
 * It lives here rather than in either route because a Next.js route file may
 * only export route handlers and route configuration.
 */

export const ENTRA_FLOW_COOKIE = 'element_entra_flow';

/** Ten minutes is generous for a redirect round trip and short enough to matter. */
export const ENTRA_FLOW_TTL_SECONDS = 600;

export interface EntraFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}
