/**
 * Template normalisation CLI.
 *
 *   pnpm templates:normalize
 *
 * Reads the immutable approved templates from templates/source, rewrites their
 * visible bracketed placeholders into stable internal tokens, and writes:
 *
 *   templates/normalized/<name>.docx   — what the renderer actually uses
 *   templates/manifests/<type>.json    — the field / section / sanitation contract
 *
 * The source files are opened read-only and are never modified.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256Hex } from '@element/shared';
import {
  MAIN_DOCUMENT_PART,
  getPartText,
  normalizeDocumentXml,
  readDocx,
  setPartText,
  templateManifestSchema,
  writeDocx,
  TEMPLATE_SPECS,
  type TemplateManifest,
  type TemplateSpec,
} from '@element/documents';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_DIR = join(ROOT, 'templates', 'source');
const NORMALIZED_DIR = join(ROOT, 'templates', 'normalized');
const MANIFEST_DIR = join(ROOT, 'templates', 'manifests');

interface Outcome {
  spec: TemplateSpec;
  ok: boolean;
  replacements: number;
  errors: string[];
  warnings: string[];
  sourceHash: string;
  normalizedHash: string;
}

async function normalizeOne(spec: TemplateSpec): Promise<Outcome> {
  const sourcePath = join(SOURCE_DIR, spec.sourceFileName);

  let source: Buffer;
  try {
    source = await readFile(sourcePath);
  } catch {
    return {
      spec,
      ok: false,
      replacements: 0,
      errors: [`Source template is missing: templates/source/${spec.sourceFileName}`],
      warnings: [],
      sourceHash: '',
      normalizedHash: '',
    };
  }

  const sourceHash = sha256Hex(source);
  const parts = await readDocx(source);
  const originalXml = getPartText(parts, MAIN_DOCUMENT_PART);

  const result = normalizeDocumentXml(originalXml, spec.mappings);
  setPartText(parts, MAIN_DOCUMENT_PART, result.documentXml);

  const normalized = await writeDocx(parts);
  const normalizedHash = sha256Hex(normalized);

  await mkdir(NORMALIZED_DIR, { recursive: true });
  await writeFile(join(NORMALIZED_DIR, spec.sourceFileName), normalized);

  // A reviewer recognises a field by the bracketed text it replaced in the
  // approved letter, not by its internal token. The mapping already records
  // that relationship, so record it on the field rather than asking anyone to
  // keep a second list in step.
  const placeholdersByToken = new Map<string, string[]>();
  for (const mapping of spec.mappings) {
    const seen = placeholdersByToken.get(mapping.token) ?? [];
    if (!seen.includes(mapping.placeholder)) seen.push(mapping.placeholder);
    placeholdersByToken.set(mapping.token, seen);
  }

  const fields = spec.fields.map((definition) => {
    const placeholders = placeholdersByToken.get(definition.token);
    if (definition.sourcePlaceholder || !placeholders?.length) return definition;
    return { ...definition, sourcePlaceholder: placeholders.join(' / ') };
  });

  const manifest: TemplateManifest = templateManifestSchema.parse({
    manifestVersion: 1,
    documentType: spec.documentType,
    templateVersion: 1,
    sourceFileName: spec.sourceFileName,
    sourceFileHash: sourceHash,
    normalizedFileHash: normalizedHash,
    fields,
    conditionalSections: spec.conditionalSections,
    checkboxes: spec.checkboxes,
    signatureAnchors: spec.signatureAnchors,
    internalOnlySections: spec.internalOnlySections,
    editableSections: spec.editableSections,
    sanitation: spec.sanitation,
    lockedWordingByDefault: true,
    notes: spec.notes,
  });

  await mkdir(MANIFEST_DIR, { recursive: true });
  await writeFile(
    join(MANIFEST_DIR, `${spec.documentType}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const errors = result.issues.filter((issue) => issue.severity === 'ERROR').map((issue) => issue.message);
  const warnings = result.issues.filter((issue) => issue.severity === 'WARNING').map((issue) => issue.message);

  return {
    spec,
    ok: errors.length === 0,
    replacements: result.replacements,
    errors,
    warnings,
    sourceHash,
    normalizedHash,
  };
}

async function main(): Promise<void> {
  const outcomes: Outcome[] = [];

  for (const spec of TEMPLATE_SPECS) {
    outcomes.push(await normalizeOne(spec));
  }

  let failed = 0;

  for (const outcome of outcomes) {
    const status = outcome.ok ? 'ok' : 'FAILED';
    process.stdout.write(
      `\n[${status}] ${outcome.spec.documentType}\n` +
        `  source      templates/source/${outcome.spec.sourceFileName}\n` +
        `  sourceHash  ${outcome.sourceHash || '(missing)'}\n` +
        `  normalized  ${outcome.normalizedHash || '(not produced)'}\n` +
        `  tokens      ${outcome.replacements} placeholder occurrence(s) rewritten\n`,
    );

    for (const error of outcome.errors) process.stdout.write(`  ERROR   ${error}\n`);
    for (const warning of outcome.warnings) process.stdout.write(`  warning ${warning}\n`);

    if (!outcome.ok) failed += 1;
  }

  process.stdout.write(`\n${outcomes.length - failed}/${outcomes.length} template(s) normalised successfully.\n`);

  if (failed > 0) {
    process.stdout.write(
      'Normalisation failed. No legal wording has been altered — fix the mapping in\n' +
        'packages/documents/src/template-engine/source-mappings.ts and run again.\n',
    );
    process.exitCode = 1;
  }
}

await main();
