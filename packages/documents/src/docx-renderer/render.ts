import { ValidationError } from '@element/shared';
import {
  parseBody,
  removeRanges,
  resolveRange,
  serializeBody,
  type BodyBlock,
  type ParsedBody,
  type ResolvedRange,
} from '../ooxml/blocks.js';
import { blockText, replaceTextRanges } from '../ooxml/xml.js';
import {
  getPartText,
  MAIN_DOCUMENT_PART,
  readDocx,
  setPartText,
  writeDocx,
  type DocxParts,
} from '../ooxml/package.js';
import type { TemplateManifest } from '../template-engine/manifest.js';
import { CHECKBOX_CHECKED, CHECKBOX_UNCHECKED, TOKEN_PATTERN } from '../template-engine/tokens.js';
import { stripHighlights } from '../sanitation/sanitize.js';

/**
 * The DOCX renderer.
 *
 * Rendering is deterministic: the same manifest, values and options always
 * produce a byte-identical file. It never rewrites approved legal wording —
 * it substitutes tokens, toggles checkboxes, and removes whole blocks that the
 * manifest marks conditional or internal-only.
 */

export type RenderMode = 'DRAFT' | 'FOR_SIGNATURE';

export interface RenderOptions {
  manifest: TemplateManifest;
  /** Token -> already-formatted display string. */
  values: Record<string, string>;
  /** Service / checkbox code -> selected. */
  selections: Record<string, boolean>;
  /**
   * Conditional section keys to include. A section not listed here is removed
   * when its manifest entry says `removeWhenFalse`.
   */
  includedSections: readonly string[];
  mode: RenderMode;
  /**
   * Approved wording exceptions for this document version, applied as whole
   * paragraph replacements. Each has already been approved by a partner.
   */
  wordingExceptions?: readonly { sectionAnchor: string; revisedWording: string }[];
  /**
   * Extra block ranges to remove — used for the dynamic enclosure list, where
   * a bullet is dropped when the matching final document is not in the package.
   */
  removeBlocksMatching?: readonly string[];
  /** Prefix stamped into the document when Test Mode produced it. */
  testModeBanner?: string | null;
}

export interface RenderResult {
  docx: Buffer;
  /** Tokens that had no value and were rendered as an empty string. */
  emptyTokens: string[];
  /** Tokens still present in the output. Non-empty means a rendering bug. */
  unresolvedTokens: string[];
  removedSections: string[];
  removedBlockCount: number;
  checkboxesSet: Record<string, boolean>;
}

function substituteTokens(
  parsed: ParsedBody,
  values: Record<string, string>,
  seenEmpty: Set<string>,
): ParsedBody {
  const blocks = parsed.blocks.map((block) => {
    const text = blockText(block.xml);
    if (!text.includes('[[')) return block;

    const ranges: { start: number; end: number; value: string }[] = [];
    const scan = new RegExp(TOKEN_PATTERN.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = scan.exec(text)) !== null) {
      const name = match[1];
      if (!name) continue;
      const value = values[name];
      if (value === undefined || value === '') seenEmpty.add(name);
      ranges.push({ start: match.index, end: match.index + match[0].length, value: value ?? '' });
    }

    if (ranges.length === 0) return block;

    const xml = replaceTextRanges(block.xml, ranges);
    return { ...block, xml, text: blockText(xml).replace(/\s+/g, ' ').trim() };
  });

  return { ...parsed, blocks };
}

function applyCheckboxes(
  parsed: ParsedBody,
  manifest: TemplateManifest,
  selections: Record<string, boolean>,
): { parsed: ParsedBody; applied: Record<string, boolean> } {
  const applied: Record<string, boolean> = {};
  let blocks = parsed.blocks;

  for (const rule of manifest.checkboxes) {
    const desired = rule.alwaysChecked ? true : (selections[rule.code] ?? rule.defaultChecked);
    const needle = rule.anchorText.toLowerCase();

    const index = blocks.findIndex((block) => {
      if (block.tag !== 'w:p') return false;
      const text = block.text.toLowerCase();
      return text.includes(needle) && (text.includes(CHECKBOX_UNCHECKED) || text.includes(CHECKBOX_CHECKED));
    });

    if (index === -1) continue;

    const block = blocks[index] as BodyBlock;
    const text = blockText(block.xml);
    const glyphIndex = Math.min(
      ...[text.indexOf(CHECKBOX_UNCHECKED), text.indexOf(CHECKBOX_CHECKED)].filter((position) => position >= 0),
    );
    if (!Number.isFinite(glyphIndex)) continue;

    const target = desired ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED;
    if (text[glyphIndex] === target) {
      applied[rule.code] = desired;
      continue;
    }

    const xml = replaceTextRanges(block.xml, [{ start: glyphIndex, end: glyphIndex + 1, value: target }]);
    blocks = blocks.map((candidate) =>
      candidate.index === block.index
        ? { ...candidate, xml, text: blockText(xml).replace(/\s+/g, ' ').trim() }
        : candidate,
    );
    applied[rule.code] = desired;
  }

  return { parsed: { ...parsed, blocks }, applied };
}

