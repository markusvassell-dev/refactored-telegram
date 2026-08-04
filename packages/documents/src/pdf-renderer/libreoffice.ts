import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '@element/shared';

const run = promisify(execFile);

/**
 * DOCX to PDF conversion via headless LibreOffice.
 *
 * LibreOffice is the only converter in this stack that reproduces Word layout
 * faithfully enough for a client-facing legal document — headers, footers,
 * tables, logo placement and page breaks all survive.
 *
 * The worker container installs it; see the Dockerfile.
 */

export interface PdfConversionOptions {
  /** Path to the soffice binary. */
  binary?: string;
  timeoutMs?: number;
  /** Directory for scratch files. Cleaned up unconditionally. */
  tempDirectory?: string;
}

export interface PdfConversionResult {
  pdf: Buffer;
  pageCount: number | null;
  durationMs: number;
}

/**
 * Counts pages by scanning the PDF for page objects. Good enough for the
 * structural regression checks and avoids pulling a parser into the worker.
 */
export function countPdfPages(pdf: Buffer): number | null {
  const text = pdf.toString('latin1');

  const countMatch = /\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/.exec(text);
  if (countMatch?.[1]) {
    const parsed = Number(countMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const pageObjects = text.match(/\/Type\s*\/Page[^s]/g);
  return pageObjects ? pageObjects.length : null;
}

export function isPdf(data: Uint8Array | Buffer): boolean {
  const header = Buffer.from(data.subarray(0, 5)).toString('latin1');
  return header === '%PDF-';
}

export async function convertDocxToPdf(
  docx: Uint8Array | Buffer,
  options: PdfConversionOptions = {},
): Promise<PdfConversionResult> {
  const binary = options.binary ?? process.env.LIBREOFFICE_BINARY ?? 'soffice';
  const timeout = options.timeoutMs ?? Number(process.env.PDF_CONVERSION_TIMEOUT_MS ?? 120_000);
  const base = options.tempDirectory ?? process.env.DOCUMENT_TEMP_DIRECTORY ?? tmpdir();

  const started = Date.now();
  const workDir = await mkdtemp(join(base, 'pdf-'));
  const inputPath = join(workDir, 'document.docx');
  const outputPath = join(workDir, 'document.pdf');

  try {
    await writeFile(inputPath, Buffer.from(docx));

    // A dedicated user profile per conversion keeps concurrent worker jobs
    // from fighting over LibreOffice's shared profile lock.
    await run(
      binary,
      [
        '--headless',
        '--norestore',
        '--invisible',
        '--nolockcheck',
        `-env:UserInstallation=file://${join(workDir, 'profile')}`,
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        workDir,
        inputPath,
      ],
      { timeout, maxBuffer: 32 * 1024 * 1024 },
    );

    const pdf = await readFile(outputPath);

    if (!isPdf(pdf)) {
      throw new AppError('LibreOffice produced a file that is not a PDF.', {
        category: 'INTEGRATION',
        userMessage: 'PDF conversion failed. An administrator can retry this document.',
        retryable: true,
      });
    }

    return { pdf, pageCount: countPdfPages(pdf), durationMs: Date.now() - started };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('DOCX to PDF conversion failed.', {
      category: 'INTEGRATION',
      userMessage: 'PDF conversion failed. An administrator can retry this document.',
      retryable: true,
      cause: error,
      context: { binary, timeout },
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Provider interface so tests and Test Mode can substitute a fake converter. */
export interface PdfConverter {
  readonly name: string;
  convert(docx: Uint8Array | Buffer): Promise<PdfConversionResult>;
}

export function libreOfficeConverter(options: PdfConversionOptions = {}): PdfConverter {
  return {
    name: 'libreoffice',
    convert: (docx) => convertDocxToPdf(docx, options),
  };
}
