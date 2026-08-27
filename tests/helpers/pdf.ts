/**
 * A real PDF, small enough to write by hand.
 *
 * Tests that exercise the scan cannot use a buffer of plain text with a `.pdf`
 * name: `extractPdfText` runs pdf.js over the bytes, so such a fixture is not a
 * weak document — it is an *unreadable* one, and it exercises the "no text
 * layer" branch instead of the branch under test. Every assertion about scores,
 * kinds and extracted values then passes or fails for the wrong reason.
 *
 * So this builds a genuine one-page PDF with an embedded text layer, using a
 * base-14 font so no font file has to be embedded. The offsets in the xref
 * table are computed from the bytes actually written rather than assumed, since
 * pdf.js reads that table to find the objects.
 */

/** Characters that mean something inside a PDF string literal. */
function escapeText(line: string): string {
  return line.replace(/([\\()])/g, '\\$1');
}

export function makePdf(text: string): Buffer {
  const lines = text.split('\n');

  // `T*` moves to the next line, which is what makes pdf.js report an end-of-line
  // and so what keeps the extracted text in lines. The patterns this feeds are
  // terminated by `\n`, so a page that came back as one long line would match
  // the whole remainder of the document.
  const content = ['BT', '/F1 11 Tf', '54 720 Td', '14 TL', ...lines.map((line) => `(${escapeText(line)}) Tj T*`), 'ET'].join(
    '\n',
  );

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