function applyWordingExceptions(
  parsed: ParsedBody,
  exceptions: readonly { sectionAnchor: string; revisedWording: string }[],
): ParsedBody {
  let blocks = parsed.blocks;

  for (const exception of exceptions) {
    const needle = exception.sectionAnchor.toLowerCase().trim();
    const block = blocks.find((candidate) => candidate.tag === 'w:p' && candidate.text.toLowerCase().includes(needle));
    if (!block) continue;

    const text = blockText(block.xml);
    const xml = replaceTextRanges(block.xml, [{ start: 0, end: text.length, value: exception.revisedWording }]);
    blocks = blocks.map((candidate) =>
      candidate.index === block.index
        ? { ...candidate, xml, text: blockText(xml).replace(/\s+/g, ' ').trim() }
        : candidate,
    );
  }

  return { ...parsed, blocks };
}

export async function renderDocx(templateDocx: Uint8Array | Buffer, options: RenderOptions): Promise<RenderResult> {
  const parts = await readDocx(templateDocx);
  const emptyTokens = new Set<string>();
  const removedSections: string[] = [];
  let removedBlockCount = 0;

  // ---- Main document body -------------------------------------------------
  let parsed = parseBody(getPartText(parts, MAIN_DOCUMENT_PART));

  // 1. Remove internal-only content. This happens first and unconditionally:
  //    an internal checklist must never survive into client-facing output.
  const rangesToRemove: ResolvedRange[] = [];
  for (const section of options.manifest.internalOnlySections) {
    const range = resolveRange(parsed, section.range);
    if (range) {
      rangesToRemove.push(range);
      removedSections.push(section.key);
    }
  }

  // 2. Remove conditional sections that are not included.
  for (const section of options.manifest.conditionalSections) {
    const included = options.includedSections.includes(section.key);
    if (included || !section.removeWhenFalse) continue;

    for (const rangeSpec of section.ranges) {
      const range = resolveRange(parsed, rangeSpec);
      if (range) {
        rangesToRemove.push(range);
      } else {
        throw new ValidationError(
          `The template does not contain the conditional section "${section.label}" where the manifest expects it. The template and manifest are out of step.`,
        );
      }
    }
    removedSections.push(section.key);
  }

  // 3. Remove individually suppressed blocks (dynamic enclosure list).
  for (const anchor of options.removeBlocksMatching ?? []) {
    const needle = anchor.toLowerCase().trim();
    const block = parsed.blocks.find(
      (candidate) => candidate.tag === 'w:p' && candidate.text.toLowerCase().includes(needle),
    );
    if (block) rangesToRemove.push({ from: block.index, to: block.index + 1 });
  }

  if (rangesToRemove.length > 0) {
    const before = parsed.blocks.length;
    parsed = removeRanges(parsed, rangesToRemove);
    removedBlockCount = before - parsed.blocks.length;
  }

  // 4. Approved wording exceptions.
  if (options.wordingExceptions?.length) {
    parsed = applyWordingExceptions(parsed, options.wordingExceptions);
  }

  // 5. Signature anchors.
  const signatureValues: Record<string, string> = {};
  for (const anchor of options.manifest.signatureAnchors) {
    signatureValues[anchor.token] =
      options.mode === 'FOR_SIGNATURE' ? anchor.adobeTag : anchor.draftPlaceholder;
  }

  // 6. Checkboxes. This runs *before* token substitution because a checkbox
  //    anchor may point at a token (for example the "Other: [[…]]" bullets),
  //    which would otherwise have already been replaced by its value.
  const checkboxResult = applyCheckboxes(parsed, options.manifest, options.selections);
  parsed = checkboxResult.parsed;

  // 7. Token substitution. Signature anchors win over supplied values so that
  //    a stale signature value can never be written into a document.
  const values = { ...options.values, ...signatureValues };
  parsed = substituteTokens(parsed, values, emptyTokens);

  let documentXml = serializeBody(parsed);

  // 8. Sanitation: strip every highlight so no yellow placeholder shading can
  //    reach a client-facing document.
  if (options.manifest.sanitation.removeAllHighlights) {
    documentXml = stripHighlights(documentXml);
  }

  setPartText(parts, MAIN_DOCUMENT_PART, documentXml);

  // ---- Headers and footers ------------------------------------------------
  for (const path of parts.textParts) {
    if (path === MAIN_DOCUMENT_PART) continue;
    let xml = getPartText(parts, path);
    xml = substituteInFragment(xml, values, emptyTokens);
    if (options.manifest.sanitation.removeAllHighlights) xml = stripHighlights(xml);
    setPartText(parts, path, xml);
  }

  const docx = await writeDocx(parts);
  const unresolvedTokens = collectUnresolvedTokens(parts);

  return {
    docx,
    emptyTokens: [...emptyTokens].sort(),
    unresolvedTokens,
    removedSections,
    removedBlockCount,
    checkboxesSet: checkboxResult.applied,
  };
}

function substituteInFragment(xml: string, values: Record<string, string>, seenEmpty: Set<string>): string {
  const text = blockText(xml);
  if (!text.includes('[[')) return xml;

  const ranges: { start: number; end: number; value: string }[] = [];
  const scan = new RegExp(TOKEN_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = scan.exec(text)) !== null) {
    const name = match[1];
    if (!name) continue;
    const value = values[name];
    if (value === undefined || value === '') seenEmpty.add(name);
    ranges.push({ start: match.index, end: match.index + match[0].length, value: value ?? '' });
  }

  return ranges.length === 0 ? xml : replaceTextRanges(xml, ranges);
}

function collectUnresolvedTokens(parts: DocxParts): string[] {
  const found = new Set<string>();
  for (const path of parts.textParts) {
    const text = blockText(getPartText(parts, path));
    for (const match of text.matchAll(new RegExp(TOKEN_PATTERN.source, 'g'))) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}
