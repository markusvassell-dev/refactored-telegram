import JSZip from 'jszip';
import { sha256Hex } from '@element/shared';

/**
 * A .docx is a ZIP of XML parts. This wrapper lets us edit only the parts we
 * care about (document body, headers, footers) and rewrite the archive with
 * every other part — styles, numbering, theme, fonts, embedded logo — byte
 * identical to the source.
 */

export const MAIN_DOCUMENT_PART = 'word/document.xml';

export interface DocxParts {
  /** Every part in the archive, keyed by path. */
  files: Map<string, Uint8Array>;
  /** Paths of the XML parts that carry visible text. */
  textParts: string[];
}

const HEADER_FOOTER_PATTERN = /^word\/(header|footer)\d*\.xml$/;

export async function readDocx(data: Uint8Array | Buffer): Promise<DocxParts> {
  const zip = await JSZip.loadAsync(data);
  const files = new Map<string, Uint8Array>();

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  await Promise.all(
    entries.map(async (entry) => {
      files.set(entry.name, await entry.async('uint8array'));
    }),
  );

  const textParts = [...files.keys()]
    .filter((name) => name === MAIN_DOCUMENT_PART || HEADER_FOOTER_PATTERN.test(name))
    .sort((a, b) => (a === MAIN_DOCUMENT_PART ? -1 : b === MAIN_DOCUMENT_PART ? 1 : a.localeCompare(b)));

  if (!files.has(MAIN_DOCUMENT_PART)) {
    throw new Error('Not a Word document: word/document.xml is missing.');
  }

  return { files, textParts };
}

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

export function getPartText(parts: DocxParts, path: string): string {
  const data = parts.files.get(path);
  if (!data) throw new Error(`Document part not found: ${path}`);
  return decoder.decode(data);
}

export function setPartText(parts: DocxParts, path: string, xml: string): void {
  parts.files.set(path, encoder.encode(xml));
}

export function hasPart(parts: DocxParts, path: string): boolean {
  return parts.files.has(path);
}

/** Media parts (the firm logo). Used by structural regression checks. */
export function mediaParts(parts: DocxParts): string[] {
  return [...parts.files.keys()].filter((name) => name.startsWith('word/media/')).sort();
}

export async function writeDocx(parts: DocxParts): Promise<Buffer> {
  const zip = new JSZip();

  // [Content_Types].xml must be the first entry for maximum compatibility.
  const ordered = [...parts.files.keys()].sort((a, b) => {
    if (a === '[Content_Types].xml') return -1;
    if (b === '[Content_Types].xml') return 1;
    return a.localeCompare(b);
  });

  // A fixed timestamp keeps rendering deterministic, so the same inputs
  // produce the same file hash. Regression tests depend on this.
  const fixedDate = new Date('2020-01-01T00:00:00Z');

  for (const name of ordered) {
    const data = parts.files.get(name);
    if (data) zip.file(name, data, { date: fixedDate });
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export function hashBuffer(data: Uint8Array | Buffer): string {
  return sha256Hex(data);
}
