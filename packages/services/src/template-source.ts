import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { AppError } from '@element/shared';
import type { DocumentStore } from './storage.js';

/**
 * Locating the file a template version was published from.
 *
 * `TemplateVersion.normalizedPath` holds two different things depending on how
 * the version arrived:
 *
 *   - **seeded** versions record an absolute filesystem path, produced by
 *     `join()` on whichever machine ran the seed;
 *   - **uploaded** versions record a `DocumentStore` reference, which is
 *     relative and means nothing to the filesystem.
 *
 * Reading the column as a path — which is what the generator did — therefore
 * worked for the templates that shipped and failed for every template a firm
 * uploaded itself. Revising a template is precisely the operation that produces
 * the second kind, so the failure was reserved for the moment somebody changed
 * their own legal wording and activated it.
 *
 * An absolute path is also not portable: the seed bakes in the path of the
 * machine that ran it, so a database restored onto a different host, or an
 * image whose working directory changed, points at a file that is not there.
 * The bytes are still in `templates/normalized`, under the name the manifest
 * records, so that is the last thing tried.
 */

export interface TemplateSourceDeps {
  store: DocumentStore;
  /** Where the normalised approved templates live in this deployment. */
  templateDirectory: string;
}

export interface TemplateSourceRef {
  /** `TemplateVersion.normalizedPath`. */
  normalizedPath: string | null;
  /** The manifest's `sourceFileName`, used for the portable fallback. */
  sourceFileName: string;
}

/**
 * The candidate locations, in the order they are tried. Exported so the
 * ordering can be asserted without touching a filesystem.
 */
export function templateSourceCandidates(
  ref: TemplateSourceRef,
  templateDirectory: string,
): ({ kind: 'file'; path: string } | { kind: 'store'; reference: string })[] {
  const candidates: ({ kind: 'file'; path: string } | { kind: 'store'; reference: string })[] = [];

  if (ref.normalizedPath) {
    if (isAbsolute(ref.normalizedPath)) {
      candidates.push({ kind: 'file', path: ref.normalizedPath });
    } else {
      // Relative means a store reference. Reading it as a path would resolve it
      // against the process working directory, which is how an uploaded
      // template became "missing on the server".
      candidates.push({ kind: 'store', reference: ref.normalizedPath });
    }
  }

  // Portable fallback: the approved templates ship in the image under the name
  // the manifest records, whatever path the seed happened to write.
  const fallbackName = ref.sourceFileName || (ref.normalizedPath ? basename(ref.normalizedPath) : '');
  if (fallbackName) candidates.push({ kind: 'file', path: join(templateDirectory, fallbackName) });

  return candidates;
}

/** The normalised .docx a template version was published from. */
export async function readTemplateSource(ref: TemplateSourceRef, deps: TemplateSourceDeps): Promise<Buffer> {
  const candidates = templateSourceCandidates(ref, deps.templateDirectory);
  const tried: string[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === 'file') {
      tried.push(candidate.path);
      const data = await readFile(candidate.path).catch(() => null);
      if (data) return data;
    } else {
      tried.push(`store:${candidate.reference}`);
      if (await deps.store.exists(candidate.reference)) {
        return await deps.store.get(candidate.reference);
      }
    }
  }

  throw new AppError('The normalised template file could not be read.', {
    category: 'INTERNAL',
    userMessage: 'The approved template file is missing on the server. An administrator has been notified.',
    // Paths, not contents. Nothing here is confidential and the operator needs
    // to know where it looked.
    context: { tried },
  });
}
