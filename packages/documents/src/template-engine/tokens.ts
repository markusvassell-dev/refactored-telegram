/**
 * Token syntax.
 *
 * Internal tokens use double square brackets: `[[corporation.legal_name]]`.
 *
 * Double *curly* braces are deliberately left alone: that is Adobe Acrobat
 * Sign's text-tag syntax (`{{Sig_es_:signer1:signature}}`), and the two must
 * never collide.
 */

export const TOKEN_OPEN = '[[';
export const TOKEN_CLOSE = ']]';

export const TOKEN_PATTERN = /\[\[([a-z0-9_]+(?:\.[a-z0-9_]+)*)\]\]/g;

/** Visible bracketed placeholders in the original source templates. */
export const SOURCE_PLACEHOLDER_PATTERN = /\[([A-Z0-9][^\][]*)\]/g;

export function token(name: string): string {
  return `${TOKEN_OPEN}${name}${TOKEN_CLOSE}`;
}

export function findTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found].sort();
}

export function findSourcePlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(SOURCE_PLACEHOLDER_PATTERN)) {
    const raw = match[1];
    if (raw && raw.trim().length > 1) found.add(`[${raw.trim()}]`);
  }
  return [...found].sort();
}

/** Checkbox glyphs used by the approved templates. */
export const CHECKBOX_UNCHECKED = '☐'; // BALLOT BOX
export const CHECKBOX_CHECKED = '☒'; // BALLOT BOX WITH X
export const CHECKBOX_GLYPHS = [CHECKBOX_UNCHECKED, CHECKBOX_CHECKED];

export function hasCheckbox(text: string): boolean {
  return CHECKBOX_GLYPHS.some((glyph) => text.includes(glyph));
}
