import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boundedCount,
  COUNT_CEILING,
  DEFAULT_PAGE_SIZE,
  formatTotal,
  MAX_PAGE_SIZE,
  pageHref,
  parsePageRequest,
  toPage,
  withStableOrder,
} from '../../apps/web/src/lib/pagination';

/**
 * Pagination.
 *
 * The point of this code is that a list never stops without saying so, so the
 * tests are mostly about what it refuses to do quietly.
 */

describe('reading the page from the query string', () => {
  it('starts at the first page with a sensible size', () => {
    expect(parsePageRequest({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
      take: DEFAULT_PAGE_SIZE + 1,
    });
  });

  it('asks for one row more than it shows, which is how it knows there is a next page', () => {
    const request = parsePageRequest({ pageSize: '25' });
    expect(request.take).toBe(26);
  });

  it('skips whole pages, so page 3 of 50 starts at row 101', () => {
    const request = parsePageRequest({ page: '3', pageSize: '50' });
    expect(request.skip).toBe(100);
  });

  it('treats nonsense as the first page rather than failing or showing nothing', () => {
    for (const page of ['0', '-4', 'abc', '', 'NaN', '1e10000']) {
      expect(parsePageRequest({ page }).page).toBe(1);
    }
  });

  it('caps the page size, so a hand-edited URL cannot ask for the whole table', () => {
    expect(parsePageRequest({ pageSize: '100000' }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(parsePageRequest({ pageSize: '-1' }).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('keeps skip a usable integer however large the page asked for', () => {
    const request = parsePageRequest({ page: '99999999999' });
    expect(Number.isSafeInteger(request.skip)).toBe(true);
  });
});

describe('working out where in the list we are', () => {
  const request = parsePageRequest({ page: '2', pageSize: '10' });

  it('drops the look-ahead row rather than showing eleven rows on a page of ten', () => {
    const rows = Array.from({ length: 11 }, (_, index) => index);
    const page = toPage(rows, request);

    expect(page.items).toHaveLength(10);
    expect(page.hasNext).toBe(true);
  });

  it('knows it is the last page when the extra row does not come back', () => {
    const page = toPage([1, 2, 3], request);

    expect(page.hasNext).toBe(false);
    expect(page.items).toHaveLength(3);
  });

  it('reports the range it is showing, counting from where the page starts', () => {
    const page = toPage(Array.from({ length: 11 }, (_, index) => index), request);

    expect(page.firstIndex).toBe(11);
    expect(page.lastIndex).toBe(20);
  });

  it('reports no range at all when the page is empty, rather than a misleading 1–0', () => {
    const page = toPage([], request);

    expect(page.firstIndex).toBe(0);
    expect(page.lastIndex).toBe(0);
    expect(page.hasNext).toBe(false);
  });

  it('offers no previous link from the first page', () => {
    expect(toPage([1], parsePageRequest({})).hasPrevious).toBe(false);
    expect(toPage([1], parsePageRequest({ page: '2' })).hasPrevious).toBe(true);
  });

  it('does not mutate the rows it was handed', () => {
    const rows = [1, 2, 3];
    toPage(rows, request);
    expect(rows).toEqual([1, 2, 3]);
  });
});

describe('the order the query runs in', () => {
  it('appends a unique tiebreaker, because OFFSET over a tie loses rows', () => {
    expect(withStableOrder([{ createdAt: 'desc' }])).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it("keeps the caller's ordering first, so the tiebreaker only breaks ties", () => {
    expect(withStableOrder([{ taxYear: 'desc' }, { updatedAt: 'desc' }])).toEqual([
      { taxYear: 'desc' },
      { updatedAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('is what the paged lists actually order by', () => {
    // Measured, not assumed: paging 300 audit events written in one transaction
    // without the tiebreaker lost 6 of them and showed 6 twice. A page that
    // reverts to a bare orderBy would silently reintroduce that.
    const root = resolve(import.meta.dirname, '..', '..', 'apps', 'web', 'src', 'app');

    for (const page of ['audit-log/page.tsx', 'engagements/page.tsx']) {
      const source = readFileSync(resolve(root, page), 'utf8');
      expect(source, page).toMatch(/orderBy: withStableOrder\(/);
      expect(source, page).not.toMatch(/orderBy: \{/);
    }
  });
});

describe('counting without counting forever', () => {
  it('reports an exact total below the ceiling', async () => {
    const total = await boundedCount(async () => 42, 100);
    expect(total).toEqual({ value: 42, isLowerBound: false });
  });

  it('stops at the ceiling and says the total is a lower bound', async () => {
    const total = await boundedCount(async () => 101, 100);
    expect(total).toEqual({ value: 100, isLowerBound: true });
  });

  it('asks for one past the ceiling, which is the only way to know it was reached', async () => {
    let requested = 0;
    await boundedCount(async (limit) => {
      requested = limit;
      return 5;
    }, 100);

    expect(requested).toBe(101);
  });

  it('treats exactly the ceiling as exact, not as "more than"', async () => {
    expect(await boundedCount(async () => 100, 100)).toEqual({ value: 100, isLowerBound: false });
  });

  it('defaults to a ceiling that keeps an audit table cheap to count', () => {
    expect(COUNT_CEILING).toBeLessThanOrEqual(10_000);
  });
});

describe('saying how many there are', () => {
  it('says "more than" when the number is a floor, never a bare number', () => {
    expect(formatTotal({ value: 10_000, isLowerBound: true }, 'audit event', 'audit events')).toBe(
      'more than 10,000 audit events',
    );
  });

  it('groups thousands, because 41882 is harder to read than it needs to be', () => {
    expect(formatTotal({ value: 41_882, isLowerBound: false }, 'engagement')).toBe('41,882 engagements');
  });

  it('gets the singular right', () => {
    expect(formatTotal({ value: 1, isLowerBound: false }, 'engagement')).toBe('1 engagement');
    expect(formatTotal({ value: 0, isLowerBound: false }, 'engagement')).toBe('0 engagements');
  });
});

describe('the link to the next page', () => {
  it('carries the filters across, so page two of a filtered list stays filtered', () => {
    const href = pageHref('/engagements', { status: 'IN_REVIEW', year: '2026' }, 2);

    expect(href).toContain('status=IN_REVIEW');
    expect(href).toContain('year=2026');
    expect(href).toContain('page=2');
  });

  it('replaces the page rather than accumulating them', () => {
    const href = pageHref('/audit-log', { page: '7', eventType: 'USER_LOGIN' }, 2);

    expect(href.match(/page=/g)).toHaveLength(1);
    expect(href).toContain('page=2');
  });

  it('leaves page out of the first page, so the plain URL stays the canonical one', () => {
    expect(pageHref('/engagements', {}, 1)).toBe('/engagements');
    expect(pageHref('/engagements', { status: 'APPROVED' }, 1)).toBe('/engagements?status=APPROVED');
  });

  it('drops empty filters rather than putting bare keys in the URL', () => {
    expect(pageHref('/engagements', { status: '', type: undefined, year: '2026' }, 2)).toBe(
      '/engagements?year=2026&page=2',
    );
  });

  it('escapes a value that would otherwise break the query string', () => {
    const href = pageHref('/audit-log', { correlationId: 'a b&c=d' }, 2);

    expect(href).toContain('correlationId=a+b%26c%3Dd');
    expect(new URL(href, 'https://example.test').searchParams.get('correlationId')).toBe('a b&c=d');
  });
});
