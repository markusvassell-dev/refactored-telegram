import { describe, expect, it } from 'vitest';
import {
  blockText,
  escapeXml,
  findSourcePlaceholders,
  findTokens,
  flexiblePattern,
  normalizeDocumentXml,
  parseBody,
  replaceTextRanges,
  requiredFieldTokens,
  serializeBody,
  splitTopLevelBlocks,
  stripHighlights,
  templateManifestSchema,
  token,
} from '@element/documents';

function paragraph(...runs: string[]): string {
  return `<w:p>${runs.map((text) => `<w:r><w:t>${escapeXml(text)}</w:t></w:r>`).join('')}</w:p>`;
}

function document(...blocks: string[]): string {
  return `<?xml version="1.0"?><w:document><w:body>${blocks.join('')}<w:sectPr><w:pgSz/></w:sectPr></w:body></w:document>`;
}

describe('OOXML block parsing', () => {
  it('splits top-level blocks without descending into nested tables', () => {
    const table = '<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>';
    const blocks = splitTopLevelBlocks(`${paragraph('One')}${table}${paragraph('Two')}`);

    expect(blocks.map((block) => block.tag)).toEqual(['w:p', 'w:tbl', 'w:p']);
    expect(blocks[1]?.xml).toBe(table);
  });

  it('round-trips a body unchanged when nothing is edited', () => {
    const xml = document(paragraph('Hello'), paragraph('World'));
    expect(serializeBody(parseBody(xml))).toBe(xml);
  });

  it('never removes the section properties', () => {
    const parsed = parseBody(document(paragraph('Only')));
    expect(parsed.blocks.some((block) => block.tag === 'w:sectPr')).toBe(true);
  });
});

describe('run-spanning text replacement', () => {
  it('replaces a placeholder split across several runs', () => {
    // Word routinely splits a placeholder across runs after spell-checking.
    const split = paragraph('To: [LEGAL NAME ', 'OF CORPO', 'RATION]');
    expect(blockText(split)).toBe('To: [LEGAL NAME OF CORPORATION]');

    const updated = replaceTextRanges(split, [{ start: 4, end: 34, value: 'Northwind Sample Holdings Ltd.' }]);
    expect(blockText(updated)).toBe('To: Northwind Sample Holdings Ltd.');
  });

  it('keeps the formatting of the run where the match begins', () => {
    const xml =
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>A [TOK</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>EN] B</w:t></w:r></w:p>';
    const updated = replaceTextRanges(xml, [{ start: 2, end: 9, value: 'value' }]);

    expect(blockText(updated)).toBe('A value B');
    // The bold run keeps the substituted value; the italic run keeps its tail.
    expect(updated).toContain('<w:b/>');
    expect(updated).toContain('<w:i/>');
  });

  it('applies several replacements in one paragraph correctly', () => {
    const xml = paragraph('Dear [A] and [B]:');
    const updated = replaceTextRanges(xml, [
      { start: 5, end: 8, value: 'Alice' },
      { start: 13, end: 16, value: 'Bob' },
    ]);
    expect(blockText(updated)).toBe('Dear Alice and Bob:');
  });

  it('escapes XML metacharacters in substituted values', () => {
    const updated = replaceTextRanges(paragraph('[X]'), [{ start: 0, end: 3, value: 'Smith & Sons <Ltd>' }]);
    expect(updated).toContain('Smith &amp; Sons &lt;Ltd&gt;');
    expect(blockText(updated)).toBe('Smith & Sons <Ltd>');
  });
});

describe('placeholder matching', () => {
  it('treats curly and straight quotes, dashes and non-breaking spaces as equivalent', () => {
    const pattern = flexiblePattern('[IF NONE, STATE "NONE"]');
    expect(pattern.test('[IF NONE, STATE “NONE”]')).toBe(true);

    const dash = flexiblePattern('[DATE - CONFIRM]');
    expect(dash.test('[DATE – CONFIRM]')).toBe(true);
  });

  it('finds bracketed source placeholders and internal tokens', () => {
    expect(findSourcePlaceholders('To: [LEGAL NAME] on [DATE]')).toEqual(['[DATE]', '[LEGAL NAME]']);
    expect(findTokens('A [[a.b]] and [[c.d]]')).toEqual(['a.b', 'c.d']);
  });

  it('leaves Adobe Sign text tags alone', () => {
    // Adobe uses {{ }}; our tokens use [[ ]] precisely so they cannot collide.
    expect(findTokens('{{Sig_es_:signer1:signature}}')).toEqual([]);
    expect(token('corporation.legal_name')).toBe('[[corporation.legal_name]]');
  });
});

