import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { buildTemplateVersion, specFor, type BuiltTemplateVersion } from '@element/documents';
import {
  NotFoundError,
  PreconditionError,
  ValidationError,
  assertCan,
  assertSeparationOfDuties,
  sha256Hex,
  type DocumentType,
  type Principal,
} from '@element/shared';
import type { DocumentStore } from './storage.js';

/**
 * Publishing a template version.
 *
 * The approved master template controls every word of standard legal wording
 * that reaches a client, so this is the highest-consequence change the
 * application allows. Three properties hold throughout:
 *
 *   - **A published version is never modified.** Revising wording creates a new
 *     version; the old one is retired, not overwritten, and documents already
 *     generated keep their own reference to the version they were rendered
 *     from. History stays truthful.
 *
 *   - **A version that would render badly cannot be activated.** Normalisation
 *     reports every placeholder it could not map, and a template with an
 *     unmapped placeholder renders literal bracketed text into a client's
 *     letter. Those are errors, not warnings.
 *
 *   - **The person who uploaded a version does not activate it.** This is the
 *     same rule the application applies to a wording exception, and a template
 *     version is a wording change to every future engagement at once.
 *
 * What this does not do is author a manifest. A manifest says which paragraphs
 * are legal wording, which are conditional, and where a signature goes; that is
 * a judgement about the document, not a transformation of it, and it stays a
 * reviewed code change. Publishing therefore accepts a revised .docx for a
 * document type the application already knows.
 */

export interface TemplatePublishDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
}

export interface UploadOutcome {
  templateVersionId: string;
  versionNumber: number;
  warnings: string[];
  replacements: number;
}

