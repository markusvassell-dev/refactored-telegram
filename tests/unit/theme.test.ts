import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTheme, themeAttribute, THEMES } from '../../apps/web/src/lib/theme';

/**
 * The theme, and the two ways it can silently be wrong.
 *
 * **The attribute.** The stylesheet's dark rules are a `prefers-color-scheme`
 * query guarded by `:root:not([data-theme='light'])`, so "System" has to be the
 * *absence* of the attribute. Stamping `data-theme="system"` would match
 * neither block and pin the whole app to light — with nothing to see, because
 * light is also what it looks like when it is working.
 *
 * **The contrast.** Every colour in this app comes from a variable now, so a
 * value typed one digit wrong produces a page that renders perfectly and cannot
 * be read. Eyeballing a dark theme is exactly how that ships. These compute the
 * ratios from the stylesheet itself, so the numbers being checked are the ones
 * the browser will use.
 */

describe('which theme a cookie means', () => {
  it('maps each stored value to itself', () => {
    for (const theme of THEMES) {
      expect(readTheme(theme)).toBe(theme);
    }
  });

  it('falls back to the system rather than to light', () => {
    // A person who has never opened the toggle should get their operating
    // system's answer, which is the one most likely to be right. Defaulting to
    // light would make the app the only thing on a dark desktop that is white.
    expect(readTheme(undefined)).toBe('system');
    expect(readTheme(null)).toBe('system');
    expect(readTheme('')).toBe('system');

    // A stale cookie from an older build, or one somebody edited by hand, is
    // not trusted into the attribute.
    expect(readTheme('midnight')).toBe('system');
    expect(readTheme('DARK')).toBe('system');
  });

  it('stamps nothing at all for the system, so prefers-color-scheme decides', () => {
    expect(themeAttribute('system')).toBeNull();
    expect(themeAttribute('dark')).toBe('dark');
    expect(themeAttribute('light')).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

const CSS = readFileSync(resolve(__dirname, '../../apps/web/src/app/globals.css'), 'utf8');

/** The variables inside one selector block, read from the stylesheet itself. */
function paletteAfter(marker: string): Map<string, [number, number, number]> {
  const start = CSS.indexOf(marker);
  if (start === -1) throw new Error(`No block matching ${marker} in globals.css`);

  const palette = new Map<string, [number, number, number]>();

  // Read to this block's own closing brace, by counting braces, rather than a
  // fixed number of characters. A fixed window silently overran into the next
  // block the moment the stylesheet grew — and because `set` lets the last
  // match win, the light palette quietly filled up with dark values and the
  // contrast assertions started measuring the wrong pair. A test that measures
  // the wrong thing is worse than no test.
  let depth = 0;
  let end = start;
  for (let i = CSS.indexOf('{', start); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === start) throw new Error(`Unbalanced braces after ${marker} in globals.css`);

  const slice = CSS.slice(start, end);
  for (const [, name, r, g, b] of slice.matchAll(/--([a-z]+-\d+|surface|brand-hover):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    palette.set(name as string, [Number(r), Number(g), Number(b)]);
  }
  return palette;
}

const LIGHT = paletteAfter(':root {');
const DARK = paletteAfter(":root[data-theme='dark'] {");

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(palette: Map<string, [number, number, number]>, ink: string, fill: string): number {
  const a = palette.get(ink);
  const b = palette.get(fill);
  if (!a || !b) throw new Error(`Missing ${!a ? ink : fill} — a step that does not exist renders with no colour.`);

  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** The pairs this app actually renders, not a sweep of every combination. */
const TEXT_PAIRS: [string, string][] = [
  // Body and headings on both the page and a card.
  ['slate-900', 'slate-50'],
  ['slate-900', 'surface'],
  ['slate-700', 'surface'],
  ['slate-600', 'surface'],
  ['slate-600', 'slate-50'],
  // The muted note under a field, and the empty-state message. The lowest
  // contrast text in the app, and therefore the one worth pinning.
  ['slate-500', 'surface'],
  ['slate-500', 'slate-50'],
  // Every STATUS_TONES badge in components/shell.tsx.
  ['red-800', 'red-100'],
  ['orange-800', 'orange-100'],
  ['amber-800', 'amber-100'],
  ['blue-800', 'blue-100'],
  ['emerald-800', 'emerald-100'],
  ['green-800', 'green-100'],
  ['slate-700', 'slate-100'],
  // The alert panels on the client and engagement pages.
  ['amber-900', 'amber-50'],
  ['red-700', 'surface'],
  // The notification pill in the header.
  ['brand-800', 'brand-100'],
];

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
])('%s theme contrast', (_name, palette) => {
  it.each(TEXT_PAIRS)('%s on %s clears WCAG AA', (ink, fill) => {
    expect(contrast(palette, ink, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('defines every step the palette promises', () => {
    // A step missing from a scale does not fail loudly: Tailwind generates no
    // rule and the element renders with no colour at all.
    for (const hue of ['slate', 'red', 'orange', 'amber', 'emerald', 'green', 'blue', 'brand']) {
      for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(palette.has(`${hue}-${step}`), `${hue}-${step}`).toBe(true);
      }
    }
    expect(palette.has('surface')).toBe(true);
  });
});

describe('the two palettes are actually two palettes', () => {
  it('reads different values for light and dark', () => {
    // The guard against the parser silently reading one block twice. When it
    // did, every contrast assertion still ran and still passed — against the
    // wrong colours. This is the cheapest thing that would have caught it.
    expect(LIGHT.get('surface')).not.toEqual(DARK.get('surface'));
    expect(LIGHT.get('slate-900')).not.toEqual(DARK.get('slate-900'));
    expect(LIGHT.get('blue-100')).not.toEqual(DARK.get('blue-100'));

    // Light surface is white; dark surface is not. Stated concretely so a
    // parser that returned two copies of the *dark* block fails too.
    expect(LIGHT.get('surface')).toEqual([255, 255, 255]);
  });
});

describe('the dark surface ordering', () => {
  it('puts the page behind the card, and the hover fill in front of it', () => {
    // A strict inversion of the light scale gets this backwards: the card ends
    // up darker than the page, which reads as a hole rather than a card, and
    // `hover:bg-slate-100` lands on the same colour as the surface it sits on
    // so nothing responds to a pointer.
    const page = luminance(DARK.get('slate-50') as [number, number, number]);
    const surface = luminance(DARK.get('surface') as [number, number, number]);
    const hover = luminance(DARK.get('slate-100') as [number, number, number]);

    expect(page).toBeLessThan(surface);
    expect(surface).toBeLessThan(hover);
  });

  it('keeps the same ordering in light, where the page is the darker one', () => {
    const page = luminance(LIGHT.get('slate-50') as [number, number, number]);
    const surface = luminance(LIGHT.get('surface') as [number, number, number]);

    expect(page).toBeLessThan(surface);
  });
});

describe('interactive states, which are easy to check only at rest', () => {
  /**
   * The pair that was missed the first time.
   *
   * `.btn-primary` was `bg-brand-600 text-white hover:bg-brand-700`, and the
   * dark ramp makes `brand-700` a light green because it is also used as ink
   * (`text-brand-700`). White on that is 2.18:1 — the label all but vanished
   * at the moment somebody was about to click it, and the resting state, which
   * is what a contrast check naturally looks at, was fine.
   */
  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ])('keeps the primary button label legible on hover in %s', (_name, palette) => {
    const white: [number, number, number] = [255, 255, 255];
    const hover = palette.get('brand-hover') as [number, number, number];
    expect(hover, 'brand-hover must be defined in both themes').toBeDefined();

    const [lighter, darker] = [luminance(white), luminance(hover)].sort((x, y) => y - x) as [number, number];
    expect((lighter + 0.05) / (darker + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ])('keeps brand ink legible where it is used as ink in %s', (_name, palette) => {
    // `text-brand-700` is the product name in the header and the selected
    // theme button. It sits on `surface`, which is the demand that pulls
    // `brand-700` in the opposite direction from the button hover.
    expect(contrast(palette, 'brand-700', 'surface')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the primary button, which is not themed', () => {
  it('keeps white legible on the brand green in both themes', () => {
    // `.btn-primary` is `bg-brand-600 text-white`, and `text-white` is
    // deliberately literal — a themed white would turn the label dark on a
    // green button. So brand-600 has to stay a colour white reads on.
    const white: [number, number, number] = [255, 255, 255];

    for (const palette of [LIGHT, DARK]) {
      const green = palette.get('brand-600') as [number, number, number];
      const [lighter, darker] = [luminance(white), luminance(green)].sort((x, y) => y - x) as [number, number];
      expect((lighter + 0.05) / (darker + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
