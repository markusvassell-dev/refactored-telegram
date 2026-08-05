import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatTotal, pageHref, type BoundedCount, type PageResult } from '@/lib/pagination';

/**
 * The controls under a paged list.
 *
 * It always states what is being shown out of what there is. A list that simply
 * ends gives a reader no way to tell a short answer from a truncated one, and
 * on an audit trail that ambiguity is the whole problem.
 */
export function Pagination<T>({
  page,
  total,
  noun,
  pluralNoun,
  pathname,
  params,
  label,
}: {
  page: PageResult<T>;
  total: BoundedCount;
  noun: string;
  pluralNoun?: string;
  pathname: string;
  params: Record<string, string | undefined>;
  /** Names the list for screen readers, e.g. "Engagements pagination". */
  label: string;
}): ReactNode {
  const showing =
    page.items.length === 0
      ? `No ${pluralNoun ?? `${noun}s`} on this page`
      : `Showing ${page.firstIndex.toLocaleString('en-CA')}–${page.lastIndex.toLocaleString('en-CA')} of ${formatTotal(total, noun, pluralNoun)}`;

  return (
    <nav
      aria-label={label}
      className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3 text-sm"
    >
      {/* Announced on change: the count is the point of this component, and a
          screen-reader user should not have to hunt for it after paging. */}
      <p aria-live="polite" className="text-slate-600">
        {showing}
        {total.isLowerBound ? (
          <span className="ml-2 text-xs text-slate-500">
            (counting stops at {total.value.toLocaleString('en-CA')}; narrow the filters for an exact number)
          </span>
        ) : null}
      </p>

      <div className="flex items-center gap-2">
        {page.hasPrevious ? (
          <Link className="btn-secondary" href={pageHref(pathname, params, page.page - 1)} rel="prev">
            Previous
          </Link>
        ) : (
          <span className="btn-secondary pointer-events-none opacity-40" aria-disabled="true">
            Previous
          </span>
        )}

        <span className="text-slate-600">Page {page.page.toLocaleString('en-CA')}</span>

        {page.hasNext ? (
          <Link className="btn-secondary" href={pageHref(pathname, params, page.page + 1)} rel="next">
            Next
          </Link>
        ) : (
          <span className="btn-secondary pointer-events-none opacity-40" aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

/**
 * What to show when a page number has run off the end of the list.
 *
 * Showing an empty table is the same silence this whole change is about: it
 * looks identical to a filter that matched nothing.
 */
export function PageOutOfRange({
  pathname,
  params,
  pluralNoun,
}: {
  pathname: string;
  params: Record<string, string | undefined>;
  pluralNoun: string;
}): ReactNode {
  return (
    <p className="rounded border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
      There are no {pluralNoun} on this page — the list ends before it.{' '}
      <Link className="text-brand-700 underline" href={pageHref(pathname, params, 1)}>
        Back to the first page
      </Link>
      .
    </p>
  );
}
