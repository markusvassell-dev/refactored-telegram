/**
 * Which theme the browser has been told to use.
 *
 * Kept in a cookie rather than on the user record, so it is read server-side
 * during the render and the `data-theme` attribute is already in the HTML the
 * browser receives. That is the whole reason for the cookie: a theme applied by
 * JavaScript after hydration means every load of a dark-mode app begins with a
 * white flash, and there is no fixing that from a client component.
 *
 * The trade-off, taken deliberately: choosing dark on a laptop does not follow
 * you to a phone. The alternative — a column on `user` — cannot theme the
 * sign-in page, because nobody is signed in yet.
 *
 * Not a secret and not a state change, so it needs no CSRF token and is not
 * `httpOnly`: the toggle writes it from the browser so the change is instant,
 * and the server picks it up on the next render.
 */

export const THEME_COOKIE = 'theme';

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

/** A year. A preference nobody re-states should not quietly expire. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isTheme(value: string | undefined | null): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/**
 * The stored value, or "system" for anything else.
 *
 * "System" is the default rather than "light" on purpose: with no preference
 * recorded, matching the operating system is the answer most likely to be
 * right, and it is what a person who has never opened the toggle expects.
 * An unrecognised value — a stale cookie from an older build, or one somebody
 * edited — is treated the same way rather than trusted.
 */
export function readTheme(value: string | undefined | null): Theme {
  return isTheme(value) ? value : 'system';
}

/**
 * What to stamp on `<html>`.
 *
 * Null for "system", and the absence is load-bearing: the stylesheet's dark
 * block is a `prefers-color-scheme` media query guarded by
 * `:root:not([data-theme='light'])`, so no attribute means the operating
 * system decides. Stamping `data-theme="system"` would match neither block and
 * silently pin the app to light.
 */
export function themeAttribute(theme: Theme): 'light' | 'dark' | null {
  return theme === 'system' ? null : theme;
}
