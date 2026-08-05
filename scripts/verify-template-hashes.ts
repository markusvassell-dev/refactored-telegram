/**
 * Verifies that the approved source templates have not been altered.
 *
 *   pnpm templates:verify
 *
 * Compares each file in templates/source against the hash recorded in its
 * manifest. A mismatch means the approved legal wording changed and a new
 * template version must be published deliberately.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256Hex } from '@element/shared';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_DIR = join(ROOT, 'templates', 'source');
const MANIFEST_DIR = join(ROOT, 'templates', 'manifests');
const NORMALIZED_DIR = join(ROOT, 'templates', 'normalized');

interface Manifest {
  documentType: string;
  sourceFileName: string;
  sourceFileHash: string;
  normalizedFileHash?: string;
}

async function hashOf(path: string): Promise<string | null> {
  return readFile(path)
    .then((data) => sha256Hex(data))
    .catch(() => null);
}

async function main(): Promise<void> {
  let manifestFiles: string[];
  try {
    manifestFiles = (await readdir(MANIFEST_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    process.stdout.write('No manifests found. Run `pnpm templates:normalize` first.\n');
    process.exitCode = 1;
    return;
  }

  let failures = 0;

  for (const fileName of manifestFiles) {
    const manifest = JSON.parse(await readFile(join(MANIFEST_DIR, fileName), 'utf8')) as Manifest;

    const sourceHash = await hashOf(join(SOURCE_DIR, manifest.sourceFileName));
    const normalizedHash = await hashOf(join(NORMALIZED_DIR, manifest.sourceFileName));

    const sourceOk = sourceHash === manifest.sourceFileHash;
    const normalizedOk = !manifest.normalizedFileHash || normalizedHash === manifest.normalizedFileHash;

    process.stdout.write(
      `${sourceOk && normalizedOk ? '[ok]    ' : '[FAILED]'} ${manifest.documentType}\n` +
        `           source     ${sourceHash ?? '(missing)'}\n` +
        `           normalized ${normalizedHash ?? '(missing)'}\n`,
    );

    if (!sourceOk) {
      failures += 1;
      process.stdout.write(
        `           ERROR the approved source template has changed.\n` +
          `                 expected ${manifest.sourceFileHash}\n` +
          `                 Publish a new template version deliberately rather than editing this one.\n`,
      );
    }

    if (!normalizedOk) {
      failures += 1;
      process.stdout.write(
        `           ERROR the normalised template does not match its manifest.\n` +
          `                 Run \`pnpm templates:normalize\` to regenerate it.\n`,
      );
    }
  }

  process.stdout.write(`\n${manifestFiles.length - failures}/${manifestFiles.length} template(s) verified.\n`);
  if (failures > 0) process.exitCode = 1;
}

await main();
