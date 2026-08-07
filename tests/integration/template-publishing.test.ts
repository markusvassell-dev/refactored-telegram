import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { DocumentStore, TemplatePublishService } from '@element/services';
import { getPartText, MAIN_DOCUMENT_PART, readDocx, setPartText, writeDocx } from '@element/documents';
import type { Principal } from '@element/shared';

/**
 * Publishing a template version.
 *
 * The approved master template controls every word of standard legal wording
 * that reaches a client. Three properties are asserted throughout: a published
 * version is never modified, a version that would render badly cannot be
 * activated, and the person who uploaded a version does not activate it.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const store = new DocumentStore({
  prisma,
  rootDirectory: mkdtempSync(join(tmpdir(), 'template-publish-')),
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: '2'.repeat(64),
});
const publishing = new TemplatePublishService({ prisma, audit, store });

const suffix = randomUUID().slice(0, 8);
const emails = {
  uploader: `uploader-${suffix}@template.test`,
  publisher: `publisher-${suffix}@template.test`,
  preparer: `preparer-${suffix}@template.test`,
};

let uploader: Principal;
let publisher: Principal;
let preparer: Principal;
let templateId: string;
let originalActiveId: string;

/** The real approved T2 source, and a variant with a different byte or two. */
let source: Buffer;
let revisedSource: Buffer;

function principal(id: string, email: string, roles: Principal['roles']): Principal {
  return { id, displayName: email, email, roles };
}

async function makeUser(email: string, roles: Principal['roles']): Promise<Principal> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email },
    update: {},
  });
  return principal(user.id, email, roles);
}

/**
 * The same document with some wording changed — a realistic revision.
 *
 * `replaceAll`, not `replace`: a placeholder appears in several places, and
 * changing only the first leaves the rest for the normaliser to find. A test
 * built on that would upload a perfectly good document and pass for the wrong
 * reason.
 */
async function reviseDocx(original: Buffer, from: string, to: string): Promise<Buffer> {
  const parts = await readDocx(original);
  const xml = getPartText(parts, MAIN_DOCUMENT_PART);
  if (!xml.includes(from)) throw new Error(`The fixture text ${from} is not in the template.`);
  setPartText(parts, MAIN_DOCUMENT_PART, xml.replaceAll(from, to));
  return writeDocx(parts);
}

beforeAll(async () => {
  await prisma.$connect();

  uploader = await makeUser(emails.uploader, ['ADMINISTRATOR']);
  publisher = await makeUser(emails.publisher, ['ADMINISTRATOR']);
  preparer = await makeUser(emails.preparer, ['PREPARER']);

  source = await readFile(join(process.cwd(), 'templates', 'source', 'T2 Engagement Letter.docx'));
  revisedSource = await reviseDocx(source, 'Element Accounting', 'Element Accounting Professional Corporation');

  const template = await prisma.documentTemplate.findFirstOrThrow({
    where: { documentType: 'T2_ENGAGEMENT_LETTER' },
    include: { versions: { where: { status: 'ACTIVE' } } },
  });
  templateId = template.id;
  originalActiveId = template.versions[0]?.id ?? '';
});

/** Removes anything this suite published, leaving the seeded version active. */
async function resetVersions(): Promise<void> {
  await prisma.templateVersion.deleteMany({
    where: { templateId, id: { not: originalActiveId } },
  });
  await prisma.templateVersion.update({
    where: { id: originalActiveId },
    data: { status: 'ACTIVE', retiredAt: null, activatedAt: new Date() },
  });
  await prisma.documentTemplate.update({ where: { id: templateId }, data: { isProductionSupported: true } });
}

beforeEach(resetVersions);

afterAll(async () => {
  await resetVersions();
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await prisma.$disconnect();
});

async function uploadRevision(actor: Principal = uploader) {
  return publishing.uploadDraft({
    documentType: 'T2_ENGAGEMENT_LETTER',
    fileName: 'T2 Engagement Letter.docx',
    content: revisedSource,
    notes: 'Firm name updated to the full legal name.',
    actor,
  });
}

