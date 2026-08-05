import { CHECKBOX_CHECKED, CHECKBOX_UNCHECKED } from './tokens.js';
import type { CheckboxRule } from './manifest.js';

/**
 * Reads the checkbox states out of a prior-year document.
 *
 * The result is a *suggestion* only. Nothing is carried forward without a
 * reviewer confirming it — this exists so the reviewer can see what was
 * selected last year rather than having to open the old letter.
 */

/** How far before the anchor text a controlling glyph may sit. */
const GLYPH_LOOKBEHIND = 8;

export interface CheckboxDetection {
  code: string;
  /** null when the checkbox could not be located in the document at all. */
  selected: boolean | null;
  /** The text the decision was read from, for evidence. */
  evidence: string | null;
}

function normalize(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function detectCheckboxStates(
  documentText: string,
  checkboxes: readonly CheckboxRule[],
): CheckboxDetection[] {
  const haystack = normalize(documentText);

  return checkboxes.map((checkbox) => {
    // An anchor that points at a token cannot be found in a filled-in
    // prior-year document, because the token was replaced by a value.
    if (checkbox.anchorText.includes('[[')) {
      return { code: checkbox.code, selected: null, evidence: null };
    }

    const needle = normalize(checkbox.anchorText);
    const at = haystack.indexOf(needle);
    if (at === -1) return { code: checkbox.code, selected: null, evidence: null };

    const windowStart = Math.max(0, at - GLYPH_LOOKBEHIND);
    const before = documentText.slice(windowStart, at);

    const checkedAt = before.lastIndexOf(CHECKBOX_CHECKED);
    const uncheckedAt = before.lastIndexOf(CHECKBOX_UNCHECKED);

    if (checkedAt === -1 && uncheckedAt === -1) {
      return { code: checkbox.code, selected: null, evidence: null };
    }

    // Whichever glyph sits closest to the anchor is the one controlling it.
    const selected = checkedAt > uncheckedAt;

    return {
      code: checkbox.code,
      selected,
      evidence: documentText.slice(windowStart, Math.min(documentText.length, at + needle.length)).trim(),
    };
  });
}
