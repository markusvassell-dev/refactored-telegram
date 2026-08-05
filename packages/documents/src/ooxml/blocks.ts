import { blockText, innerXml, paragraphStyle, splitTopLevelBlocks, type XmlBlock } from './xml.js';
import type { BlockRange } from '../template-engine/manifest.js';

/**
 * The body of a Word document as a list of top-level blocks (paragraphs,
 * tables, section properties). Conditional sections and internal-only content
 * are removed by deleting a contiguous run of these blocks — never by editing
 * the surrounding legal text.
 */

export interface BodyBlock extends XmlBlock {
  index: number;
  /** Whitespace-normalised visible text. */
  text: string;
  style: string | null;
}

export interface ParsedBody {
  /** Everything before `<w:body>`. */
  prefix: string;
  /** Everything after `</w:body>`. */
  suffix: string;
  blocks: BodyBlock[];
}

// Built from a character code rather than written literally, so this file
// stays free of invisible characters.
const NON_BREAKING_SPACE = new RegExp(String.fromCharCode(0xa0), 'g');

/**
 * Normalises the characters Word substitutes freely, so an anchor written with
 * ordinary quotes and hyphens still matches the document.
 */
export function normalizeText(value: string): string {
  return value
    .replace(NON_BREAKING_SPACE, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseBody(documentXml: string): ParsedBody {
  const body = innerXml(documentXml, 'w:body');
  if (!body) throw new Error('Document has no <w:body>.');

  const blocks = splitTopLevelBlocks(body.inner).map((block, index) => ({
    ...block,
    index,
    text: normalizeText(blockText(block.xml)),
    style: block.tag === 'w:p' ? paragraphStyle(block.xml) : null,
  }));

  return {
    prefix: documentXml.slice(0, body.start),
    suffix: documentXml.slice(body.end),
    blocks,
  };
}

export function serializeBody(parsed: ParsedBody): string {
  return parsed.prefix + parsed.blocks.map((block) => block.xml).join('') + parsed.suffix;
}

function anchorMatches(block: BodyBlock, anchor: string): boolean {
  const target = normalizeText(anchor).toLowerCase();
  const text = block.text.toLowerCase();
  return text.startsWith(target) || text.includes(target);
}

export interface ResolvedRange {
  /** Index of the first block in the range. */
  from: number;
  /** Index one past the last block in the range. */
  to: number;
}

/**
 * Resolves a manifest block range against the parsed body.
 * Returns null when the start anchor is not found, which the validator turns
 * into a template error rather than silently doing nothing.
 */
export function resolveRange(parsed: ParsedBody, range: BlockRange, searchFrom = 0): ResolvedRange | null {
  const startIndex = parsed.blocks.findIndex(
    (block, index) => index >= searchFrom && anchorMatches(block, range.startsWith),
  );
  if (startIndex === -1) return null;

  if (!range.endsBefore) {
    // Run to the end of the body, but never swallow the section properties —
    // deleting <w:sectPr> would destroy page size, margins and headers.
    const lastIndex = parsed.blocks.findLastIndex((block) => block.tag !== 'w:sectPr');
    return { from: startIndex, to: lastIndex + 1 };
  }

  const endIndex = parsed.blocks.findIndex(
    (block, index) => index > startIndex && anchorMatches(block, range.endsBefore as string),
  );
  if (endIndex === -1) return null;

  return { from: startIndex, to: range.inclusiveEnd ? endIndex + 1 : endIndex };
}

/** Removes the given ranges. Ranges may be supplied in any order. */
export function removeRanges(parsed: ParsedBody, ranges: readonly ResolvedRange[]): ParsedBody {
  if (ranges.length === 0) return parsed;

  const removed = new Set<number>();
  for (const range of ranges) {
    for (let index = range.from; index < range.to; index += 1) removed.add(index);
  }

  const blocks = parsed.blocks
    .filter((block) => !removed.has(block.index))
    .map((block, index) => ({ ...block, index }));

  return { ...parsed, blocks };
}

export interface SubFragment {
  /** Offsets within the containing block's XML. */
  start: number;
  end: number;
}

/** Table rows within a `<w:tbl>` block, in document order. */
export function tableRows(tableXml: string): SubFragment[] {
  const inner = innerXml(tableXml, 'w:tbl');
  if (!inner) return [];
  return splitTopLevelBlocks(inner.inner)
    .filter((block) => block.tag === 'w:tr')
    .map((block) => ({ start: inner.start + block.start, end: inner.start + block.end }));
}

/** Cells within a `<w:tr>`, expressed as offsets into the *table* XML. */
export function rowCells(tableXml: string, row: SubFragment): SubFragment[] {
  const rowXml = tableXml.slice(row.start, row.end);
  const inner = innerXml(rowXml, 'w:tr');
  if (!inner) return [];
  return splitTopLevelBlocks(inner.inner)
    .filter((block) => block.tag === 'w:tc')
    .map((block) => ({ start: row.start + inner.start + block.start, end: row.start + inner.start + block.end }));
}

export function findBlockByAnchor(parsed: ParsedBody, anchor: string): BodyBlock | null {
  return parsed.blocks.find((block) => anchorMatches(block, anchor)) ?? null;
}

export function replaceBlockXml(parsed: ParsedBody, index: number, xml: string): ParsedBody {
  const blocks = parsed.blocks.map((block) =>
    block.index === index ? { ...block, xml, text: normalizeText(blockText(xml)) } : block,
  );
  return { ...parsed, blocks };
}
