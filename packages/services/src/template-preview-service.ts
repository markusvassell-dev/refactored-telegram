import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PrismaClient } from '@element/database';
import { isPdf, parseManifest, type PdfConverter } from '@element/documents';
import { NotFoundError, sha256Hex } from '@element/shared';
import type { DocumentStore } from './storage.js';
import { readTemplateSource } from './template-source.js';

/**
 * Reading the approved master template.
 *
 * A template version is the legal wording of every document generated from it,
 * and it could previously only be inspected by opening the .docx that happened
 * to be on the server. That made two things impossible from the application:
 * confirming what the active wording actually says, and reading a draft before
 * activating it — which the second administrator was being asked to do on the
 * strength of a file name and a hash.
 *
 * Nothing here modifies a template. The .docx is converted to a PDF for
 * reading; revising a template remains an upload, reviewed and activated by a
 * second person, because a published version is immutable.
 */

export interface TemplatePreviewServiceDeps {
  prisma: PrismaClient;
  store: DocumentStore;
  pdfConverter: PdfConverter;
  templateDirectory: string;
  /** Where rendered previews are cached. Disposable — regenerated on demand. */
  cacheDirectory: string;
}

export interface TemplatePreview {
  templateVersionId: string;
  versionNumber: number;
  documentType: string;
  fileName: string;
  content: Buffer;
}

export class TemplatePreviewService {
  constructor(private readonly deps: TemplatePreviewServiceDeps) {}

  /** The normalised source .docx, for someone who wants to revise it. */
  async docx(templateVersionId: string): Promise<TemplatePreview> {
    const version = await this.version(templateVersionId);
    const manifest = parseManifest(version.manifest);

    const content = await readTemplateSource(
      { normalizedPath: version.normalizedPath, sourceFileName: manifest.sourceFileName },
      { store: this.deps.store, templateDirectory: this.deps.templateDirectory },
    );

    return {
      templateVersionId: version.id,
      versionNumber: version.versionNumber,
      documentType: version.template.documentType,
      fileName: this.fileNameFor(version.template.documentType, version.versionNumber, 'docx'),
      content,
    };
  }

  /**
   * The same template as a PDF.
   *
   * Converted once and cached on disk. The cache key is the content hash, so a
   * new version never reads a previous version's preview, and a cache that has
   * been wiped simply costs one conversion. The directory is disposable by
   * design — it holds nothing that is not reproducible from the template.
   */
  async pdf(templateVersionId: string): Promise<TemplatePreview> {
    const source = await this.docx(templateVersionId);
    const key = sha256Hex(source.content);
    const cachePath = join(this.deps.cacheDirectory, `${key}.pdf`);

    const cached = await readFile(cachePath).catch(() => null);
    if (cached && isPdf(cached)) {
      return { ...source, fileName: source.fileName.replace(/\.docx$/i, '.pdf'), content: cached };
    }

    const converted = await this.deps.pdfConverter.convert(source.content);

    // Written best-effort: a read-only or full disk should slow the next
    // request down, not fail it.
    await mkdir(dirname(cachePath), { recursive: true })
      .then(() => writeFile(cachePath, converted.pdf, { mode: 0o600 }))
      .catch(() => undefined);

    return { ...source, fileName: source.fileName.replace(/\.docx$/i, '.pdf'), content: converted.pdf };
  }

  private fileNameFor(documentType: string, versionNumber: number, extension: string): string {
    return `${documentType.toLowerCase()}-v${versionNumber}.${extension}`;
  }

  private async version(templateVersionId: string) {
    const version = await this.deps.prisma.templateVersion.findUnique({
      where: { id: templateVersionId },
      include: { template: { select: { documentType: true } } },
    });

    if (!version) throw new NotFoundError('That template version does not exist.');
    return version;
  }
}