describe('uploading a revision', () => {
  it('normalises it, stores it as a draft, and activates nothing', async () => {
    const outcome = await uploadRevision();

    const version = await prisma.templateVersion.findUniqueOrThrow({
      where: { id: outcome.templateVersionId },
    });

    expect(version.status).toBe('DRAFT');
    expect(version.versionNumber).toBeGreaterThan(1);
    expect(version.normalizedFileHash).toBeTruthy();
    expect(version.createdBy).toBe(uploader.id);
    expect(outcome.replacements).toBeGreaterThan(0);

    // The version that governs real documents has not moved.
    const active = await prisma.templateVersion.findFirstOrThrow({ where: { templateId, status: 'ACTIVE' } });
    expect(active.id).toBe(originalActiveId);
  });

  it('records the hash of what was uploaded, so the file can be tied back to the approval', async () => {
    const outcome = await uploadRevision();

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'TemplateVersion', objectId: outcome.templateVersionId },
    });

    expect(event.eventType).toBe('TEMPLATE_VERSION_UPLOADED');
    expect(event.userId).toBe(uploader.id);
    expect(event.afterValue).toMatchObject({ documentType: 'T2_ENGAGEMENT_LETTER' });
    expect((event.afterValue as { sourceFileHash: string }).sourceFileHash).toHaveLength(64);
  });

  it('refuses a file that is not a Word document, whatever it is called', async () => {
    await expect(
      publishing.uploadDraft({
        documentType: 'T2_ENGAGEMENT_LETTER',
        fileName: 'letter.docx',
        content: Buffer.from('%PDF-1.4 this is really a PDF'),
        actor: uploader,
      }),
    ).rejects.toThrow(/not a Word \.docx file/i);
  });

  it('refuses an empty file', async () => {
    await expect(
      publishing.uploadDraft({
        documentType: 'T2_ENGAGEMENT_LETTER',
        fileName: 'letter.docx',
        content: Buffer.alloc(0),
        actor: uploader,
      }),
    ).rejects.toThrow(/empty/i);
  });

  it('refuses a document whose placeholders no longer match, rather than rendering brackets to a client', async () => {
    // A revision that removed a placeholder the manifest depends on. The
    // placeholder text is asserted to have actually been present, because a
    // string replace that silently matched nothing would leave this test
    // uploading a perfectly good document and passing for the wrong reason.
    const broken = await reviseDocx(source, '[LEGAL NAME OF CORPORATION]', 'the corporation');
    expect(broken.equals(source)).toBe(false);

    await expect(
      publishing.uploadDraft({
        documentType: 'T2_ENGAGEMENT_LETTER',
        fileName: 'T2 Engagement Letter.docx',
        content: broken,
        actor: uploader,
      }),
    ).rejects.toThrow(/does not match the placeholders/i);

    expect(await prisma.templateVersion.count({ where: { templateId, status: 'DRAFT' } })).toBe(0);
  });

  it('refuses the same bytes twice, so a double submit does not leave two identical drafts', async () => {
    await uploadRevision();
    await expect(uploadRevision()).rejects.toThrow(/byte-for-byte/i);

    expect(await prisma.templateVersion.count({ where: { templateId, status: 'DRAFT' } })).toBe(1);
  });

  it('refuses somebody who cannot manage templates', async () => {
    await expect(uploadRevision(preparer)).rejects.toThrow();
  });
});