/** PK\x03\x04 — every .docx is a zip, and nothing else this accepts is. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const MAX_TEMPLATE_BYTES = 25 * 1024 * 1024;

export class TemplatePublishService {
  constructor(private readonly deps: TemplatePublishDeps) {}

  /**
   * Normalises an uploaded source template and records it as a draft version.
   *
   * Nothing is activated here. The draft exists so that a second administrator
   * can look at what the normaliser made of it before it governs a real letter.
   */
  async uploadDraft(input: {
    documentType: DocumentType;
    fileName: string;
    content: Buffer;
    notes?: string | null;
    actor: Principal;
  }): Promise<UploadOutcome> {
    assertCan(input.actor, 'template:manage');

    const spec = specFor(input.documentType);
    if (!spec) {
      throw new PreconditionError(
        `${input.documentType} has no placeholder mapping, so an uploaded file cannot be turned into a template. Adding a new document type is a code change.`,
      );
    }

    this.assertLooksLikeDocx(input.fileName, input.content);

    const template = await this.deps.prisma.documentTemplate.findUnique({
      where: { documentType: input.documentType },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!template) throw new NotFoundError('Document template');

    const sourceFileHash = sha256Hex(input.content);

    // Re-uploading the same bytes is not a new version. Without this, a double
    // submit leaves two identical drafts and no way to tell which was meant.
    const identical = await this.deps.prisma.templateVersion.findFirst({
      where: { templateId: template.id, sourceFileHash },
      select: { versionNumber: true, status: true },
    });
    if (identical) {
      throw new ValidationError(
        `This is byte-for-byte the file already stored as v${identical.versionNumber} (${identical.status.toLowerCase()}). Upload a revised document, or activate that version.`,
      );
    }

    let built: BuiltTemplateVersion;
    try {
      built = await buildTemplateVersion({
        spec,
        sourceDocx: input.content,
        versionNumber: (template.versions[0]?.versionNumber ?? 0) + 1,
        sourceFileName: input.fileName,
      });
    } catch (error) {
      throw new ValidationError(
        `The file could not be read as a Word document: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (built.errors.length > 0) {
      throw new ValidationError(
        `The template does not match the placeholders this document type expects, so it cannot be used:\n${built.errors.join('\n')}`,
      );
    }

    const versionNumber = (template.versions[0]?.versionNumber ?? 0) + 1;

    const stored = await this.deps.store.put({
      content: built.normalizedDocx,
      fileName: input.fileName,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      scope: `template-${template.id}`,
    });

    const version = await this.deps.prisma.templateVersion.create({
      data: {
        templateId: template.id,
        versionNumber,
        status: 'DRAFT',
        sourceFileHash: built.sourceFileHash,
        sourceFileName: input.fileName,
        normalizedFileHash: built.normalizedFileHash,
        normalizedPath: stored.reference,
        manifest: built.manifest as never,
        notes: input.notes?.trim() || null,
        createdBy: input.actor.id,
      },
    });

    await this.deps.audit.record({
      eventType: 'TEMPLATE_VERSION_UPLOADED',
      objectType: 'TemplateVersion',
      objectId: version.id,
      userId: input.actor.id,
      afterValue: {
        documentType: input.documentType,
        versionNumber,
        sourceFileName: input.fileName,
        sourceFileHash: built.sourceFileHash,
        normalizedFileHash: built.normalizedFileHash,
        replacements: built.replacements,
        warnings: built.warnings.length,
      },
      reason: input.notes?.trim() || null,
    });

    return {
      templateVersionId: version.id,
      versionNumber,
      warnings: built.warnings,
      replacements: built.replacements,
    };
  }

  /**
   * Makes a draft the version every future document is rendered from, and
   * retires the one it replaces.
   *
   * Documents already generated are untouched: each references the version it
   * was rendered from, and retiring does not delete anything.
   */
  async activate(input: { templateVersionId: string; actor: Principal }): Promise<{ retiredVersionNumber: number | null }> {
    assertCan(input.actor, 'template:publish');

    const version = await this.deps.prisma.templateVersion.findUnique({
      where: { id: input.templateVersionId },
      include: { template: true },
    });
    if (!version) throw new NotFoundError('Template version');

    if (version.status === 'ACTIVE') {
      throw new ValidationError(`v${version.versionNumber} is already the active version.`);
    }
    if (version.status === 'RETIRED') {
      throw new PreconditionError(
        `v${version.versionNumber} has been retired. Re-activating retired wording would make the history of which version produced which document ambiguous; upload the wording again as a new version.`,
      );
    }

    // A template version is a wording change to every future engagement at
    // once. The application does not let anybody approve their own wording
    // change, and this is the largest one there is.
    assertSeparationOfDuties({
      approverId: input.actor.id,
      authorId: version.createdBy,
      subject: 'template version',
    });

    const current = await this.deps.prisma.templateVersion.findFirst({
      where: { templateId: version.templateId, status: 'ACTIVE' },
    });

    await this.deps.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.templateVersion.update({
          where: { id: current.id },
          data: { status: 'RETIRED', retiredAt: new Date() },
        });
      }

      await tx.templateVersion.update({
        where: { id: version.id },
        data: {
          status: 'ACTIVE',
          activatedAt: new Date(),
          approvedBy: input.actor.id,
          approvedAt: new Date(),
        },
      });

      // A document type with an approved, active template is one the
      // application may generate. Nothing else sets this.
      await tx.documentTemplate.update({
        where: { id: version.templateId },
        data: { isProductionSupported: true },
      });
    });

    await this.deps.audit.record({
      eventType: 'TEMPLATE_ACTIVATED',
      objectType: 'TemplateVersion',
      objectId: version.id,
      userId: input.actor.id,
      beforeValue: current ? { activeVersion: current.versionNumber } : null,
      afterValue: {
        documentType: version.template.documentType,
        activeVersion: version.versionNumber,
        sourceFileHash: version.sourceFileHash,
        uploadedBy: version.createdBy,
      },
    });

    if (current) {
      await this.deps.audit.record({
        eventType: 'TEMPLATE_RETIRED',
        objectType: 'TemplateVersion',
        objectId: current.id,
        userId: input.actor.id,
        afterValue: { versionNumber: current.versionNumber, replacedBy: version.versionNumber },
        reason: `Replaced by v${version.versionNumber}.`,
      });
    }

    return { retiredVersionNumber: current?.versionNumber ?? null };
  }

  /** Discards a draft that will not be used. Only a draft. */
  async discardDraft(input: { templateVersionId: string; reason: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'template:manage');

    const version = await this.deps.prisma.templateVersion.findUnique({
      where: { id: input.templateVersionId },
      include: { template: true },
    });
    if (!version) throw new NotFoundError('Template version');

    if (version.status !== 'DRAFT') {
      throw new PreconditionError(
        `Only a draft can be discarded. v${version.versionNumber} is ${version.status.toLowerCase()}, and a version that has governed a document is kept so the history stays truthful.`,
      );
    }

    const reason = input.reason.trim();
    if (reason.length < 5) {
      throw new ValidationError('Give a reason for discarding the draft.');
    }

    await this.deps.prisma.templateVersion.delete({ where: { id: version.id } });

    await this.deps.audit.record({
      eventType: 'TEMPLATE_RETIRED',
      objectType: 'TemplateVersion',
      objectId: version.id,
      userId: input.actor.id,
      beforeValue: {
        documentType: version.template.documentType,
        versionNumber: version.versionNumber,
        status: 'DRAFT',
      },
      afterValue: { discarded: true },
      reason,
    });
  }

  private assertLooksLikeDocx(fileName: string, content: Buffer): void {
    if (content.length === 0) throw new ValidationError('The uploaded file is empty.');
    if (content.length > MAX_TEMPLATE_BYTES) {
      throw new ValidationError(`The template is larger than ${Math.floor(MAX_TEMPLATE_BYTES / 1024 / 1024)} MB.`);
    }

    // The extension is what the browser reported; the magic number is what the
    // file actually is. A .doc or a PDF renamed to .docx fails here rather than
    // several steps later with an unreadable error.
    if (!content.subarray(0, 4).equals(ZIP_MAGIC)) {
      throw new ValidationError(
        `${fileName} is not a Word .docx file. A .doc or a PDF renamed to .docx will not work; save it from Word as .docx.`,
      );
    }
  }
}
