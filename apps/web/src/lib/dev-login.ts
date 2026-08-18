/**
 * Whether this environment offers the development login.
 *
 * One predicate, because two places need the same answer and disagreeing would
 * be worse than either answer alone:
 *
 *   - `/api/auth/dev-login` refuses unless it is true, so a seeded user cannot
 *     be assumed anywhere real.
 *   - `/api/auth/sign-out` federates to Microsoft only when it is **false**.
 *     Signing out has to end the identity provider's session too, but an
 *     environment that hands out sessions by picking a name from a list has no
 *     Microsoft session to end — and the end-to-end suite is exactly that
 *     environment, configured with a fake tenant so the sign-in button renders.
 *     Federating there would send a browser to `login.microsoftonline.com` with
 *     a tenant that does not exist, from a suite whose whole design is that it
 *     contacts no vendor.
 *
 * Structurally typed rather than taking the whole configuration, so a test can
 * ask the question without constructing an environment.
 */
export function developmentLoginAvailable(configuration: {
  DEV_LOGIN_ENABLED: boolean;
  APP_ENV: string;
}): boolean {
  return configuration.DEV_LOGIN_ENABLED && ['development', 'test'].includes(configuration.APP_ENV);
}
