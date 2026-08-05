import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { boundedCount, parsePageRequest, toPage, withStableOrder } from '../../apps/web/src/lib/pagination';

/**
 * Paging over real rows.
 *
 * The property under test is that paging shows every row exactly once. It is
 * not automatic: `ORDER BY created_at DESC` leaves tied rows in no defined
 * sequence, and `OFFSET` over an undefined sequence drops some and repeats
 * others. Ties are guaranteed rather than unlucky — Postgres `now()` is the
 * transaction timestamp, so every audit event written by one bulk rollout
 * shares a `createdAt` to the microsecond.
 *
 * These tests also confirm that a bounded count really is bounded, because a
 * ceiling the database ignores is a ceiling that does nothing.
 */

const prisma = new PrismaClient();

const CORRELATION = `pagination_${randomUUID()}`;
const TOTAL_EVENTS = 25;

let clientId: string;
const engagementIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();

  // One transaction, so every row takes the same transaction timestamp. This is
  // exactly what a bulk rollout does.
  await prisma.$transaction(
    Array.from({ length: TOTAL_EVENTS }, (_, index) =>
      prisma.auditEvent.create({
        data: {
          eventType: 'CONFIGURATION_CHANGED',
          objectType: 'PaginationFixture',
          objectId: `fixture-${String(index).padStart(3, '0')}`,
          correlationId: CORRELATION,
        },
      }),
    ),
  );

  const client = await prisma.client.create({
    data: { legalName: `Pagination Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientId = client.id;

  for (let index = 0; index < 12; index += 1) {
    const engagement = await prisma.engagement.create({
      data: {
        clientId,
        engagementType: 'T2',
        taxYear: 2019 + index,
        yearEnd: new Date(Date.UTC(2019 + index, 2, 31)),
        status: 'NOT_STARTED',
        isTestMode: true,
      },
    });
    engagementIds.push(engagement.id);
  }
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  // Audit events cannot be deleted — the immutability trigger refuses — so the
  // fixture rows stay. They are scoped to a unique correlation id for that
  // reason, and every query here is filtered by it.
  await prisma.$disconnect();
});

/** Walks every page the way a reader clicking "Next" would. */
async function readEveryPage(pageSize: number): Promise<string[]> {
  const seen: string[] = [];

  for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
    const request = parsePageRequest({ page: String(pageNumber), pageSize: String(pageSize) });

    const rows = await prisma.auditEvent.findMany({
      where: { correlationId: CORRELATION },
      orderBy: withStableOrder([{ createdAt: 'desc' as const }]),
      skip: request.skip,
      take: request.take,
    });

    const page = toPage(rows, request);
    seen.push(...page.items.map((event) => event.objectId as string));

    if (!page.hasNext) break;
  }

  return seen;
}

describe('paging over rows written in the same transaction', () => {
  it('shows every event exactly once, though every timestamp is identical', async () => {
    const timestamps = await prisma.auditEvent.findMany({
      where: { correlationId: CORRELATION },
      select: { createdAt: true },
    });
    const distinct = new Set(timestamps.map((row) => row.createdAt.toISOString()));

    // The premise. If this ever stops holding the test below stops proving
    // anything, so it is asserted rather than assumed.
    expect(distinct.size).toBe(1);

    const seen = await readEveryPage(4);

    expect(seen).toHaveLength(TOTAL_EVENTS);
    expect(new Set(seen).size).toBe(TOTAL_EVENTS);
  });

  it('reads the same sequence whichever page size it is read at', async () => {
    const byFour = await readEveryPage(4);
    const bySeven = await readEveryPage(7);
    const byThirty = await readEveryPage(30);

    expect(bySeven).toEqual(byFour);
    expect(byThirty).toEqual(byFour);
  });

  it('never repeats a row between one page and the next', async () => {
    const first = await prisma.auditEvent.findMany({
      where: { correlationId: CORRELATION },
      orderBy: withStableOrder([{ createdAt: 'desc' as const }]),
      skip: 0,
      take: 10,
    });
    const second = await prisma.auditEvent.findMany({
      where: { correlationId: CORRELATION },
      orderBy: withStableOrder([{ createdAt: 'desc' as const }]),
      skip: 10,
      take: 10,
    });

    const overlap = first.map((row) => row.id).filter((id) => second.some((row) => row.id === id));
    expect(overlap).toEqual([]);
  });
});

describe('knowing there is a next page', () => {
  it('says so without a second query, by asking for one row more than it shows', async () => {
    const request = parsePageRequest({ pageSize: '10' });

    const rows = await prisma.auditEvent.findMany({
      where: { correlationId: CORRELATION },
      orderBy: withStableOrder([{ createdAt: 'desc' as const }]),
      skip: request.skip,
      take: request.take,
    });

    expect(rows).toHaveLength(11);
    expect(toPage(rows, request).items).toHaveLength(10);
    expect(toPage(rows, request).hasNext).toBe(true);
  });

  it('reports no next page on the last one, so the reader knows the list has ended', async () => {
    const request = parsePageRequest({ page: '3', pageSize: '10' });

    const rows = await prisma.auditEvent.findMany({
      where: { correlationId: CORRELATION },
      orderBy: withStableOrder([{ createdAt: 'desc' as const }]),
      skip: request.skip,
      take: request.take,
    });

    const page = toPage(rows, request);
    expect(page.items).toHaveLength(TOTAL_EVENTS - 20);
    expect(page.hasNext).toBe(false);
  });
});

describe('counting up to a ceiling', () => {
  it('really stops at the ceiling, rather than the database ignoring the limit', async () => {
    const total = await boundedCount(
      (limit) => prisma.auditEvent.count({ where: { correlationId: CORRELATION }, take: limit }),
      10,
    );

    // 25 rows exist; asked to count no more than 10, it must report the floor.
    expect(total).toEqual({ value: 10, isLowerBound: true });
  });

  it('gives the exact number when the list fits under the ceiling', async () => {
    const total = await boundedCount(
      (limit) => prisma.auditEvent.count({ where: { correlationId: CORRELATION }, take: limit }),
      1_000,
    );

    expect(total).toEqual({ value: TOTAL_EVENTS, isLowerBound: false });
  });

  it('counts what the filter matches, not the whole table', async () => {
    const total = await boundedCount(
      (limit) => prisma.auditEvent.count({ where: { correlationId: 'no-such-correlation' }, take: limit }),
      1_000,
    );

    expect(total).toEqual({ value: 0, isLowerBound: false });
  });
});

describe('paging engagements', () => {
  it('walks the whole list once, newest tax year first', async () => {
    const seen: number[] = [];

    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      const request = parsePageRequest({ page: String(pageNumber), pageSize: '5' });

      const rows = await prisma.engagement.findMany({
        where: { clientId },
        orderBy: withStableOrder([{ taxYear: 'desc' as const }, { updatedAt: 'desc' as const }]),
        skip: request.skip,
        take: request.take,
      });

      const page = toPage(rows, request);
      seen.push(...page.items.map((engagement) => engagement.taxYear));
      if (!page.hasNext) break;
    }

    expect(seen).toHaveLength(engagementIds.length);
    expect(new Set(seen).size).toBe(engagementIds.length);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  it('counts the filtered list, so the total matches what is being paged', async () => {
    const total = await boundedCount((limit) => prisma.engagement.count({ where: { clientId }, take: limit }));

    expect(total).toEqual({ value: engagementIds.length, isLowerBound: false });
  });
});
