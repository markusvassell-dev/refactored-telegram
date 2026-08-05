import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { parseManifest, readEditableSections, type EditableSectionText } from '@element/documents';
import {
  NotFoundError,
  PreconditionError,
  ValidationError,
  assertCan,
  type Principal,
} from '@element/shared';

/**
 * The cover letter narrative.
 *
 * A completion cover letter is mostly derived — dates, amounts, an enclosure
 * list built from the documents actually present. The opening paragraphs are
 * not: they are the part a person is meant to write, and until now the only way
 * to change a sentence was to change the underlying data and generate again.
 *
 * What this can reach is decided by the approved template, not by this service.
 * A section is editable only if the template manifest lists it in
 * `editableSections`; every other word of the letter has no key here and so
 * cannot be addressed at all. Wording the firm has approved as legal text stays
 * behind the wording-exception flow, which requires a partner and a reason.
 *
 * Nothing here changes a document that already exists. An edit changes what the
 * next generation will produce, and an approved letter is sent back for review
 * rather than quietly diverging from what its approver read.
 */

export interface CoverLetterNarrativeDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  templateDirectory: string;
}

export interface NarrativeSection {
  key: string;
  label: string;
  editLevel: EditableSectionText['editLevel'];
  /** The approved template's own wording. */
  originalText: string;
  /** What the letter will say — the edit if there is one, otherwise the original. */
  effectiveText: string;
  edit: {
    id: string;
    editedText: string;
    reason: string | null;
    authorName: string;
    createdAt: Date;
    /** True when the edit was made against a template version no longer active. */
    fromSupersededTemplate: boolean;
  } | null;
}

/** Statuses in which the letter has been approved and must not silently change. */
const APPROVED_STATUSES = new Set(['APPROVED', 'READY_FOR_DELIVERY']);

const MAX_NARRATIVE_LENGTH = 20_000;

export class CoverLetterNarrativeService {
  constructor(private readonly deps: CoverLetterNarrativeDeps) {}

  /**
   * Every editable section of a package's letter, with the template's wording,
   * the current edit and what the letter will actually say.
   */
  async sectionsFor(coverLetterPackageId: string): Promise<NarrativeSection[]> {
    const { manifest, docx, templateVersionId } = await this.templateFor(coverLetterPackageId);
    const { sections, missing } = await readEditableSections(docx, manifest);

    if (missing.length > 0) {
      throw new PreconditionError(
        `The template no longer contains the editable section(s) ${missing.join(', ')} where its manifest expects them. The template and manifest are out of step.`,
      );
    }

    const edits = await this.deps.prisma.coverLetterNarrative.findMany({
      where: { coverLetterPackageId, supersededAt: null },
      include: { author: { select: { displayName: true } } },
    });

    return sections.map((section) => {
      const edit = edits.find((candidate) => candidate.sectionKey === section.key);

      return {
        key: section.key,
        label: section.label,
        editLevel: section.editLevel,
        originalText: section.text,
        effectiveText: edit?.editedText ?? section.text,
        edit: edit
          ? {
              id: edit.id,
              editedText: edit.editedText,
              reason: edit.reason,
              authorName: edit.author.displayName,
              createdAt: edit.createdAt,
              // The wording an edit replaced is recorded on the edit. If the
              // active template has since moved on, the reviewer is told rather
              // than shown a comparison against wording nobody approved.
              fromSupersededTemplate:
                edit.templateVersionId !== null && edit.templateVersionId !== templateVersionId,
            }
          : null,
      };
    });
  }

  /** The live edits, keyed by section, for the renderer. */
  async liveEdits(coverLetterPackageId: string): Promise<Record<string, string>> {
    const edits = await this.deps.prisma.coverLetterNarrative.findMany({
      where: { coverLetterPackageId, supersededAt: null },
      select: { sectionKey: true, editedText: true },
    });

    return Object.fromEntries(edits.map((edit) => [edit.sectionKey, edit.editedText]));
  }

  /**
   * Records an edit.
   *
   * The previous edit is superseded rather than replaced, so what the letter
   * said at each point stays answerable.
   */
  async save(input: {
    coverLetterPackageId: string;
    sectionKey: string;
    text: string;
    reason?: string | null;
    actor: Principal;
  }): Promise<{ id: string; markedStale: boolean }> {
    assertCan(input.actor, 'cover_letter:edit');

    const packageRecord = await this.deps.prisma.coverLetterPackage.findUnique({
      where: { id: input.coverLetterPackageId },
    });
    if (!packageRecord) throw new NotFoundError('Cover letter');

    const { manifest, docx, templateVersionId } = await this.templateFor(input.coverLetterPackageId);
    const { sections } = await readEditableSections(docx, manifest);

    const section = sections.find((candidate) => candidate.key === input.sectionKey);
    if (!section) {
      throw new ValidationError(
        `"${input.sectionKey}" is not an editable section of this letter. Only the sections the approved template marks editable can be rewritten; everything else needs a wording exception.`,
      );
    }

    // An EXCEPTIONAL section is approved legal wording that happens to be
    // reachable. Changing it needs a partner's approval, which is what the
    // wording-exception flow is for.
    if (section.editLevel !== 'ORDINARY') {
      throw new PreconditionError(
        `"${section.label}" is approved wording, not narrative. Changing it requires a wording exception, which a partner must approve.`,
      );
    }

    const text = input.text.replace(/\r\n/g, '\n').trim();
    if (text.length === 0) {
      throw new ValidationError(
        'The narrative cannot be empty. To go back to the template wording, restore it rather than clearing the box.',
      );
    }
    if (text.length > MAX_NARRATIVE_LENGTH) {
      throw new ValidationError(`The narrative is longer than ${MAX_NARRATIVE_LENGTH} characters.`);
    }

    const existing = await this.deps.prisma.coverLetterNarrative.findFirst({
      where: { coverLetterPackageId: input.coverLetterPackageId, sectionKey: input.sectionKey, supersededAt: null },
    });

    const before = existing?.editedText ?? section.text;
    if (before.trim() === text) {
      throw new ValidationError('The narrative is unchanged.');
    }

    const created = await this.deps.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.coverLetterNarrative.update({
          where: { id: existing.id },
          data: { supersededAt: new Date() },
        });
      }