describe('normalisation', () => {
  it('rewrites only the mapped placeholder', () => {
    const xml = document(paragraph('To: [LEGAL NAME OF CORPORATION]'), paragraph('Untouched legal wording.'));

    const result = normalizeDocumentXml(xml, [
      { placeholder: '[LEGAL NAME OF CORPORATION]', token: 'corporation.legal_name' },
    ]);

    expect(result.replacements).toBe(1);
    expect(result.tokensWritten).toEqual(['corporation.legal_name']);
    expect(result.documentXml).toContain('[[corporation.legal_name]]');
    expect(result.documentXml).toContain('Untouched legal wording.');
  });

  it('scopes an ambiguous placeholder to one paragraph', () => {
    const xml = document(paragraph('Date: [DATE]'), paragraph('Signed on [DATE]'));

    const result = normalizeDocumentXml(xml, [
      { placeholder: '[DATE]', token: 'dates.sent', scope: { kind: 'PARAGRAPH', startsWith: 'Date:' } },
    ]);

    const parsed = parseBody(result.documentXml);
    expect(parsed.blocks[0]?.text).toBe('Date: [[dates.sent]]');
    // The second occurrence is deliberately untouched.
    expect(parsed.blocks[1]?.text).toBe('Signed on [DATE]');
  });

  it('scopes a placeholder to a specific table cell', () => {
    const cell = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
    const table = `<w:tbl><w:tr>${cell('T2 preparation fee')}${cell('$[AMOUNT]')}</w:tr><w:tr>${cell('Retainer')}${cell('$[AMOUNT]')}</w:tr></w:tbl>`;

    const result = normalizeDocumentXml(document(table), [
      {
        placeholder: '[AMOUNT]',
        token: 'pricing.t2_fee',
        scope: { kind: 'TABLE_CELL', tableContains: 'Retainer', rowIndex: 0, cellIndex: 1 },
      },
    ]);

    expect(result.documentXml).toContain('[[pricing.t2_fee]]');
    // The retainer row keeps its own placeholder.
    expect(result.documentXml).toContain('$[AMOUNT]');
    expect(result.replacements).toBe(1);
  });

  it('reports a mapping that no longer matches instead of silently doing nothing', () => {
    const result = normalizeDocumentXml(document(paragraph('Nothing here')), [
      { placeholder: '[MISSING]', token: 'a.b' },
    ]);

    expect(result.replacements).toBe(0);
    expect(result.issues.some((issue) => issue.severity === 'ERROR')).toBe(true);
  });

  it('reports unmapped placeholders as warnings', () => {
    const result = normalizeDocumentXml(document(paragraph('Left over [SOMETHING ELSE]')), []);
    expect(result.unmappedPlaceholders).toContain('[SOMETHING ELSE]');
  });
});

describe('highlight stripping', () => {
  it('removes every highlight run property', () => {
    const xml =
      '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/><w:b/></w:rPr><w:t>Placeholder</w:t></w:r></w:p>';
    const stripped = stripHighlights(xml);

    expect(stripped).not.toContain('w:highlight');
    // Other formatting survives.
    expect(stripped).toContain('<w:b/>');
    expect(blockText(stripped)).toBe('Placeholder');
  });

  it('removes yellow cell shading too', () => {
    expect(stripHighlights('<w:shd w:fill="FFFF00"/>')).toBe('');
  });
});

describe('manifest schema', () => {
  const minimal = {
    manifestVersion: 1,
    documentType: 'T2_ENGAGEMENT_LETTER',
    templateVersion: 1,
    sourceFileName: 'T2 Engagement Letter.docx',
    sourceFileHash: 'a'.repeat(64),
    fields: [
      { token: 'corporation.legal_name', label: 'Name', dataType: 'STRING', required: true },
      { token: 'pricing.compilation_fee', label: 'Fee', dataType: 'MONEY', requiredWhenSection: 'csrs_4200' },
    ],
    sanitation: {},
  };

  it('accepts a well-formed manifest and applies defaults', () => {
    const manifest = templateManifestSchema.parse(minimal);
    expect(manifest.sanitation.removeAllHighlights).toBe(true);
    expect(manifest.lockedWordingByDefault).toBe(true);
    expect(manifest.conditionalSections).toEqual([]);
  });

  it('rejects an invalid token shape', () => {
    expect(() =>
      templateManifestSchema.parse({
        ...minimal,
        fields: [{ token: 'Not A Token', label: 'x', dataType: 'STRING' }],
      }),
    ).toThrow();
  });

  it('includes conditional required fields only when the section is included', () => {
    const manifest = templateManifestSchema.parse(minimal);

    expect(requiredFieldTokens(manifest, [])).toEqual(['corporation.legal_name']);
    expect(requiredFieldTokens(manifest, ['csrs_4200'])).toEqual([
      'corporation.legal_name',
      'pricing.compilation_fee',
    ]);
  });
});
