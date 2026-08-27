import { valuesAgree } from '@element/shared';

/**
 * One value per token, from however many documents said something about it.
 *
 * `extracted_field` is unique on `(engagement, package, token, source)`, and
 * every document a scan reads writes the same source. So forty documents do not
 * produce forty rows to choose between — they produce one row, with the last
 * writer silently winning. Supporting more than one document therefore cannot
 * mean "write more rows"; the choice has to be made before anything is written,
 * in one place, where it can be explained.
 *
 * `FieldEvidence` already carries per-document provenance under a single value,
 * which is the right shape for this: three documents agreeing is one value with
 * three citations, not three competing answers.
 *
 * Deliberately pure and database-free. Deciding which of several documents is
 * right is the part worth being able to test exhaustively and to reason about
 * without a fixture.
 */

/** Ordered by how much a document of that kind is worth being believed. */
const KIND_PRECEDENCE: readonly string[] = [
  // A signed letter is the one the client actually agreed to.
  'PRIOR_YEAR_SIGNED_LETTER',
  'PRIOR_YEAR_ENGAGEMENT_LETTER',
  // CRA has its own copy of the identity, and no interest in the firm's.
  'NOTICE_OF_ASSESSMENT',
  'FINAL_T2_RETURN',
  'T1_RETURN',
  'FEDERAL_FILING_AUTHORIZATION',
  'T183',
  'COMPILED_FINANCIAL_STATEMENTS',
  'COMPILATION_ENGAGEMENT_REPORT',
  'TRIAL_BALANCE',
];

function kindRank(kind: string): number {
  const index = KIND_PRECEDENCE.indexOf(kind);
  return index === -1 ? KIND_PRECEDENCE.length : index;
}

export interface DocumentFinding {
  token: string;
  value: string;
  numericValue?: string | null;
  dateValue?: string | null;
  sourceDocumentId: string;
  fileName: string;
  kind: string;
  /** `verifyCandidate`'s score for the document this came from, 0 to 1. */
  documentScore: number;
  pageNumber?: number | null;
  supportingText?: string | null;
}

export interface MergedToken {
  token: string;
  value: string;
  numericValue: string | null;
  dateValue: string | null;
  /** Every document supporting the winning value — one evidence row each. */
  corroborating: DocumentFinding[];
  /**
   * The values that lost, grouped, and only when documents genuinely disagreed.
   * Null when they all said the same thing.
   */
  disagreement: { value: string; findings: DocumentFinding[] }[] | null;
}

/**
 * Deterministic ordering between two groups that disagree.
 *
 * Every tier is a fact about the documents rather than about the order they
 * were read in, and the last is a total order, so the same set of findings
 * resolves the same way on every run. A merge whose answer depended on which
 * Karbon scope answered first would be a value that changed under a reviewer.
 */
function betterGroup(
  a: { value: string; findings: DocumentFinding[] },
  b: { value: string; findings: DocumentFinding[] },
): number {
  const bestScore = (group: { findings: DocumentFinding[] }): number =>
    Math.max(...group.findings.map((finding) => finding.documentScore));

  const byScore = bestScore(b) - bestScore(a);
  if (Math.abs(byScore) > 1e-9) return byScore;

  // Three documents saying the same thing beats one saying otherwise.
  const byCorroboration = b.findings.length - a.findings.length;
  if (byCorroboration !== 0) return byCorroboration;

  const bestKind = (group: { findings: DocumentFinding[] }): number =>
    Math.min(...group.findings.map((finding) => kindRank(finding.kind)));

  const byKind = bestKind(a) - bestKind(b);
  if (byKind !== 0) return byKind;

  return a.value.localeCompare(b.value);
}

export function mergeDocumentFindings(findings: readonly DocumentFinding[]): MergedToken[] {
  const byToken = new Map<string, DocumentFinding[]>();
  for (const finding of findings) {
    if (finding.value.trim() === '') continue;
    const bucket = byToken.get(finding.token) ?? [];
    bucket.push(finding);
    byToken.set(finding.token, bucket);
  }

  const merged: MergedToken[] = [];

  for (const [token, all] of [...byToken.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Group by agreement rather than by exact string, so a trailing full stop
    // is not a question anybody has to answer.
    const groups: { value: string; findings: DocumentFinding[] }[] = [];
    for (const finding of all) {
      const existing = groups.find((group) => valuesAgree(group.value, finding.value));
      if (existing) existing.findings.push(finding);
      else groups.push({ value: finding.value, findings: [finding] });
    }

    groups.sort(betterGroup);
    const winner = groups[0] as { value: string; findings: DocumentFinding[] };

    // Within the winning group, the highest-scoring document supplies the exact
    // text — the others agree with it, they do not each get a say in spelling.
    const authoritative = [...winner.findings].sort(
      (a, b) => b.documentScore - a.documentScore || kindRank(a.kind) - kindRank(b.kind) || a.value.localeCompare(b.value),
    )[0] as DocumentFinding;

    merged.push({
      token,
      value: authoritative.value,
      numericValue: authoritative.numericValue ?? null,
      dateValue: authoritative.dateValue ?? null,
      corroborating: winner.findings,
      disagreement: groups.length > 1 ? groups.slice(1) : null,
    });
  }

  return merged;
}
