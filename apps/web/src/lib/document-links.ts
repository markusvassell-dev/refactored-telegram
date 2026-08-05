import { container } from './container';
import { encodeReference } from './document-reference';

/**
 * Short-lived signed links to a stored working copy.
 *
 * A reviewer must be able to read the document they are approving, but a
 * document reference must not be shareable or guessable. Every link is signed,
 * expires quickly, and is verified independently of the session by the
 * download route — so both a valid session *and* a valid signature are
 * required.
 */

/** Long enough to read a letter, short enough that a copied URL is useless. */
const LINK_TTL_SECONDS = 900;

export interface DocumentLink {
  url: string;
  fileName: string;
  kind: 'DOCX' | 'PDF';
}

export interface DocumentVersionLinks {
  documentVersionId: string;
  versionNumber: number;
  docx: DocumentLink | null;
  pdf: DocumentLink | null;
}

function buildUrl(reference: string): string {
  const link = container.store.createSignedLink(reference, LINK_TTL_SECONDS);
  const encoded = encodeReference(reference);
  const parameters = new URLSearchParams({
    expires: String(link.expires),
    signature: link.signature,
  });
  return `/api/documents/${encoded}?${parameters.toString()}`;
}

/** Strips the storage prefix so the reviewer sees the real document name. */
function displayName(reference: string): string {
  const base = reference.split('/').pop() ?? reference;
  // Stored as "<uuid>-<sanitised name>"; drop the uuid.
  return base.replace(/^[0-9a-f-]{36}-/i, '').replace(/_/g, ' ');
}

export function linksFor(version: {
  id: string;
  versionNumber: number;
  generatedDocxReference: string | null;
  generatedPdfReference: string | null;
}): DocumentVersionLinks {
  return {
    documentVersionId: version.id,
    versionNumber: version.versionNumber,
    docx: version.generatedDocxReference
      ? { url: buildUrl(version.generatedDocxReference), fileName: displayName(version.generatedDocxReference), kind: 'DOCX' }
      : null,
    pdf: version.generatedPdfReference
      ? { url: buildUrl(version.generatedPdfReference), fileName: displayName(version.generatedPdfReference), kind: 'PDF' }
      : null,
  };
}

export function linksForAll(
  versions: readonly {
    id: string;
    versionNumber: number;
    generatedDocxReference: string | null;
    generatedPdfReference: string | null;
  }[],
): Record<string, DocumentVersionLinks> {
  const map: Record<string, DocumentVersionLinks> = {};
  for (const version of versions) map[version.id] = linksFor(version);
  return map;
}
