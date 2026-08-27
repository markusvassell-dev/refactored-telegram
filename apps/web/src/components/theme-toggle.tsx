'use client';

import { useState, type ReactNode } from 'react';
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, THEMES, themeAttribute, type Theme } from '@/lib/theme';

/**
 * Light, dark, or whatever the operating system says.
 *
 * The attribute is flipped here and the cookie written here, in the same
 * handler, so the change happens at once. No server action, no revalidation and
 * no round trip: a theme is a presentation preference, not application state,
 * and treating it as state would mean a full re-render of the page to change a
 * colour.
 *
 * The server still reads the cookie on the next render, which is what keeps the
 * following page loads flash-free. The two are consistent because they write
 * and read the same three values.
 */

const LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function ThemeToggle({ current }: { current: Theme }): ReactNode {
  // Seeded from the server so the control agrees with the page it is on, then
  // owned here — the server value cannot change without a navigation.
  const [theme, setTheme] = useState<Theme>(current);

  function choose(next: Theme) {
    setTheme(next);

    const attribute = themeAttribute(next);
    if (attribute) {
      document.documentElement.dataset.theme = attribute;
    } else {
      // Removed rather than set to "system". The stylesheet's dark rules are a
      // `prefers-color-scheme` query guarded by `:not([data-theme='light'])`,
      // so only the absence of the attribute lets the system decide.
      delete document.documentElement.dataset.theme;
    }

    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Colour theme">
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => choose(option)}
          aria-pressed={theme === option}
          className={
            theme === option
              ? 'rounded px-2 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-400'
              : 'rounded px-2 py-1 text-xs text-slate-500 hover:text-slate-700'
          }
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