      return tx.coverLetterNarrative.create({
        data: {
          coverLetterPackageId: input.coverLetterPackageId,
          sectionKey: input.sectionKey,
          // The template's wording, always — not the previous edit. This is what
          // "restore the original" restores, and it must be what the firm
          // approved rather than whatever the last author happened to write.
          originalText: section.text,
          editedText: text,
          templateVersionId,
          reason: input.reason?.trim() || null,
          authorUserId: input.actor.id,
        },
      });
    });

    const markedStale = await this.unapproveIfApproved(packageRecord, input.actor.id);

    await this.deps.audit.record({
      eventType: 'COVER_LETTER_EDITED',
      objectType: 'CoverLetterNarrative',
      objectId: created.id,
      engagementId: packageRecord.engagementId,
      userId: input.actor.id,
      beforeValue: { sectionKey: input.sectionKey, text: before },
      afterValue: { sectionKey: input.sectionKey, text, markedStale },
      reason: input.reason?.trim() || null,
    });

    return { id: created.id, markedStale };
  }

  /** Retires the live edit, so the letter goes back to the template's wording. */
  async restoreOriginal(input: {
    coverLetterPackageId: string;
    sectionKey: string;
    actor: Principal;
  }): Promise<{ markedStale: boolean }> {
    assertCan(input.actor, 'cover_letter:edit');

    const packageRecord = await this.deps.prisma.coverLetterPackage.findUnique({
      where: { id: input.coverLetterPackageId },
    });
    if (!packageRecord) throw new NotFoundError('Cover letter');

    const existing = await this.deps.prisma.coverLetterNarrative.findFirst({
      where: { coverLetterPackageId: input.coverLetterPackageId, sectionKey: input.sectionKey, supersededAt: null },
    });
    if (!existing) {
      throw new ValidationError('This section has not been edited, so there is nothing to restore.');
    }

    await this.deps.prisma.coverLetterNarrative.update({
      where: { id: existing.id },
      data: { supersededAt: new Date() },
    });

    const markedStale = await this.unapproveIfApproved(packageRecord, input.actor.id);

    await this.deps.audit.record({
      eventType: 'COVER_LETTER_EDITED',
      objectType: 'CoverLetterNarrative',
      objectId: existing.id,
      engagementId: packageRecord.engagementId,
      userId: input.actor.id,
      beforeValue: { sectionKey: input.sectionKey, text: existing.editedText },
      afterValue: { sectionKey: input.sectionKey, restoredToTemplate: true, markedStale },
      reason: 'Restored the approved template wording.',
    });

    return { markedStale };
  }

  /**
   * An approved letter whose narrative changed is no longer the letter that was
   * approved, so it goes back for review — the same treatment a changed source
   * document already gets. Nothing that was generated is touched: the existing
   * document version stays exactly as it is, and is simply no longer current.
   */
  private async unapproveIfApproved(
    packageRecord: { id: string; status: string },
    userId: string,
  ): Promise<boolean> {
    if (!APPROVED_STATUSES.has(packageRecord.status)) return false;

    await this.deps.prisma.coverLetterPackage.update({
      where: { id: packageRecord.id },
      data: {
        status: 'STALE',
        staleReason: 'The narrative was edited after approval; the letter needs to be reviewed again.',
        markedStaleAt: new Date(),
        approvedAt: null,
        approvedByUserId: null,
        readyForDeliveryAt: null,
      },
    });

    await this.deps.audit.record({
      eventType: 'COVER_LETTER_MARKED_STALE',
      objectType: 'CoverLetterPackage',
      objectId: packageRecord.id,
      userId,
      afterValue: { reason: 'narrative edited after approval' },
    });

    return true;
  }

  private async templateFor(coverLetterPackageId: string): Promise<{
    manifest: ReturnType<typeof parseManifest>;
    docx: Buffer;
    templateVersionId: string;
  }> {
    const packageRecord = await this.deps.prisma.coverLetterPackage.findUnique({
      where: { id: coverLetterPackageId },
      select: { documentType: true },
    });
    if (!packageRecord) throw new NotFoundError('Cover letter');

    const template = await this.deps.prisma.documentTemplate.findUnique({
      where: { documentType: packageRecord.documentType },
      include: { versions: { where: { status: 'ACTIVE' }, orderBy: { versionNumber: 'desc' }, take: 1 } },
    });

    const version = template?.versions[0];
    if (!version) {
      throw new PreconditionError('No approved template is active for this cover letter.');
    }

    const manifest = parseManifest(version.manifest);
    const docx = await readFile(version.normalizedPath ?? join(this.deps.templateDirectory, manifest.sourceFileName));

    return { manifest, docx, templateVersionId: version.id };
  }
}