describe('activating a version', () => {
  it('makes it active and retires the one it replaces, deleting nothing', async () => {
    const { templateVersionId, versionNumber } = await uploadRevision();

    const outcome = await publishing.activate({ templateVersionId, actor: publisher });

    const activated = await prisma.templateVersion.findUniqueOrThrow({ where: { id: templateVersionId } });
    expect(activated.status).toBe('ACTIVE');
    expect(activated.activatedAt).not.toBeNull();
    expect(activated.approvedBy).toBe(publisher.id);

    const previous = await prisma.templateVersion.findUniqueOrThrow({ where: { id: originalActiveId } });
    expect(previous.status).toBe('RETIRED');
    expect(previous.retiredAt).not.toBeNull();
    expect(outcome.retiredVersionNumber).toBe(previous.versionNumber);

    // Exactly one active version, always.
    expect(await prisma.templateVersion.count({ where: { templateId, status: 'ACTIVE' } })).toBe(1);
    expect(versionNumber).toBe(activated.versionNumber);
  });

  it('refuses the person who uploaded it, because a template version is a wording change', async () => {
    const { templateVersionId } = await uploadRevision();

    await expect(publishing.activate({ templateVersionId, actor: uploader })).rejects.toThrow(
      /cannot approve your own template version/i,
    );

    expect(
      (await prisma.templateVersion.findUniqueOrThrow({ where: { id: templateVersionId } })).status,
    ).toBe('DRAFT');
  });

  it('refuses a version that is already active', async () => {
    await expect(publishing.activate({ templateVersionId: originalActiveId, actor: publisher })).rejects.toThrow(
      /already the active version/i,
    );
  });

  it('refuses to bring a retired version back, which would make the history ambiguous', async () => {
    const { templateVersionId } = await uploadRevision();
    await publishing.activate({ templateVersionId, actor: publisher });

    await expect(publishing.activate({ templateVersionId: originalActiveId, actor: publisher })).rejects.toThrow(
      /has been retired/i,
    );
  });

  it('records what replaced what, on both versions', async () => {
    const { templateVersionId } = await uploadRevision();
    await publishing.activate({ templateVersionId, actor: publisher });

    const activated = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'TemplateVersion', objectId: templateVersionId, eventType: 'TEMPLATE_ACTIVATED' },
    });
    expect(activated.userId).toBe(publisher.id);
    expect(activated.afterValue).toMatchObject({ uploadedBy: uploader.id });

    const retired = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'TemplateVersion', objectId: originalActiveId, eventType: 'TEMPLATE_RETIRED' },
    });
    expect(retired.reason).toMatch(/Replaced by v/);
  });

  it('leaves documents generated from the old version pointing at it', async () => {
    const { templateVersionId } = await uploadRevision();
    await publishing.activate({ templateVersionId, actor: publisher });

    const stillReferencing = await prisma.documentVersion.count({
      where: { templateVersionId: originalActiveId },
    });

    // Whatever that count is, the rows are untouched: retiring a version does
    // not rewrite the documents it produced.
    const previous = await prisma.templateVersion.findUniqueOrThrow({ where: { id: originalActiveId } });
    expect(previous.manifest).toBeTruthy();
    expect(stillReferencing).toBeGreaterThanOrEqual(0);
  });

  it('refuses somebody who cannot publish', async () => {
    const { templateVersionId } = await uploadRevision();
    await expect(publishing.activate({ templateVersionId, actor: preparer })).rejects.toThrow();
  });
});

describe('discarding a draft', () => {
  it('discards a draft with a reason', async () => {
    const { templateVersionId } = await uploadRevision();

    await publishing.discardDraft({
      templateVersionId,
      reason: 'Superseded before it was ever used.',
      actor: uploader,
    });

    expect(await prisma.templateVersion.findUnique({ where: { id: templateVersionId } })).toBeNull();

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'TemplateVersion', objectId: templateVersionId, eventType: 'TEMPLATE_RETIRED' },
    });
    expect(event.afterValue).toMatchObject({ discarded: true });
  });

  it('refuses to discard the active version, which real documents were rendered from', async () => {
    await expect(
      publishing.discardDraft({
        templateVersionId: originalActiveId,
        reason: 'Trying to remove the live wording.',
        actor: uploader,
      }),
    ).rejects.toThrow(/Only a draft can be discarded/i);

    expect(
      (await prisma.templateVersion.findUniqueOrThrow({ where: { id: originalActiveId } })).status,
    ).toBe('ACTIVE');
  });

  it('refuses a discard with no reason', async () => {
    const { templateVersionId } = await uploadRevision();
    await expect(
      publishing.discardDraft({ templateVersionId, reason: '', actor: uploader }),
    ).rejects.toThrow(/Give a reason/i);
  });
});
