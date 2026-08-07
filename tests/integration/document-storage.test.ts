import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { DocumentStore } from '@element/services';
import { AppError, ValidationError } from '@element/shared';

/**
 * Where a working document actually lives.
 *
 * It lived on the container filesystem, which is correct on one machine and
 * quietly wrong on a platform that runs the web and the worker as separate
 * services. Four paths cross that boundary: the web uploads a source document
 * and the worker extracts from it; the worker generates a PDF and the web
 * serves it to a reviewer; the web uploads a template draft and the worker
 * renders from it; the web records a signed engagement letter and the worker
 * files it into Karbon. Every one of them read a file that was never on the
 * reading service's disk.
 *
 * A mounted volume cannot fix it — Railway attaches a volume to exactly one
 * service, so a volume on each is two separate disks and the files never meet.
 *
 * The whole suite therefore turns on one property: bytes written by one
 * process are readable by a different one that shares nothing but the database.
 */

const prisma = new PrismaClient();
const PDF = Buffer.from('%PDF-1.4 a working document', 'utf8');
const scopes: string[] = [];
let legacyRoot: string;

/** A store as a *separate service* would construct it: same database, its own disk. */
function storeOn(rootDirectory: string): DocumentStore {
  return new DocumentStore({
    prisma,
    rootDirectory,
    retentionHours: 72,
    maxBytes: 25 * 1024 * 1024,
    signingSecret: 'test-signing-secret-test-signing-secret',
  });
}

function newScope(): string {
  const scope = `storagetest${randomUUID().replace(/-/g, '')}`;
  scopes.push(scope);
  return scope;
}

beforeAll(async () => {
  await prisma.$connect();
  legacyRoot = await mkdtemp(join(tmpdir(), 'element-storage-legacy-'));
});

afterAll(async () => {
  await prisma.storedDocument.deleteMany({ where: { scope: { in: scopes } } });
  await rm(legacyRoot, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('a document written by one service and read by another', () => {
  it('is readable from a service that shares only the database', async () => {
    // The web service and the worker, with different disks. This is the whole
    // point: before, the second read failed and the workflow stalled with it.
    const web = storeOn(await mkdtemp(join(tmpdir(), 'element-web-')));
    const worker = storeOn(await mkdtemp(join(tmpdir(), 'element-worker-')));

    const stored = await web.put({
      content: PDF,
      fileName: 'Signed Engagement Letter.pdf',
      mimeType: 'application/pdf',
      scope: newScope(),
    });

    await expect(worker.get(stored.reference)).resolves.toEqual(PDF);
    await expect(worker.exists(stored.reference)).resolves.toBe(true);
  });

  it('reports the same hash and size to both', async () => {
    const web = storeOn(legacyRoot);
    const stored = await web.put({
      content: PDF,
      fileName: 'letter.pdf',
      mimeType: 'application/pdf',
      scope: newScope(),
    });

    const row = await prisma.storedDocument.findUniqueOrThrow({ where: { reference: stored.reference } });
    expect(row.sha256).toBe(stored.hash);
    expect(row.byteSize).toBe(PDF.byteLength);
    expect(Buffer.from(row.content)).toEqual(PDF);
  });
});

describe('what it still refuses to store', () => {
  it('refuses bytes that are not the type they claim to be', async () => {
    // Unchanged by the move, and the check that stands between a renamed file
    // and a client's permanent record.
    const store = storeOn(legacyRoot);

    await expect(
      store.put({
        content: Buffer.from('PK this is really a word file', 'utf8'),
        fileName: 'letter.pdf',
        mimeType: 'application/pdf',
        scope: newScope(),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an empty file, and the database refuses one too', async () => {
    const store = storeOn(legacyRoot);
    const scope = newScope();

    await expect(
      store.put({ content: Buffer.alloc(0), fileName: 'empty.pdf', mimeType: 'application/pdf', scope }),
    ).rejects.toThrow(ValidationError);

    // Defence in depth: a row with no bytes is indistinguishable from one whose
    // write was truncated, so the constraint refuses it whatever the caller does.
    await expect(
      prisma.storedDocument.create({
        data: {
          reference: `${scope}/direct`,
          scope,
          content: Buffer.alloc(0),
          fileName: 'empty.pdf',
          mimeType: 'application/pdf',
          byteSize: 0,
          sha256: 'x',
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a file past the size limit', async () => {
    const store = new DocumentStore({
      prisma,
      rootDirectory: legacyRoot,
      retentionHours: 72,
      maxBytes: 16,
      signingSecret: 'test-signing-secret-test-signing-secret',
    });

    await expect(
      store.put({ content: PDF, fileName: 'letter.pdf', mimeType: 'application/pdf', scope: newScope() }),
    ).rejects.toThrow(/larger than/);
  });
});

describe('reading something that is not there', () => {
  it('says the working copy is gone, and points at Karbon', async () => {
    const store = storeOn(legacyRoot);

    await expect(store.get('nowhere/missing.pdf')).rejects.toThrow(AppError);
    await expect(store.get('nowhere/missing.pdf')).rejects.toThrow(/no longer available/i);
  });

  it('does not let a reference climb out of the storage root', async () => {
    // The reference is a database key now, but it is still interpolated into a
    // path for the legacy fallback, and a traversal there would read any file
    // the process can.
    const store = storeOn(legacyRoot);

    await expect(store.get('../../etc/passwd')).rejects.toThrow(ValidationError);
  });
});

describe('clearing up', () => {
  it('deletes an engagement’s whole scratch space', async () => {
    const store = storeOn(legacyRoot);
    const scope = newScope();

    await store.put({ content: PDF, fileName: 'a.pdf', mimeType: 'application/pdf', scope });
    await store.put({ content: PDF, fileName: 'b.pdf', mimeType: 'application/pdf', scope });
    expect(await prisma.storedDocument.count({ where: { scope } })).toBe(2);

    await store.purgeScope(scope);
    expect(await prisma.storedDocument.count({ where: { scope } })).toBe(0);
  });

  it('purges what is past its retention and leaves what is not', async () => {
    // The backstop for anything whose owning record was removed — a deleted
    // engagement, an abandoned upload — which would otherwise sit in the table
    // for ever with nothing pointing at it.
    const store = storeOn(legacyRoot);
    const scope = newScope();

    const fresh = await store.put({ content: PDF, fileName: 'fresh.pdf', mimeType: 'application/pdf', scope });
    const stale = await store.put({ content: PDF, fileName: 'stale.pdf', mimeType: 'application/pdf', scope });

    await prisma.storedDocument.update({
      where: { reference: stale.reference },
      data: { expiresAt: new Date(Date.now() - 3_600_000) },
    });

    const removed = await store.purgeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);

    await expect(store.exists(stale.reference)).resolves.toBe(false);
    await expect(store.exists(fresh.reference)).resolves.toBe(true);
  });
});
