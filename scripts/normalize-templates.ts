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
import { buildTemplateVersion, TEMPLATE_SPECS, type TemplateSpec } from '@element/documents';

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

  const built = await buildTemplateVersion({ spec, sourceDocx: source });

  await mkdir(NORMALIZED_DIR, { recursive: true });
  await writeFile(join(NORMALIZED_DIR, spec.sourceFileName), built.normalizedDocx);

  await mkdir(MANIFEST_DIR, { recursive: true });
  await writeFile(
    join(MANIFEST_DIR, `${spec.documentType}.json`),
    `${JSON.stringify(built.manifest, null, 2)}\n`,
    'utf8',
  );

  return {
    spec,
    ok: built.errors.length === 0,
    replacements: built.replacements,
    errors: built.errors,
    warnings: built.warnings,
    sourceHash: built.sourceFileHash,
    normalizedHash: built.normalizedFileHash,
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
