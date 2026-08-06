import { sha256Hex } from '@element/shared';
import { getPartText, MAIN_DOCUMENT_PART, readDocx, setPartText, writeDocx } from '../ooxml/package.js';
import { normalizeDocumentXml, type NormalizationIssue } from './normalize.js';
import { templateManifestSchema, type TemplateManifest } from './manifest.js';
import type { TemplateSpec } from './source-mappings.js';

/**
 * Turning an approved source .docx into a template version.
 *
 * This is the one place that decides what a template version *is*: the
 * normalised document the renderer uses, the manifest that describes it, and
 * the hashes that tie both back to the file the firm approved.
 *
 * It lives here rather than in the normalisation CLI because the CLI is no
 * longer the only caller — an administrator can publish a revised template from
 * the application. Two implementations would eventually disagree, and the
 * symptom would be an uploaded template rendering differently from a committed
 * one, which is not a difference anybody would notice until a client did.
 */

export interface BuiltTemplateVersion {
  /** The document the renderer actually uses. */
  normalizedDocx: Buffer;
  manifest: TemplateManifest;
  sourceFileHash: string;
  normalizedFileHash: string;
  /** Placeholders successfully rewritten into tokens. */
  replacements: number;
  errors: string[];
  warnings: string[];
  /** Bracketed placeholders left in the document with no mapping. */
  unmappedPlaceholders: string[];
}

export async function buildTemplateVersion(input: {
  spec: TemplateSpec;
  sourceDocx: Uint8Array | Buffer;
  /** Recorded in the manifest; the database holds the authoritative number. */
  versionNumber?: number;
  /** The name of the file as supplied, when it differs from the spec's. */
  sourceFileName?: string;
}): Promise<BuiltTemplateVersion> {
  const source = Buffer.from(input.sourceDocx);
  const sourceFileHash = sha256Hex(source);

  const parts = await readDocx(source);
  const result = normalizeDocumentXml(getPartText(parts, MAIN_DOCUMENT_PART), input.spec.mappings);
  setPartText(parts, MAIN_DOCUMENT_PART, result.documentXml);

  const normalizedDocx = await writeDocx(parts);
  const normalizedFileHash = sha256Hex(normalizedDocx);

  // A reviewer recognises a field by the bracketed text it replaced in the
  // approved letter, not by its internal token. The mapping already records
  // that relationship, so record it on the field rather than asking anyone to
  // keep a second list in step.
  const placeholdersByToken = new Map<string, string[]>();
  for (const mapping of input.spec.mappings) {
    const seen = placeholdersByToken.get(mapping.token) ?? [];
    if (!seen.includes(mapping.placeholder)) seen.push(mapping.placeholder);
    placeholdersByToken.set(mapping.token, seen);
  }

  const fields = input.spec.fields.map((definition) => {
    const placeholders = placeholdersByToken.get(definition.token);
    if (definition.sourcePlaceholder || !placeholders?.length) return definition;
    return { ...definition, sourcePlaceholder: placeholders.join(' / ') };
  });

  const manifest = templateManifestSchema.parse({
    manifestVersion: 1,
    documentType: input.spec.documentType,
    templateVersion: input.versionNumber ?? 1,
    sourceFileName: input.sourceFileName ?? input.spec.sourceFileName,
    sourceFileHash,
    normalizedFileHash,
    fields,
    conditionalSections: input.spec.conditionalSections,
    checkboxes: input.spec.checkboxes,
    signatureAnchors: input.spec.signatureAnchors,
    internalOnlySections: input.spec.internalOnlySections,
    editableSections: input.spec.editableSections,
    sanitation: input.spec.sanitation,
    lockedWordingByDefault: true,
    notes: input.spec.notes,
  });

  return {
    normalizedDocx,
    manifest,
    sourceFileHash,
    normalizedFileHash,
    replacements: result.replacements,
    errors: severity(result.issues, 'ERROR'),
    warnings: severity(result.issues, 'WARNING'),
    unmappedPlaceholders: result.unmappedPlaceholders,
  };
}

function severity(issues: readonly NormalizationIssue[], level: NormalizationIssue['severity']): string[] {
  return issues.filter((issue) => issue.severity === level).map((issue) => issue.message);
}
