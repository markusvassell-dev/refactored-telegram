import { parseBody } from '../ooxml/blocks.js';
import { getPartText, MAIN_DOCUMENT_PART, readDocx } from '../ooxml/package.js';
import { blockText } from '../ooxml/xml.js';

/**
 * Document comparison.
 *
 * Two comparisons matter to a reviewer:
 *
 *  1. Prior-year signed letter vs the new draft — what changed for this client.
 *  2. Approved master template vs the new draft — whether any approved legal
 *     wording has been altered, and whether the prior year contained custom
 *     wording that is deliberately not being carried forward.
 */

export type ParagraphChangeKind = 'UNCHANGED' | 'ADDED' | 'REMOVED' | 'MODIFIED';

export interface ParagraphChange {
  kind: ParagraphChangeKind;
  leftIndex: number | null;
  rightIndex: number | null;
  leftText: string;
  rightText: string;
}

export interface FieldChange {
  token: string;
  label: string;
  previousValue: string | null;
  proposedValue: string | null;
  changed: boolean;
}

/** Normalises text so that whitespace and quote-style differences are ignored. */
function canonical(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function extractParagraphs(docx: Uint8Array | Buffer): Promise<string[]> {
  const parts = await readDocx(docx);
  const parsed = parseBody(getPartText(parts, MAIN_DOCUMENT_PART));
  return parsed.blocks
    .map((block) => blockText(block.xml).replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0);
}

/**
 * A longest-common-subsequence diff over paragraphs.
 *
 * Paragraph granularity is deliberate: it maps directly onto the way the
 * templates are structured and onto how a reviewer reads a legal document.
 */
export function diffParagraphs(left: readonly string[], right: readonly string[]): ParagraphChange[] {
  const leftKeys = left.map(canonical);
  const rightKeys = right.map(canonical);

  const rows = leftKeys.length;
  const columns = rightKeys.length;

  // lcs[i][j] = length of the LCS of left[i..] and right[j..]
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const row = lcs[i] as number[];
      const nextRow = lcs[i + 1] as number[];
      row[j] = leftKeys[i] === rightKeys[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number);
    }
  }

  const changes: ParagraphChange[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < columns) {
    if (leftKeys[i] === rightKeys[j]) {
      changes.push({
        kind: 'UNCHANGED',
        leftIndex: i,
        rightIndex: j,
        leftText: left[i] ?? '',
        rightText: right[j] ?? '',
      });
      i += 1;
      j += 1;
      continue;
    }

    const skipLeft = (lcs[i + 1] as number[])[j] as number;
    const skipRight = (lcs[i] as number[])[j + 1] as number;

    if (skipLeft >= skipRight) {
      changes.push({ kind: 'REMOVED', leftIndex: i, rightIndex: null, leftText: left[i] ?? '', rightText: '' });
      i += 1;
    } else {
      changes.push({ kind: 'ADDED', leftIndex: null, rightIndex: j, leftText: '', rightText: right[j] ?? '' });
      j += 1;
    }
  }

  while (i < rows) {
    changes.push({ kind: 'REMOVED', leftIndex: i, rightIndex: null, leftText: left[i] ?? '', rightText: '' });
    i += 1;
  }
  while (j < columns) {
    changes.push({ kind: 'ADDED', leftIndex: null, rightIndex: j, leftText: '', rightText: right[j] ?? '' });
    j += 1;
  }

  return mergeAdjacentReplacements(changes);
}

/**
 * Turns a removal-and-reinsertion of the same clause into a single MODIFIED
 * entry, which is how a reviewer reads it.
 *
 * Pairing happens within a contiguous block of changes rather than only for
 * immediately adjacent entries, because the LCS walk often emits every removal
 * in a block before the corresponding additions.
 */
function mergeAdjacentReplacements(changes: readonly ParagraphChange[]): ParagraphChange[] {
  const merged: ParagraphChange[] = [];
  let index = 0;

  while (index < changes.length) {
    const current = changes[index];
    if (!current) break;

    if (current.kind === 'UNCHANGED') {
      merged.push(current);
      index += 1;
      continue;
    }

    // Collect the whole contiguous run of changes.
    const runStart = index;
    while (index < changes.length && changes[index]?.kind !== 'UNCHANGED') index += 1;
    const run = changes.slice(runStart, index);

    const removals = run.filter((change) => change.kind === 'REMOVED');
    const additions = run.filter((change) => change.kind === 'ADDED');
    const pairedAdditions = new Set<ParagraphChange>();

    for (const removal of removals) {
      const match = additions.find(
        (addition) => !pairedAdditions.has(addition) && looksRelated(removal.leftText, addition.rightText),
      );

      if (match) {
        pairedAdditions.add(match);
        merged.push({
          kind: 'MODIFIED',
          leftIndex: removal.leftIndex,
          rightIndex: match.rightIndex,
          leftText: removal.leftText,
          rightText: match.rightText,
        });
      } else {
        merged.push(removal);
      }
    }

    for (const addition of additions) {
      if (!pairedAdditions.has(addition)) merged.push(addition);
    }
  }

  return merged;
}

function looksRelated(left: string, right: string): boolean {
  const a = new Set(canonical(left).split(' ').filter((word) => word.length > 3));
  const b = new Set(canonical(right).split(' ').filter((word) => word.length > 3));
  if (a.size === 0 || b.size === 0) return false;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.max(a.size, b.size) >= 0.4;
}

export interface CustomWordingFinding {
  /** Paragraph from the prior-year document with no counterpart in the master. */
  priorYearText: string;
  /** Always this label — custom wording is never carried forward automatically. */
  label: 'Prior-year custom wording not carried forward';
}

/**
 * Finds wording present in a prior-year letter but absent from the current
 * approved master template.
 *
 * The result is displayed to the reviewer and never applied. Adding it requires
 * the exceptional wording-edit process: a reason, and partner approval.
 */
export function findPriorYearCustomWording(
  priorYearParagraphs: readonly string[],
  masterTemplateParagraphs: readonly string[],
): CustomWordingFinding[] {
  const masterKeys = new Set(masterTemplateParagraphs.map(canonical));
  const masterWords = masterTemplateParagraphs.map(canonical);

  return priorYearParagraphs
    .filter((paragraph) => {
      const key = canonical(paragraph);
      if (key.length < 40) return false; // Ignore headings and short labels.
      if (masterKeys.has(key)) return false;
      // Ignore paragraphs that are merely a filled-in version of a master one.
      return !masterWords.some((candidate) => looksRelated(candidate, key));
    })
    .map((paragraph) => ({
      priorYearText: paragraph,
      label: 'Prior-year custom wording not carried forward' as const,
    }));
}

export function summarizeFieldChanges(
  previous: Record<string, string | null | undefined>,
  proposed: Record<string, string | null | undefined>,
  labels: Record<string, string>,
): FieldChange[] {
  const tokens = new Set([...Object.keys(previous), ...Object.keys(proposed)]);

  return [...tokens]
    .sort()
    .map((token) => {
      const previousValue = previous[token] ?? null;
      const proposedValue = proposed[token] ?? null;
      return {
        token,
        label: labels[token] ?? token,
        previousValue,
        proposedValue,
        changed: canonical(previousValue ?? '') !== canonical(proposedValue ?? ''),
      };
    });
}
