import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import {
  DocumentStore,
  TemplatePreviewService,
  TemplatePublishService,
  readTemplateSource,
  templateSourceCandidates,
} from '@element/services';
import { getPartText, MAIN_DOCUMENT_PART, isPdf, libreOfficeConverter, readDocx, setPartText, writeDocx } from '@element/documents';
import type { Principal } from '@element/shared';

/**
 * Reading an approved master template.
 *
 * Two things are asserted here. That a template version can be read at all —
 * which is what makes activating a draft an informed decision rather than a
 * leap of faith. And that reading it works for an *uploaded* version, not only
 * a seeded one, because those two record the location of their file in
 * completely different ways and only one of them was ever exercised.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const store = new DocumentStore({
  prisma,
  rootDirectory: mkdtempSync(join(tmpdir(), 'template-reading-store-')),
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: '3'.repeat(64),
});

const templateDirectory = join(process.cwd(), 'templates', 'normalized');
const publishing = new TemplatePublishService({ prisma, audit, store });
const previews = new TemplatePreviewService({
  prisma,
  store,
  pdfConverter: libreOfficeConverter({ tempDirectory: mkdtempSync(join(tmpdir(), 'template-reading-tmp-')) }),
  templateDirectory,
  cacheDirectory: mkdtempSync(join(tmpdir(), 'template-reading-cache-')),
});

const suffix = randomUUID().slice(0, 8);
const emails = { uploader: `reading-uploader-${suffix}@template.test` };

let uploader: Principal;
let templateId: string;
let seededVersionId: string;
let revisedSource: Buffer;

async function reviseDocx(original: Buffer, from: string, to: string): Promise<Buffer> {
  const parts = await readDocx(original);
  const xml = getPartText(parts, MAIN_DOCUMENT_PART);
  if (!xml.includes(from)) throw new Error(`The fixture text ${from} is not in the template.`);
  setPartText(parts, MAIN_DOCUMENT_PART, xml.replaceAll(from, to));
  return writeDocx(parts);
}

beforeAll(async () => {
  await prisma.$connect();

  const user = await prisma.user.upsert({
    where: { email: emails.uploader },
    create: { email: emails.uploader, displayName: emails.uploader },
    update: {},
  });
  uploader = { id: user.id, email: emails.uploader, displayName: emails.uploader, roles: ['ADMINISTRATOR'] };

  const source = await readFile(join(process.cwd(), 'templates', 'source', 'T2 Engagement Letter.docx'));
  revisedSource = await reviseDocx(source, 'Element Accounting', 'Element Accounting Professional Corporation');

  const template = await prisma.documentTemplate.findFirstOrThrow({
    where: { documentType: 'T2_ENGAGEMENT_LETTER' },
    include: { versions: { where: { status: 'ACTIVE' } } },
  });
  templateId = template.id;
  seededVersionId = template.versions[0]?.id ?? '';
});

async function resetVersions(): Promise<void> {
  await prisma.templateVersion.deleteMany({ where: { templateId, id: { not: seededVersionId } } });
  await prisma.templateVersion.update({
    where: { id: seededVersionId },
    data: { status: 'ACTIVE', retiredAt: null, activatedAt: new Date() },
  });
}

beforeEach(resetVersions);

afterAll(async () => {
  await resetVersions();
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await prisma.$disconnect();
});

describe('locating the file a version was published from', () => {
  it('treats an absolute path as a path and a relative one as a store reference', () => {
    // The two are not interchangeable, and the column holds both. Reading a
    // store reference as a path resolves it against the process working
    // directory, which is how an uploaded template became "missing on the
    // server" the moment somebody activated it.
    const seeded = templateSourceCandidates(
      { normalizedPath: '/srv/app/templates/normalized/T2.docx', sourceFileName: 'T2.docx' },
      '/app/templates/normalized',
    );
    expect(seeded[0]).toEqual({ kind: 'file', path: '/srv/app/templates/normalized/T2.docx' });

    const uploaded = templateSourceCandidates(
      { normalizedPath: 'template-abc/uuid-T2.docx', sourceFileName: 'T2.docx' },
      '/app/templates/normalized',
    );
    expect(uploaded[0]).toEqual({ kind: 'store', reference: 'template-abc/uuid-T2.docx' });
  });

  it('always ends at the shipped copy, so a path from another machine is survivable', () => {
    // The seed records the absolute path of whichever machine ran it. Restore
    // that database onto a different host and the path is fiction; the bytes
    // are still in the image under the name the manifest records.
    const candidates = templateSourceCandidates(
      { normalizedPath: '/some/other/host/templates/normalized/T2.docx', sourceFileName: 'T2 Engagement Letter.docx' },
      '/app/templates/normalized',
    );
    expect(candidates.at(-1)).toEqual({
      kind: 'file',
      path: '/app/templates/normalized/T2 Engagement Letter.docx',
    });
  });

  it('reads a seeded version from disk', async () => {
    const version = await prisma.templateVersion.findUniqueOrThrow({ where: { id: seededVersionId } });
    const docx = await readTemplateSource(
      { normalizedPath: version.normalizedPath, sourceFileName: version.sourceFileName ?? '' },
      { store, templateDirectory },
    );
    expect(docx.byteLength).toBeGreaterThan(1_000);
  });

  it('recovers when the recorded path does not exist on this machine', async () => {
    const version = await prisma.templateVersion.findUniqueOrThrow({ where: { id: seededVersionId } });
    const docx = await readTemplateSource(
      { normalizedPath: '/nowhere/at/all/T2 Engagement Letter.docx', sourceFileName: version.sourceFileName ?? '' },
      { store, templateDirectory },
    );
    expect(docx.byteLength).toBeGreaterThan(1_000);
  });

  it('says where it looked when it genuinely cannot find the file', async () => {
    await expect(
      readTemplateSource({ normalizedPath: '/nowhere/x.docx', sourceFileName: 'not-a-real-file.docx' }, { store, templateDirectory }),
    ).rejects.toThrow(/could not be read/i);
  });
});

describe('reading an uploaded version', () => {
  it('reads back the bytes that were uploaded, not the seeded template', async () => {
    // The regression this suite exists for: an uploaded version records a
    // store reference, and reading the column as a filesystem path failed.
    // Revising a template is the only way to produce one, so the failure was
    // reserved for a firm changing its own legal wording.
    const draft = await publishing.uploadDraft({
      documentType: 'T2_ENGAGEMENT_LETTER',
      fileName: 'T2 Engagement Letter.docx',
      content: revisedSource,
      notes: 'Firm name updated to the full legal name.',
      actor: uploader,
    });

    const version = await prisma.templateVersion.findUniqueOrThrow({ where: { id: draft.templateVersionId } });

    // The defect, stated directly: what the column holds is not a path, so the
    // `readFile(version.normalizedPath)` the generator used could only fail.
    expect(isAbsolute(version.normalizedPath ?? '')).toBe(false);
    await expect(readFile(version.normalizedPath ?? '')).rejects.toThrow();

    const docx = await readTemplateSource(
      { normalizedPath: version.normalizedPath, sourceFileName: version.sourceFileName ?? '' },
      { store, templateDirectory },
    );

    const xml = getPartText(await readDocx(docx), MAIN_DOCUMENT_PART);
    expect(xml).toContain('Element Accounting Professional Corporation');
  });
});

describe('the preview', () => {
  it('converts the active template to a readable PDF', async () => {
    const preview = await previews.pdf(seededVersionId);

    expect(isPdf(preview.content)).toBe(true);
    expect(preview.content.byteLength).toBeGreaterThan(5_000);
    expect(preview.fileName).toMatch(/\.pdf$/);
    expect(preview.versionNumber).toBe(1);
  });

  it('serves the second request from the cache, byte for byte', async () => {
    const first = await previews.pdf(seededVersionId);
    const second = await previews.pdf(seededVersionId);
    expect(second.content.equals(first.content)).toBe(true);
  });

  it('gives a draft its own preview rather than the active version’s', async () => {
    // Caching on the content hash rather than the version id is what makes
    // this true; keying on anything coarser would show a reviewer the wording
    // they already have while asking them to approve different wording.
    const draft = await publishing.uploadDraft({
      documentType: 'T2_ENGAGEMENT_LETTER',
      fileName: 'T2 Engagement Letter.docx',
      content: revisedSource,
      notes: 'Firm name updated.',
      actor: uploader,
    });

    const activePreview = await previews.pdf(seededVersionId);
    const draftPreview = await previews.pdf(draft.templateVersionId);

    expect(isPdf(draftPreview.content)).toBe(true);
    expect(draftPreview.content.equals(activePreview.content)).toBe(false);
  });

  it('returns the Word source for someone who intends to revise it', async () => {
    const source = await previews.docx(seededVersionId);
    expect(source.fileName).toMatch(/\.docx$/);
    // A real OOXML package, not a PDF with the wrong name on it.
    expect(source.content.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('refuses a version that does not exist', async () => {
    await expect(previews.pdf(randomUUID())).rejects.toThrow(/does not exist/i);
  });
});
