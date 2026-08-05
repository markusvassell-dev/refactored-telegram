/**
 * Pagination.
 *
 * A list that stops at a fixed number and says nothing is worse than a list
 * that refuses to load: the reader has no way to tell a short answer from a
 * truncated one. Every list that can outgrow a screen says how much it is
 * showing, out of how much there is, and offers a way to the rest.
 *
 * Two properties matter more than the arithmetic:
 *
 *   - **The sort must be total.** `ORDER BY created_at DESC` is not a defined
 *     order when timestamps tie, and SQL is free to return tied rows in a
 *     different sequence for each query. Paging over that skips rows and
 *     repeats others. Ties are not hypothetical here: Postgres `now()` is the
 *     transaction timestamp, so every audit event written by one bulk rollout
 *     shares a `createdAt` to the microsecond. Every paged query therefore ends
 *     with a unique tiebreaker; see `withStableOrder`.
 *
 *   - **The count must not cost more than the answer.** An exact `COUNT(*)`
 *     over an append-only audit table grows without bound, and nobody needs to
 *     know there are exactly 41,882 events. Counting stops at a ceiling and
 *     reports "more than 10,000" beyond it, which is both cheap and true.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Counting stops here; beyond it the total is reported as a lower bound. */
export const COUNT_CEILING = 10_000;

/** Far past any real list, and low enough that `skip` stays a sane integer. */
const MAX_PAGE = 100_000;

export interface PageRequest {
  /** 1-based. */
  page: number;
  pageSize: number;
  /** For the query. */
  skip: number;
  /**
   * One more row than the page needs. Fetching the extra row is how the page
   * knows there is a next one without a second query, and it stays correct when
   * the total is only a lower bound.
   */
  take: number;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** 1-based position of the first and last row shown; 0 when there are none. */
  firstIndex: number;
  lastIndex: number;
}

export interface BoundedCount {
  value: number;
  /** True when counting hit the ceiling, so `value` is "at least this many". */
  isLowerBound: boolean;
}

function positiveInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function parsePageRequest(
  params: Record<string, string | undefined>,
  options: { defaultPageSize?: number } = {},
): PageRequest {
  const page = positiveInteger(params.page, 1, MAX_PAGE);
  const pageSize = positiveInteger(params.pageSize, options.defaultPageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize + 1 };
}

/** Trims the extra look-ahead row and works out where in the list we are. */
export function toPage<T>(rows: readonly T[], request: PageRequest): PageResult<T> {
  const hasNext = rows.length > request.pageSize;
  const items = hasNext ? rows.slice(0, request.pageSize) : [...rows];

  return {
    items,
    page: request.page,
    pageSize: request.pageSize,
    hasPrevious: request.page > 1,
    hasNext,
    // Both are zero on an empty page. Deriving only the first index from the row
    // count leaves the last one at the skip offset, which renders as "0–10".
    firstIndex: items.length === 0 ? 0 : request.skip + 1,
    lastIndex: items.length === 0 ? 0 : request.skip + items.length,
  };
}

/**
 * Appends a unique tiebreaker so the order is total.
 *
 * Without one, two rows with equal sort values have no defined sequence, and
 * `OFFSET` over an undefined sequence is how a row goes missing from a list
 * that reports itself complete.
 */
export function withStableOrder<T extends Record<string, unknown>>(order: T[]): (T | { id: 'desc' })[] {
  return [...order, { id: 'desc' as const }];
}

/**
 * Counts up to a ceiling.
 *
 * `counter` is given a limit and must not count past it; Prisma's `count`
 * accepts `take` for exactly this.
 */
export async function boundedCount(
  counter: (limit: number) => Promise<number>,
  ceiling: number = COUNT_CEILING,
): Promise<BoundedCount> {
  const counted = await counter(ceiling + 1);
  return counted > ceiling ? { value: ceiling, isLowerBound: true } : { value: counted, isLowerBound: false };
}

export function formatTotal(total: BoundedCount, noun: string, pluralNoun: string = `${noun}s`): string {
  const word = total.value === 1 ? noun : pluralNoun;
  return total.isLowerBound
    ? `more than ${total.value.toLocaleString('en-CA')} ${pluralNoun}`
    : `${total.value.toLocaleString('en-CA')} ${word}`;
}

/**
 * A link to another page of the same list.
 *
 * Every other parameter is carried across. Dropping the filters on a page
 * change is the classic version of this bug: the second page of a filtered
 * list quietly becomes the second page of an unfiltered one.
 */
export function pageHref(pathname: string, params: Record<string, string | undefined>, page: number): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (key === 'page') continue;
    if (value === undefined || value === '') continue;
    query.set(key, value);
  }

  if (page > 1) query.set('page', String(page));

  const search = query.toString();
  return search ? `${pathname}?${search}` : pathname;
}
