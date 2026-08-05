import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { CoverLetterNarrativeService } from '@element/services';
import type { Principal } from '@element/shared';

/**
 * Editing the narrative through the service.
 *
 * The properties that matter are about what stays true rather than what
 * changes: only the template's declared narrative can be reached, an edit is
 * never overwritten, and an approved letter cannot change underneath the person
 * who approved it.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const narratives = new CoverLetterNarrativeService({
  prisma,
  audit,
  templateDirectory: join(process.cwd(), 'templates', 'normalized'),
});

let clientId: string;
let engagementId: string;
let packageId: string;
let editor: Principal;
let reader: Principal;

async function principal(email: string, roles: ('PREPARER' | 'REVIEWER' | 'READ_ONLY')[]): Promise<Principal> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email },
    update: {},
  });

  for (const role of roles) {
    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role } },
      create: { userId: user.id, role },
      update: {},
    });
  }

  return { id: user.id, displayName: user.displayName, email: user.email, roles };
}

/** Puts the package back to a clean, unedited, pre-approval state. */
async function resetPackage(): Promise<void> {
  await prisma.coverLetterNarrative.deleteMany({ where: { coverLetterPackageId: packageId } });
  await prisma.coverLetterPackage.update({
    where: { id: packageId },
    data: { status: 'REVIEW_REQUIRED', staleReason: null, markedStaleAt: null, approvedAt: null, approvedByUserId: null },
  });
}

