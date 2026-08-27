import type { Config } from 'tailwindcss';

/**
 * The palette, and why it is built this way.
 *
 * Adding a dark mode the ordinary way would have meant writing a `dark:`
 * variant beside each of the 564 hardcoded colour utilities in this app — an
 * unreviewable diff that would then double the cost of every future style
 * change, for ever.
 *
 * So instead of adding a second colour to every element, the colours themselves
 * are redefined. Each step reads a CSS variable, and `globals.css` gives those
 * variables different values per theme. Existing markup flips with no change at
 * all.
 *
 * That only works because this app uses the scale **semantically and
 * consistently**: low steps (50–200) are always fills, middle steps (200–500)
 * are always borders, high steps (500–900) are always ink. `STATUS_TONES` in
 * `components/shell.tsx` is the pattern in miniature — `bg-red-100
 * text-red-800` becomes a dark red fill with light red ink without being
 * touched. Anything that broke that convention would come out wrong in dark, so
 * the convention is now load-bearing rather than tidy.
 *
 * ## Every step is enumerated on purpose
 *
 * Overriding a colour in `theme.extend.colors` replaces the whole scale rather
 * than merging into it, so a step left out here silently stops existing — the
 * class generates nothing and the element renders with no colour at all. All of
 * 50–950 are defined for each hue even where the app currently uses six of
 * them, because the failure mode of forgetting one is invisible.
 *
 * This is not hypothetical: `brand` previously defined only 50, 100, 500, 600
 * and 700, while `shell.tsx` and the templates page ask for `text-brand-800`,
 * `bg-brand-200` and `ring-brand-400`. Those three classes have never existed,
 * so the notification pill has no text colour of its own and the active-template
 * badge has no ring. Filling the ramp fixes both.
 */

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** A full scale wired to CSS variables, so `globals.css` decides the values. */
function themed(name: string): Record<string, string> {
  return Object.fromEntries(STEPS.map((step) => [String(step), `rgb(var(--${name}-${step}) / <alpha-value>)`]));
}

export default {
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  // The attribute rather than a class, because the root layout stamps it
  // server-side from a cookie — which is what makes the first painted frame the
  // right theme instead of a flash of the wrong one.
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Card, nav and header backgrounds. A separate token rather than
        // `white`, because `text-white` also exists — on `.btn-primary`, over
        // `bg-brand-600` — and has to stay white in both themes.
        surface: 'rgb(var(--surface) / <alpha-value>)',
        slate: themed('slate'),
        red: themed('red'),
        orange: themed('orange'),
        amber: themed('amber'),
        emerald: themed('emerald'),
        green: themed('green'),
        blue: themed('blue'),
        brand: themed('brand'),
      },
    },
  },
  plugins: [],
} satisfies Config;
