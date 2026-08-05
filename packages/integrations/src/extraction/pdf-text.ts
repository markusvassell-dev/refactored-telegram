import type { DocumentText } from './types.js';

/**
 * PDF text extraction.
 *
 * Embedded text is preferred over any form of interpretation. When a PDF has
 * no embedded text the result is flagged `requiresOcr` — the pipeline then
 * blocks and asks a human rather than guessing at the contents of a tax return.
 */

interface PdfJsModule {
  getDocument(options: { data: Uint8Array; useSystemFonts?: boolean; isEvalSupported?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }>;
      }>;
      destroy(): Promise<void>;
    }>;
  };
}

let pdfjsPromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  // The legacy build is the one that works under Node without a DOM.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJsModule>;
  return pdfjsPromise;
}

const MIN_CHARS_PER_PAGE_FOR_TEXT_LAYER = 30;

export async function extractPdfText(pdf: Uint8Array | Buffer): Promise<DocumentText> {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: true,
    isEvalSupported: false,
  });

  const document = await loadingTask.promise;
  const pages: { pageNumber: number; text: string }[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      let text = '';
      for (const item of content.items) {
        if (typeof item.str === 'string') text += item.str;
        if (item.hasEOL) text += '\n';
        else text += ' ';
      }

      pages.push({ pageNumber, text: text.replace(/[ \t]+/g, ' ').trim() });
    }
  } finally {
    await document.destroy().catch(() => undefined);
  }

  const fullText = pages.map((page) => page.text).join('\n\n');
  const averageChars = pages.length > 0 ? fullText.length / pages.length : 0;

  return {
    pages,
    fullText,
    requiresOcr: pages.length > 0 && averageChars < MIN_CHARS_PER_PAGE_FOR_TEXT_LAYER,
  };
}

/** Plain-text extraction for DOCX prior-year letters. */
export function textFromParagraphs(paragraphs: readonly string[]): DocumentText {
  const fullText = paragraphs.join('\n');
  return {
    pages: [{ pageNumber: 1, text: fullText }],
    fullText,
    requiresOcr: false,
  };
}

/** Locates the 1-based page a snippet appears on, for evidence citation. */
export function pageOf(text: DocumentText, snippet: string): number | null {
  const needle = snippet.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!needle) return null;
  for (const page of text.pages) {
    if (page.text.replace(/\s+/g, ' ').toLowerCase().includes(needle)) return page.pageNumber;
  }
  return null;
}
