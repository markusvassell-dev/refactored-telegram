import { parseBody, rowCells, serializeBody, tableRows, type ParsedBody } from '../ooxml/blocks.js';
import { blockText, replaceTextRanges } from '../ooxml/xml.js';
import { token } from './tokens.js';

/**
 * Template normalisation.
 *
 * The approved Word templates carry visible bracketed placeholders such as
 * `[LEGAL NAME OF CORPORATION]`. Normalisation rewrites those — and only those
 * — into stable internal tokens like `[[corporation.legal_name]]`.
 *
 * Nothing else changes: legal text, branding, formatting, tables, headers,
 * footers, the logo, page breaks and paragraph structure are all preserved
 * because we never re-serialise the document, we only splice text runs.
 */

/** Characters Word substitutes freely; matched interchangeably. */
const NBSP = String.fromCharCode(0xa0);
const VARIANT_GROUPS: readonly string[] = [
  `'‘’`,
  `"“”`,
  `-–—`,
  ` ${NBSP}`,
];

const VARIANT_LOOKUP = new Map<string, string>();
for (const group of VARIANT_GROUPS) {
  const characterClass = `[${group.replace(/[\]\\^-]/g, '\\$&')}]`;
  for (const character of group) VARIANT_LOOKUP.set(character, characterClass);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a pattern that matches a literal tolerantly: straight and curly
 * quotes, hyphen and dashes, and space and non-breaking space are equivalent.
 */
export function flexiblePattern(literal: string, flags = 'g'): RegExp {
  let source = '';
  for (const character of literal) {
    source += VARIANT_LOOKUP.get(character) ?? escapeRegExp(character);
  }
  return new RegExp(source, flags);
}

export type MappingScope =
  | { kind: 'GLOBAL' }
  | { kind: 'PARAGRAPH'; startsWith: string; occurrence?: number }
  | { kind: 'TABLE_CELL'; tableContains: string; rowIndex: number; cellIndex: number; occurrence?: number };

export interface PlaceholderMapping {
  /** Literal placeholder exactly as it appears in the approved template. */
  placeholder: string;
  /** Stable internal token, without brackets. */
  token: string;
  /** Where to apply the mapping. Defaults to every occurrence in the body. */
  scope?: MappingScope;
  /**
   * Signature positions render as an underscore rule in drafts and as an Adobe
   * Sign text tag when the document is sent for signature.
   */
  isSignatureAnchor?: boolean;
  /**
   * Rewrite only the first occurrence that follows this text.
   * Omit to rewrite every occurrence.
   *
   * Needed because a signature block is a stack of identical underscore rules —
   * signature, date signed, email, telephone — distinguished only by the label
   * above them. Without this, mapping the rule for a signature rewrites the
   * three below it as well, and one token cannot mean four things.
   *
   * Deliberately a label rather than an ordinal. Mappings apply in sequence, each
   * seeing the previous one's output, so "the second rule in this cell" stops
   * being true the moment the first is rewritten — an ordinal quietly walks up
   * the block and puts the date field on the email line. A label still means the
   * same thing after its neighbours change, and if the template's wording moves
   * the mapping fails loudly instead of landing somewhere plausible.
   */
  afterLabel?: string;
}

export interface NormalizationIssue {
  severity: 'ERROR' | 'WARNING';
  message: string;
  placeholder?: string;
  token?: string;
}

export interface NormalizationResult {
  documentXml: string;
  replacements: number;
  /** Tokens actually written into the document. */
  tokensWritten: string[];
  issues: NormalizationIssue[];
  /** Bracketed placeholders left in the document with no mapping. */
  unmappedPlaceholders: string[];
}

interface Target {
  blockIndex: number;
  start: number;
  end: number;
}

function normalizeForCompare(value: string): string {
  let out = value;
  for (const group of VARIANT_GROUPS) {
    const canonical = group[0] as string;
    for (const character of group.slice(1)) {
      out = out.split(character).join(canonical);
    }
  }
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

function resolveTargets(parsed: ParsedBody, scope: MappingScope | undefined): Target[] {
  if (!scope || scope.kind === 'GLOBAL') {
    return parsed.blocks.map((block) => ({ blockIndex: block.index, start: 0, end: block.xml.length }));
  }

  if (scope.kind === 'PARAGRAPH') {
    const needle = normalizeForCompare(scope.startsWith);
    const matches = parsed.blocks.filter(
      (block) => block.tag === 'w:p' && normalizeForCompare(block.text).startsWith(needle),
    );
    const chosen = scope.occurrence === undefined ? matches : matches.slice(scope.occurrence, scope.occurrence + 1);
    return chosen.map((block) => ({ blockIndex: block.index, start: 0, end: block.xml.length }));
  }

  const needle = normalizeForCompare(scope.tableContains);
  const table = parsed.blocks.find(
    (block) => block.tag === 'w:tbl' && normalizeForCompare(block.text).includes(needle),
  );
  if (!table) return [];

  const rows = tableRows(table.xml);
  const row = rows[scope.rowIndex];
  if (!row) return [];

  const cells = rowCells(table.xml, row);
  const cell = cells[scope.cellIndex];
  if (!cell) return [];

  return [{ blockIndex: table.index, start: cell.start, end: cell.end }];
}

/**
 * Rewrites `[PLACEHOLDER]` occurrences into `[[token]]` inside the given
 * fragment of a block, returning the updated block XML.
 */
function applyToFragment(
  blockXml: string,
  target: Target,
  pattern: RegExp,
  replacement: string,
  afterLabel?: string,
): {
  xml: string;
  count: number;
} {
  const fragment = blockXml.slice(target.start, target.end);
  const text = blockText(fragment);

  const found: { start: number; end: number; value: string }[] = [];
  const scan = new RegExp(pattern.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = scan.exec(text)) !== null) {
    found.push({ start: match.index, end: match.index + match[0].length, value: replacement });
    if (match[0].length === 0) scan.lastIndex += 1;
  }

  // Restricted to the first occurrence after the label, when one is given. A
  // mapping whose label is absent rewrites nothing, so the rule survives and
  // normalisation reports an error. Falling back to another occurrence would put
  // a signature field on the wrong line, which is worse than leaving it undone.
  let ranges = found;
  if (afterLabel !== undefined) {
    const label = flexiblePattern(afterLabel, '').exec(text);
    const from = label ? label.index + label[0].length : -1;
    const first = from < 0 ? undefined : found.find((range) => range.start >= from);
    ranges = first ? [first] : [];
  }

  if (ranges.length === 0) return { xml: blockXml, count: 0 };

  const updated = replaceTextRanges(fragment, ranges);
  return {
    xml: blockXml.slice(0, target.start) + updated + blockXml.slice(target.end),
    count: ranges.length,
  };
}

export function normalizeDocumentXml(
  documentXml: string,
  mappings: readonly PlaceholderMapping[],
): NormalizationResult {
  let parsed = parseBody(documentXml);
  const issues: NormalizationIssue[] = [];
  const tokensWritten = new Set<string>();
  let replacements = 0;

  for (const mapping of mappings) {
    const targets = resolveTargets(parsed, mapping.scope);

    if (targets.length === 0) {
      issues.push({
        severity: 'ERROR',
        message: `Could not locate the position for placeholder ${mapping.placeholder}. The template may have changed.`,
        placeholder: mapping.placeholder,
        token: mapping.token,
      });
      continue;
    }

    const pattern = flexiblePattern(mapping.placeholder);
    const replacement = token(mapping.token);
    let mappingCount = 0;

    // Apply from the last target backwards so offsets stay valid within a block.
    const byBlock = new Map<number, Target[]>();
    for (const target of targets) {
      const list = byBlock.get(target.blockIndex) ?? [];
      list.push(target);
      byBlock.set(target.blockIndex, list);
    }

    for (const [blockIndex, blockTargets] of byBlock) {
      const block = parsed.blocks[blockIndex];
      if (!block) continue;

      let xml = block.xml;
      const ordered = [...blockTargets].sort((a, b) => b.start - a.start);
      for (const target of ordered) {
        const applied = applyToFragment(xml, target, pattern, replacement, mapping.afterLabel);
        xml = applied.xml;
        mappingCount += applied.count;
      }

      if (xml !== block.xml) {
        parsed = {
          ...parsed,
          blocks: parsed.blocks.map((candidate) =>
            candidate.index === blockIndex
              ? { ...candidate, xml, text: blockText(xml).replace(/\s+/g, ' ').trim() }
              : candidate,
          ),
        };
      }
    }

    if (mappingCount === 0) {
      issues.push({
        severity: 'ERROR',
        message: `Placeholder ${mapping.placeholder} was not found where expected.`,
        placeholder: mapping.placeholder,
        token: mapping.token,
      });
    } else {
      replacements += mappingCount;
      tokensWritten.add(mapping.token);
    }
  }

  const finalXml = serializeBody(parsed);
  const remainingText = parsed.blocks.map((block) => block.text).join('\n');
  const unmapped = new Set<string>();
  for (const match of remainingText.matchAll(/\[([A-Z0-9][^\][]*)\]/g)) {
    const raw = match[1];
    if (raw && raw.trim().length > 1) unmapped.add(`[${raw.trim()}]`);
  }

  for (const placeholder of unmapped) {
    issues.push({
      severity: 'WARNING',
      message: `Placeholder ${placeholder} has no mapping and will be reported as unresolved during validation.`,
      placeholder,
    });
  }

  return {
    documentXml: finalXml,
    replacements,
    tokensWritten: [...tokensWritten].sort(),
    issues,
    unmappedPlaceholders: [...unmapped].sort(),
  };
}
