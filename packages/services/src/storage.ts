import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import type { PrismaClient } from '@element/database';
import { AppError, ValidationError, sha256Hex, signPayload, verifySignature } from '@element/shared';

/**
 * Temporary document storage.
 *
 * Karbon is the permanent home for final and signed files. This store holds
 * working copies only, for as long as the workflow needs them, and everything
 * in it is purged after the configured retention period.
 *
 * The bytes live in Postgres. They lived on the container filesystem, which is
 * correct on one machine and quietly wrong on a platform that runs the web and
 * the worker as separate services — the web uploads a source document the
 * worker cannot read, the worker generates a PDF the web cannot serve. A
 * mounted volume does not fix it: Railway attaches a volume to exactly one
 * service, so a volume on each is two separate disks and the files never meet.
 * Postgres is the one store both services already share.
 *
 * Reads fall back to the filesystem, so anything written before this change is
 * still readable from a volume that still has it.
 *
 * Downloads are served through short-lived signed links rather than direct
 * paths, so a document reference cannot be shared or guessed.
 */

const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
]);

const MAGIC_NUMBERS: { mime: string; prefix: number[] }[] = [
  { mime: 'application/pdf', prefix: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    prefix: [0x50, 0x4b, 0x03, 0x04], // PK.. (ZIP container)
  },
];

export interface StoredFile {
  /** Opaque reference persisted on the document version. */
  reference: string;
  hash: string;
  byteSize: number;
  mimeType: string;
  fileName: string;
  expiresAt: Date;
}

export interface DocumentStoreOptions {
  prisma: PrismaClient;
  /**
   * Only used to read documents written before storage moved into Postgres.
   * Nothing is written here any more.
   */
  rootDirectory: string;
  retentionHours: number;
  maxBytes: number;
  signingSecret: string;
}

/** Validates that the bytes really are the type they claim to be. */
export function detectMimeType(data: Uint8Array): string | null {
  for (const candidate of MAGIC_NUMBERS) {
    const matches = candidate.prefix.every((byte, index) => data[index] === byte);
    if (matches) return candidate.mime;
  }
  return null;
}

export class DocumentStore {
  constructor(private readonly options: DocumentStoreOptions) {}

  private pathFor(reference: string): string {
    // Defend against traversal: the resolved path must stay inside the root.
    const root = resolve(this.options.rootDirectory);
    const candidate = resolve(join(root, normalize(reference)));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new ValidationError('Invalid document reference.');
    }
    return candidate;
  }

  async put(input: {
    content: Uint8Array | Buffer;
    fileName: string;
    mimeType: string;
    /** Groups files so an engagement's scratch space can be purged together. */
    scope: string;
  }): Promise<StoredFile> {
    const data = Buffer.from(input.content);

    if (data.byteLength === 0) throw new ValidationError('Refusing to store an empty file.');
    if (data.byteLength > this.options.maxBytes) {
      // Not monetary arithmetic: this formats a size limit for a message.
      // eslint-disable-next-line no-restricted-syntax
      const limitInMegabytes = Math.round(this.options.maxBytes / 1024 / 1024);
      throw new ValidationError(`The file is larger than the ${limitInMegabytes} MB limit.`);
    }
    if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
      throw new ValidationError(`Files of type ${input.mimeType} are not accepted.`);
    }

    const detected = detectMimeType(data);
    if (detected !== input.mimeType) {
      throw new ValidationError(
        'The file contents do not match the declared file type. It was not stored.',
      );
    }

    const scope = sanitizeScope(input.scope);
    // The reference keeps its path-like shape so references already persisted
    // on document versions and source documents stay valid.
    const reference = join(scope, `${randomUUID()}-${sanitizeName(input.fileName)}`);
    const expiresAt = new Date(Date.now() + this.options.retentionHours * 3_600_000);
    const hash = sha256Hex(data);

    await this.options.prisma.storedDocument.create({
      data: {
        reference,
        scope,
        content: data,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: data.byteLength,
        sha256: hash,
        expiresAt,
      },
    });

    return {
      reference,
      hash,
      byteSize: data.byteLength,
      mimeType: input.mimeType,
      fileName: input.fileName,
      expiresAt,
    };
  }

  async get(reference: string): Promise<Buffer> {
    const row = await this.options.prisma.storedDocument.findUnique({
      where: { reference },
      select: { content: true },
    });
    if (row) return Buffer.from(row.content);

    // Resolved before the try, so a reference trying to climb out of the root
    // is reported as the invalid reference it is. Inside, its ValidationError
    // was caught and rewrapped as "this working copy has expired" — true of
    // nothing, and it hid a caller passing something it should never have.
    const path = this.pathFor(reference);

    // Written before storage moved into Postgres. Only reachable on the service
    // whose volume holds it, which is exactly the problem this replaced — but a
    // document that is still there should still open.
    try {
      return await readFile(path);
    } catch (error) {
      throw new AppError('The stored document is no longer available.', {
        category: 'NOT_FOUND',
        userMessage:
          'This working copy has passed its retention period. Regenerate the document, or open the copy held in Karbon.',
        cause: error,
      });
    }
  }

  async exists(reference: string): Promise<boolean> {
    const found = await this.options.prisma.storedDocument.findUnique({
      where: { reference },
      select: { reference: true },
    });
    if (found) return true;

    try {
      await readFile(this.pathFor(reference));
      return true;
    } catch {
      return false;
    }
  }

  async delete(reference: string): Promise<void> {
    await this.options.prisma.storedDocument.deleteMany({ where: { reference } });
    // Best effort: a legacy copy on this service's disk, if there is one.
    await rm(this.pathFor(reference), { force: true }).catch(() => undefined);
  }

  /** Removes an engagement's entire scratch space. */
  async purgeScope(scope: string): Promise<void> {
    const cleaned = sanitizeScope(scope);
    await this.options.prisma.storedDocument.deleteMany({ where: { scope: cleaned } });
    await rm(this.pathFor(cleaned), { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Deletes everything past its retention date and reports how much went.
   *
   * The purge job used to walk the filesystem; the rows are the record now.
   */
  async purgeExpired(now = new Date()): Promise<number> {
    const { count } = await this.options.prisma.storedDocument.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }

  // ---- Signed temporary links --------------------------------------------

  createSignedLink(reference: string, ttlSeconds = 300): { reference: string; expires: number; signature: string } {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    return {
      reference,
      expires,
      signature: signPayload(`${reference}:${expires}`, this.options.signingSecret),
    };
  }

  verifySignedLink(reference: string, expires: number, signature: string): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    return verifySignature(`${reference}:${expires}`, signature, this.options.signingSecret);
  }
}

function sanitizeScope(scope: string): string {
  const cleaned = scope.replace(/[^A-Za-z0-9_-]/g, '');
  if (!cleaned) throw new ValidationError('Invalid storage scope.');
  return cleaned;
}

function sanitizeName(fileName: string): string {
  return (
    fileName
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .slice(-80) || 'document'
  );
}

/** Stable content fingerprint used for stale-source detection. */
export function fingerprint(...values: (string | null | undefined)[]): string {
  return createHash('sha256').update(values.map((value) => value ?? '').join('|'), 'utf8').digest('hex');
}