beforeAll(async () => {
  await prisma.$connect();

  editor = await principal('narrative-editor@example.test', ['REVIEWER']);
  reader = await principal('narrative-reader@example.test', ['READ_ONLY']);

  const client = await prisma.client.create({
    data: { legalName: `Narrative Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientId = client.id;

  const engagement = await prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T1_SINGLE',
      taxYear: 2026,
      yearEnd: new Date(Date.UTC(2026, 11, 31)),
      status: 'NOT_STARTED',
      isTestMode: true,
    },
  });
  engagementId = engagement.id;

  const record = await prisma.coverLetterPackage.create({
    data: {
      engagementId,
      documentType: 'T1_COVER_LETTER',
      status: 'REVIEW_REQUIRED',
      idempotencyKey: `narrative_${randomUUID()}`,
    },
  });
  packageId = record.id;
});

afterAll(async () => {
  // `client` has no cascade from `engagement`, so a fixture engagement left
  // behind strands its client too — and the browser tests share this database.
  // A stray engagement there is not a tidiness problem: it changes which row a
  // list shows first, and a suite that opens "the first engagement" then reads
  // the wrong one.
  //
  // Deleting by name rather than by the ids this run created also sweeps up
  // anything an earlier interrupted run left.
  const clients = await prisma.client.findMany({
    where: { legalName: { startsWith: 'Narrative Co ' } },
    select: { id: true },
  });
  const clientIds = clients.map((record) => record.id).concat(clientId);

  const engagements = await prisma.engagement.findMany({
    where: { clientId: { in: clientIds } },
    select: { id: true },
  });
  const engagementIds = engagements.map((record) => record.id);

  const packages = await prisma.coverLetterPackage.findMany({
    where: { engagementId: { in: engagementIds } },
    select: { id: true },
  });

  await prisma.coverLetterNarrative.deleteMany({
    where: { coverLetterPackageId: { in: packages.map((record) => record.id) } },
  });
  await prisma.coverLetterPackage.deleteMany({ where: { engagementId: { in: engagementIds } } });
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });

  await prisma.$disconnect();
});

describe('what the editor is offered', () => {
  it('offers the template wording, and only the section the template marks editable', async () => {
    await resetPackage();
    const sections = await narratives.sectionsFor(packageId);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.key).toBe('cover_letter_intro');
    expect(sections[0]?.editLevel).toBe('ORDINARY');
    expect(sections[0]?.originalText).toMatch(/We are pleased to enclose your personal income tax return/);
    expect(sections[0]?.edit).toBeNull();

    // With no edit, what the letter will say is the template's own wording.
    expect(sections[0]?.effectiveText).toBe(sections[0]?.originalText);
  });

  it('shows the edit as what the letter will say once one exists', async () => {
    await resetPackage();
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'New opening.', actor: editor });

    const [section] = await narratives.sectionsFor(packageId);
    expect(section?.effectiveText).toBe('New opening.');
    expect(section?.edit?.authorName).toBe(editor.displayName);
    expect(section?.originalText).toMatch(/We are pleased to enclose/);
  });
});

describe('what it refuses', () => {
  it('refuses a section the template does not mark editable', async () => {
    await resetPackage();
    await expect(
      narratives.save({ coverLetterPackageId: packageId, sectionKey: 'documents_enclosed', text: 'Anything.', actor: editor }),
    ).rejects.toThrow(/not an editable section/i);
  });

  it('refuses a reader who cannot edit cover letters', async () => {
    await resetPackage();
    await expect(
      narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'Nope.', actor: reader }),
    ).rejects.toThrow();
  });

  it('refuses an empty narrative, which would silently delete the opening', async () => {
    await resetPackage();
    for (const text of ['', '   ', '\n\n']) {
      await expect(
        narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text, actor: editor }),
      ).rejects.toThrow(/cannot be empty/i);
    }
  });

  it('refuses a change that changes nothing', async () => {
    await resetPackage();
    const [section] = await narratives.sectionsFor(packageId);

    await expect(
      narratives.save({
        coverLetterPackageId: packageId,
        sectionKey: 'cover_letter_intro',
        text: section?.originalText ?? '',
        actor: editor,
      }),
    ).rejects.toThrow(/unchanged/i);
  });

  it('refuses to restore a section that was never edited', async () => {
    await resetPackage();
    await expect(
      narratives.restoreOriginal({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', actor: editor }),
    ).rejects.toThrow(/nothing to restore/i);
  });
});

describe('an edit is never overwritten', () => {
  it('supersedes the previous edit rather than replacing it', async () => {
    await resetPackage();

    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'First.', actor: editor });
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'Second.', actor: editor });

    const all = await prisma.coverLetterNarrative.findMany({
      where: { coverLetterPackageId: packageId },
      orderBy: { createdAt: 'asc' },
    });

    expect(all).toHaveLength(2);
    expect(all[0]?.editedText).toBe('First.');
    expect(all[0]?.supersededAt).not.toBeNull();
    expect(all[1]?.editedText).toBe('Second.');
    expect(all[1]?.supersededAt).toBeNull();
  });

  it('records the template wording on every edit, not the previous edit', async () => {
    await resetPackage();

    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'First.', actor: editor });
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'Second.', actor: editor });

    const all = await prisma.coverLetterNarrative.findMany({ where: { coverLetterPackageId: packageId } });

    // "Restore the original" must restore what the firm approved, not whatever
    // the last author happened to write.
    for (const edit of all) {
      expect(edit.originalText).toMatch(/We are pleased to enclose your personal income tax return/);
    }
  });

  it('keeps exactly one live edit per section, enforced by the database', async () => {
    await resetPackage();
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'Live.', actor: editor });

    await expect(
      prisma.coverLetterNarrative.create({
        data: {
          coverLetterPackageId: packageId,
          sectionKey: 'cover_letter_intro',
          originalText: 'x',
          editedText: 'A second live edit.',
          authorUserId: editor.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses to rewrite an edit in place, so history cannot be corrected', async () => {
    await resetPackage();
    const { id } = await narratives.save({
      coverLetterPackageId: packageId,
      sectionKey: 'cover_letter_intro',
      text: 'As written.',
      actor: editor,
    });

    await expect(
      prisma.coverLetterNarrative.update({ where: { id }, data: { editedText: 'Something else' } }),
    ).rejects.toThrow(/cannot be rewritten in place/i);
  });

  it('restores the template wording by retiring the edit, not by deleting it', async () => {
    await resetPackage();
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'Temporary.', actor: editor });
    await narratives.restoreOriginal({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', actor: editor });

    const [section] = await narratives.sectionsFor(packageId);
    expect(section?.edit).toBeNull();
    expect(section?.effectiveText).toBe(section?.originalText);

    // The retired edit is still on record.
    const all = await prisma.coverLetterNarrative.findMany({ where: { coverLetterPackageId: packageId } });
    expect(all).toHaveLength(1);
    expect(all[0]?.editedText).toBe('Temporary.');
    expect(all[0]?.supersededAt).not.toBeNull();
  });
});

describe('an approved letter', () => {
  it('goes back for review when its narrative changes, rather than diverging silently', async () => {
    await resetPackage();
    await prisma.coverLetterPackage.update({
      where: { id: packageId },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedByUserId: editor.id },
    });

    const outcome = await narratives.save({
      coverLetterPackageId: packageId,
      sectionKey: 'cover_letter_intro',
      text: 'Changed after approval.',
      actor: editor,
    });

    expect(outcome.markedStale).toBe(true);

    const record = await prisma.coverLetterPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(record.status).toBe('STALE');
    expect(record.approvedAt).toBeNull();
    expect(record.approvedByUserId).toBeNull();
    expect(record.staleReason).toMatch(/narrative was edited after approval/i);
  });

  it('is left alone when it was not approved in the first place', async () => {
    await resetPackage();

    const outcome = await narratives.save({
      coverLetterPackageId: packageId,
      sectionKey: 'cover_letter_intro',
      text: 'Edited before approval.',
      actor: editor,
    });

    expect(outcome.markedStale).toBe(false);
    const record = await prisma.coverLetterPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(record.status).toBe('REVIEW_REQUIRED');
  });

  it('goes back for review when the edit is restored too', async () => {
    await resetPackage();
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'Edited.', actor: editor });
    await prisma.coverLetterPackage.update({
      where: { id: packageId },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedByUserId: editor.id },
    });

    const outcome = await narratives.restoreOriginal({
      coverLetterPackageId: packageId,
      sectionKey: 'cover_letter_intro',
      actor: editor,
    });

    expect(outcome.markedStale).toBe(true);
    expect((await prisma.coverLetterPackage.findUniqueOrThrow({ where: { id: packageId } })).status).toBe('STALE');
  });
});

describe('the audit trail', () => {
  it('records what the wording was and what it became', async () => {
    await resetPackage();
    const { id } = await narratives.save({
      coverLetterPackageId: packageId,
      sectionKey: 'cover_letter_intro',
      text: 'Audited wording.',
      reason: 'The client asked for a plainer opening.',
      actor: editor,
    });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'CoverLetterNarrative', objectId: id },
    });

    expect(event.eventType).toBe('COVER_LETTER_EDITED');
    expect(event.userId).toBe(editor.id);
    expect(event.engagementId).toBe(engagementId);
    expect(event.reason).toMatch(/plainer opening/);
    expect(event.beforeValue).toMatchObject({ sectionKey: 'cover_letter_intro' });
    expect(event.afterValue).toMatchObject({ sectionKey: 'cover_letter_intro', text: 'Audited wording.' });
  });
});

describe('what generation is given', () => {
  it('hands the renderer only the live edits', async () => {
    await resetPackage();
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'First.', actor: editor });
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'Latest.', actor: editor });

    expect(await narratives.liveEdits(packageId)).toEqual({ cover_letter_intro: 'Latest.' });
  });

  it('hands it nothing once the edit is restored', async () => {
    await resetPackage();
    await narratives.save({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', text: 'Gone soon.', actor: editor });
    await narratives.restoreOriginal({ coverLetterPackageId: packageId, sectionKey: 'cover_letter_intro', actor: editor });

    expect(await narratives.liveEdits(packageId)).toEqual({});
  });
});
