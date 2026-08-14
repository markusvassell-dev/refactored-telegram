import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  convertDocxToPdf,
  countPdfPages,
  extractParagraphs,
  findPriorYearCustomWording,
  diffParagraphs,
  isPdf,
  listDocxEntries,
  mediaParts,
  parseManifest,
  readDocx,
  renderDocx,
  requiredFieldTokens,
  validateRenderedDocument,
  type TemplateManifest,
} from '@element/documents';

/**
 * Document rendering, conversion and validation, against the real approved
 * templates and a real headless LibreOffice.
 *
 * These are the structural regression tests: they assert that the logo,
 * headings, tables and signature sections survive rendering, that the page
 * count stays plausible, and that nothing internal reaches a client.
 */

const ROOT = process.cwd();
const NORMALIZED = join(ROOT, 'templates', 'normalized');
const MANIFESTS = join(ROOT, 'templates', 'manifests');

async function loadTemplate(documentType: string): Promise<{ manifest: TemplateManifest; docx: Buffer }> {
  const manifest = parseManifest(JSON.parse(await readFile(join(MANIFESTS, `${documentType}.json`), 'utf8')));
  const docx = await readFile(join(NORMALIZED, manifest.sourceFileName));
  return { manifest, docx };
}

const T2_VALUES: Record<string, string> = {
  'corporation.legal_name': 'Northwind Sample Holdings Ltd.',
  'corporation.business_number': '00000 0000 RC0001',
  'corporation.year_end': 'March 31, 2026',
  'signer.officer_name': 'Sample Signing Officer',
  'signer.officer_title': 'President',
  'signer.officer_email': 'officer@example.test',
  'firm.signer_name': 'Sample Partner, CPA, CA',
  'firm.engagement_lead': 'Sample Lead, lead@example.test',
  'dates.sent': 'August 4, 2026',
  'dates.client_information_due': 'June 30, 2026',
  'dates.target_completion': 'August 31, 2026',
  'dates.filing_due': 'September 30, 2026',
  'dates.balance_due': 'June 30, 2026',
  'pricing.t2_fee': '2,065.00',
  'pricing.compilation_fee': '1,035.00',
  'pricing.billing_basis': 'Fixed fee',
  'pricing.retainer': 'Not applicable',
  'pricing.payment_terms': 'upon receipt',
  'pricing.payment_terms_short': 'Upon receipt',
  'pricing.additional_work': 'Quoted separately',
  'compilation.intended_use': 'Corporate tax filing',
  'compilation.intended_users': 'Management',
  'compilation.basis_of_accounting': 'Cash basis with selected accruals',
  'compilation.financial_information_other': 'None',
  'compilation.report_delivery': 'Electronic',
  'compilation.report_date': 'September 15, 2026',
  'services.other_included': 'None',
  'services.other_optional': 'None',
  'special_terms.line_1': 'None',
  'special_terms.line_2': 'None',
};

const T2_SELECTIONS = {
  't2.federal_return': true,
  't2.provincial_schedules': true,
  't2.gifi': true,
  't2.efile': true,
};

describe('T2 engagement letter rendering', () => {
  let template: { manifest: TemplateManifest; docx: Buffer };

  beforeAll(async () => {
    template = await loadTemplate('T2_ENGAGEMENT_LETTER');
  });

  it('keeps section 3A and the compilation particulars when CSRS 4200 is selected', async () => {
    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: T2_VALUES,
      selections: { ...T2_SELECTIONS, 't2.csrs4200': true },
      includedSections: ['csrs_4200'],
      mode: 'DRAFT',
    });

    const text = (await extractParagraphs(rendered.docx)).join('\n');

    expect(text).toContain('3A. Optional compilation engagement under CSRS 4200');
    expect(text).toContain('COMPILATION ENGAGEMENT REPORT');
    expect(text).toContain('Compilation engagement particulars');
    expect(text).toContain('☒ Compilation engagement under CSRS 4200');
    expect(rendered.unresolvedTokens).toEqual([]);
  });

  it('removes section 3A entirely when CSRS 4200 is not selected', async () => {
    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: { ...T2_VALUES, 'pricing.compilation_fee': 'Not applicable' },
      selections: { ...T2_SELECTIONS, 't2.csrs4200': false },
      includedSections: [],
      mode: 'DRAFT',
    });

    const text = (await extractParagraphs(rendered.docx)).join('\n');

    // No compilation wording may survive into a client-facing document.
    expect(text).not.toContain('3A. Optional compilation engagement');
    expect(text).not.toContain('COMPILATION ENGAGEMENT REPORT');
    expect(text).not.toContain('Compilation engagement particulars');
    expect(text).toContain('☐ Compilation engagement under CSRS 4200');
    // The fee is marked not applicable rather than zero.
    expect(text).toContain('Not applicable');
    expect(rendered.removedSections).toContain('csrs_4200');

    // Section 4 and the rest of the letter are untouched.
    expect(text).toContain('4. Corporation’s responsibilities');
    expect(text).toContain('18. Acknowledgement and acceptance');
  });

  it('always removes the internal customization checklist', async () => {
    for (const compilation of [true, false]) {
      const rendered = await renderDocx(template.docx, {
        manifest: template.manifest,
        values: T2_VALUES,
        selections: { ...T2_SELECTIONS, 't2.csrs4200': compilation },
        includedSections: compilation ? ['csrs_4200'] : [],
        mode: 'DRAFT',
      });

      const text = (await extractParagraphs(rendered.docx)).join('\n');

      expect(text).not.toContain('Internal customization checklist');
      expect(text).not.toContain('Delete this internal checklist before issuing the letter');
      expect(text).not.toContain('Replace every yellow-highlighted placeholder');
      expect(rendered.removedSections).toContain('t2_internal_checklist');
    }
  });

  it('removes every placeholder highlight', async () => {
    const source = await readDocx(template.docx);
    const sourceXml = new TextDecoder().decode(source.files.get('word/document.xml') as Uint8Array);
    // The approved T2 template really does ship with yellow highlighting.
    expect(sourceXml).toContain('w:highlight');

    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: T2_VALUES,
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'DRAFT',
    });

    const output = await readDocx(rendered.docx);
    for (const path of output.textParts) {
      const xml = new TextDecoder().decode(output.files.get(path) as Uint8Array);
      expect(xml, path).not.toContain('w:highlight');
    }
  });

  it('preserves the logo, headings and tables', async () => {
    // Rendered with compilation included so nothing is conditionally removed:
    // anything missing from the output would be rendering damage.
    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: T2_VALUES,
      selections: { ...T2_SELECTIONS, 't2.csrs4200': true },
      includedSections: ['csrs_4200'],
      mode: 'DRAFT',
    });

    const source = await readDocx(template.docx);
    const output = await readDocx(rendered.docx);

    // Branding survives byte-for-byte.
    expect(mediaParts(output)).toEqual(mediaParts(source));
    expect(output.files.get('word/media/image1.png')).toEqual(source.files.get('word/media/image1.png'));

    // Styles, numbering, headers and footers are untouched.
    for (const part of ['word/styles.xml', 'word/numbering.xml', 'word/footer1.xml']) {
      if (source.files.has(part)) expect(output.files.get(part), part).toEqual(source.files.get(part));
    }

    const outputXml = new TextDecoder().decode(output.files.get('word/document.xml') as Uint8Array);
    const sourceXml = new TextDecoder().decode(source.files.get('word/document.xml') as Uint8Array);

    // Every table survives; only the two conditional ranges may be removed.
    const countTables = (xml: string) => (xml.match(/<w:tbl>/g) ?? []).length;
    expect(countTables(outputXml)).toBe(countTables(sourceXml));

    const text = (await extractParagraphs(rendered.docx)).join('\n');
    expect(text).toContain('CORPORATE INCOME TAX (T2) ENGAGEMENT LETTER');
    expect(text).toContain('ACCEPTANCE BY THE CORPORATION');
    expect(text).toContain('SCHEDULE A');
  });

  it('renders deterministically', async () => {
    const options = {
      manifest: template.manifest,
      values: T2_VALUES,
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'DRAFT' as const,
    };

    const first = await renderDocx(template.docx, options);
    const second = await renderDocx(template.docx, options);

    // Byte-identical output means a file hash is a meaningful identity.
    expect(first.docx.equals(second.docx)).toBe(true);
  });

  it('carries no wall-clock timestamp, so two renders minutes apart still match', async () => {
    // Rendering twice in a row cannot catch a clock read: both calls land in
    // the same second. JSZip used to invent folder entries stamped with the
    // current time, which made a document hash change on its own. Assert on the
    // archive itself rather than on a repeated call.
    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: T2_VALUES,
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'DRAFT' as const,
    });

    const entries = await listDocxEntries(rendered.docx);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((entry) => entry.isDirectory)).toHaveLength(0);
    for (const entry of entries) {
      expect(entry.date.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    }
  });

  it('sends T2 with no Adobe tags at all, so Adobe places its own fields', async () => {
    const signers = [
      { role: 'FIRM_SIGNER', signingOrder: 1 },
      { role: 'AUTHORIZED_SIGNING_OFFICER', signingOrder: 2 },
    ];

    const draft = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: T2_VALUES,
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'DRAFT',
    });
    const signing = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: T2_VALUES,
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'FOR_SIGNATURE',
      signers,
    });

    const draftText = (await extractParagraphs(draft.docx)).join('\n');
    const signingText = (await extractParagraphs(signing.docx)).join('\n');

    expect(draftText).not.toContain('_es_:');

    // The T2 template has no signature line to anchor to — only a date — and the
    // firm chose not to edit the approved wording to add one. Sending a document
    // with a date field but no signature field risks Adobe taking over placement
    // and giving the officer no way to sign at all. An agreement nobody can sign
    // is worse than a blank date line, so T2 goes out untagged and Adobe places
    // both fields itself.
    expect(signingText).not.toContain('_es_:');
  });

  it('never writes a signature or signed date from supplied values', async () => {
    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      // A stale prior-year signature date must not survive into the new letter.
      values: { ...T2_VALUES, 'signature.officer_date': 'March 1, 2025' },
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'DRAFT',
    });

    const text = (await extractParagraphs(rendered.docx)).join('\n');
    expect(text).not.toContain('March 1, 2025');
  });
});

describe('PDF conversion and validation', () => {
  it('converts to a valid PDF and passes validation', async () => {
    const template = await loadTemplate('T2_ENGAGEMENT_LETTER');

    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: { ...T2_VALUES, 'pricing.compilation_fee': 'Not applicable' },
      selections: { ...T2_SELECTIONS, 't2.csrs4200': false },
      includedSections: [],
      mode: 'DRAFT',
    });

    const pdf = await convertDocxToPdf(rendered.docx, { tempDirectory: '/tmp' });

    expect(isPdf(pdf.pdf)).toBe(true);
    expect(pdf.pageCount).toBeGreaterThan(0);
    expect(countPdfPages(pdf.pdf)).toBe(pdf.pageCount);

    const report = await validateRenderedDocument({
      docx: rendered.docx,
      manifest: template.manifest,
      requiredTokens: requiredFieldTokens(template.manifest, []),
      values: { ...T2_VALUES, 'pricing.compilation_fee': 'Not applicable' },
      pdfPageCount: pdf.pageCount,
      pdfConverted: true,
      expectedClientName: 'Northwind Sample Holdings Ltd.',
      expectedYearText: 'March 31, 2026',
    });

    expect(report.issues.filter((issue) => issue.severity === 'ERROR')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('fails validation when a required value is missing', async () => {
    const template = await loadTemplate('T2_ENGAGEMENT_LETTER');
    const values = { ...T2_VALUES };
    delete values['corporation.legal_name'];

    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values,
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'DRAFT',
    });

    const report = await validateRenderedDocument({
      docx: rendered.docx,
      manifest: template.manifest,
      requiredTokens: requiredFieldTokens(template.manifest, []),
      values,
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('REQUIRED_FIELD_BLANK');
  });

  it('fails validation on an invalid email address', async () => {
    const template = await loadTemplate('T2_ENGAGEMENT_LETTER');
    const values = { ...T2_VALUES, 'signer.officer_email': 'not-an-email' };

    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values,
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'DRAFT',
    });

    const report = await validateRenderedDocument({
      docx: rendered.docx,
      manifest: template.manifest,
      requiredTokens: [],
      values,
    });

    expect(report.issues.map((issue) => issue.code)).toContain('INVALID_EMAIL');
  });

  it('fails validation when a date or fee is unconfirmed', async () => {
    const template = await loadTemplate('T2_ENGAGEMENT_LETTER');

    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values: T2_VALUES,
      selections: T2_SELECTIONS,
      includedSections: [],
      mode: 'DRAFT',
    });

    const report = await validateRenderedDocument({
      docx: rendered.docx,
      manifest: template.manifest,
      requiredTokens: [],
      values: T2_VALUES,
      unconfirmedDates: ['dates.filing_due'],
      unconfirmedFees: ['T2_PREPARATION'],
    });

    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('UNCONFIRMED_DATE');
    expect(codes).toContain('UNCONFIRMED_FEE');
  });
});

describe('every approved template renders', () => {
  const documentTypes = [
    'T1_JOINT_ENGAGEMENT_LETTER',
    'T3_ENGAGEMENT_LETTER',
    'T1_COVER_LETTER',
    'COMPILATION_COVER_LETTER',
  ];

  for (const documentType of documentTypes) {
    it(`${documentType} renders with no unresolved tokens and converts to PDF`, async () => {
      const template = await loadTemplate(documentType);

      // Fill every declared field with a sample value.
      const values: Record<string, string> = {};
      for (const field of template.manifest.fields) {
        values[field.token] =
          field.dataType === 'MONEY'
            ? '1,000.00'
            : field.dataType === 'DATE'
              ? 'March 31, 2026'
              : field.dataType === 'EMAIL'
                ? 'sample@example.test'
                : field.dataType === 'YEAR'
                  ? '2026'
                  : `Sample ${field.label}`;
      }

      const rendered = await renderDocx(template.docx, {
        manifest: template.manifest,
        values,
        selections: {},
        includedSections: [],
        mode: 'DRAFT',
      });

      expect(rendered.unresolvedTokens, documentType).toEqual([]);

      const text = (await extractParagraphs(rendered.docx)).join('\n');
      for (const required of template.manifest.sanitation.requiredText) {
        expect(text, `${documentType} must still contain "${required}"`).toContain(required);
      }

      const pdf = await convertDocxToPdf(rendered.docx, { tempDirectory: '/tmp' });
      expect(isPdf(pdf.pdf), documentType).toBe(true);

      const [min, max] = template.manifest.sanitation.expectedPageRange ?? [1, 100];
      expect(pdf.pageCount, `${documentType} page count`).toBeGreaterThanOrEqual(min);
      expect(pdf.pageCount, `${documentType} page count`).toBeLessThanOrEqual(max);
    });
  }
});

describe('dynamic enclosure list', () => {
  it('removes the enclosure bullets whose documents are not in the package', async () => {
    const template = await loadTemplate('COMPILATION_COVER_LETTER');

    const values: Record<string, string> = {};
    for (const field of template.manifest.fields) values[field.token] = 'Sample';

    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values,
      selections: {},
      includedSections: [],
      mode: 'DRAFT',
      // Only the financial statements are actually in the package.
      removeBlocksMatching: [
        'Corporate income tax returns and supporting schedules',
        'Trial balance and adjusting journal entries',
        'Federal and provincial corporate tax filing authorization forms',
        'Engagement letter, where applicable',
        'Other schedules or documents prepared as part of the engagement',
      ],
    });

    const text = (await extractParagraphs(rendered.docx)).join('\n');

    expect(text).toContain('Compiled financial statements and the compilation engagement report');
    expect(text).not.toContain('Trial balance and adjusting journal entries');
    expect(text).not.toContain('Federal and provincial corporate tax filing authorization forms');
  });
});

describe('document comparison', () => {
  it('identifies added, removed and modified paragraphs', () => {
    const changes = diffParagraphs(
      ['Unchanged clause.', 'Old fee wording is here.', 'Removed clause.'],
      ['Unchanged clause.', 'New fee wording is here.'],
    );

    const kinds = changes.map((change) => change.kind);
    expect(kinds).toContain('UNCHANGED');
    expect(kinds).toContain('MODIFIED');
    expect(kinds).toContain('REMOVED');
  });

  it('flags prior-year custom wording without carrying it forward', () => {
    const findings = findPriorYearCustomWording(
      [
        'We will prepare the T2 Corporation Income Tax Return and the schedules ordinarily required for the taxation year.',
        'The Firm agrees to a bespoke liability cap of fifty thousand dollars negotiated with the client in a previous year.',
      ],
      ['We will prepare the T2 Corporation Income Tax Return and the schedules ordinarily required for the taxation year.'],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.label).toBe('Prior-year custom wording not carried forward');
    expect(findings[0]?.priorYearText).toMatch(/bespoke liability cap/);
  });
});

describe('who each signature field belongs to', () => {
  /**
   * The firm signs first, so the firm is Adobe's `signer1` and the taxpayers are
   * `signer2`.
   *
   * The manifests used to carry these indices as literals written by hand — T1
   * joint had the taxpayers at signer1/signer2 and the firm at signer3. Moving
   * the firm to order 1 without recomputing them would have left every field
   * addressed to the wrong participant set, and nothing on that path raises an
   * error: the document renders, Adobe accepts it, the agreement completes, and
   * the taxpayer's signature lands in the block reserved for the firm.
   *
   * These assertions are the only thing standing between that change and a
   * countersigned letter that attributes signatures to the wrong people.
   */
  it('addresses T1 joint fields by the order the signers actually hold', async () => {
    const template = await loadTemplate('T1_JOINT_ENGAGEMENT_LETTER');

    const values: Record<string, string> = {};
    for (const field of template.manifest.fields) values[field.token] = 'Sample';

    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values,
      selections: {},
      includedSections: [],
      mode: 'FOR_SIGNATURE',
      signers: [
        { role: 'FIRM_SIGNER', signingOrder: 1 },
        { role: 'TAXPAYER_1', signingOrder: 2 },
        { role: 'TAXPAYER_2', signingOrder: 2 },
      ],
    });

    const text = (await extractParagraphs(rendered.docx)).join('\n');

    // The firm holds the earliest order, so it is Adobe's set 1.
    expect(text).toContain('{{Sig_es_:signer1:signature}}');
    expect(text).toContain('{{Dte_es_:signer1:date}}');

    // Both taxpayers share order 2, so they share set 2. The manifest's old
    // hardcoded literals put them at signer1 and signer2 with the firm at
    // signer3 -- every field addressed to the wrong participant.
    expect(text).toContain('{{Sig_es_:signer2:signature}}');
    expect(text).toContain('{{Dte_es_:signer2:date}}');
    expect(text).not.toContain('signer3');

    // The email and telephone rules are left for the client to write on. The
    // firm's decision is that a client fills nothing in Adobe.
    expect(text).toContain('Email address');
  });

  it('refuses to render when a required signer is missing rather than leaving a blank', async () => {
    const template = await loadTemplate('T1_JOINT_ENGAGEMENT_LETTER');

    const values: Record<string, string> = {};
    for (const field of template.manifest.fields) values[field.token] = 'Sample';

    // A joint letter needs both taxpayers. Rendering the second one's block as a
    // blank line would send an agreement that completes with one signature where
    // two are legally required, and Adobe would report nothing wrong.
    await expect(
      renderDocx(template.docx, {
        manifest: template.manifest,
        values,
        selections: {},
        includedSections: [],
        mode: 'FOR_SIGNATURE',
        signers: [
          { role: 'FIRM_SIGNER', signingOrder: 1 },
          { role: 'TAXPAYER_1', signingOrder: 2 },
        ],
      }),
    ).rejects.toThrow(/TAXPAYER_2/);
  });
});

describe('normalisation did not damage the approved wording', () => {
  /**
   * Every normalised template must still read as English.
   *
   * Normalising T1 joint corrupted its signature block: replacing
   * `[TAXPAYER 2 FULL LEGAL NAME]` left a stray `[TAX` behind and consumed the
   * first four characters of the *following* paragraph, turning "Electronic
   * signature" into "tronic signature". The placeholder validator never caught
   * it because its pattern requires a closing bracket and the damage left none,
   * so a production-supported letter would have gone to a client reading
   * "[TAXJane Smith / tronic signature".
   */
  const templates = [
    'T1_JOINT_ENGAGEMENT_LETTER',
    'T2_ENGAGEMENT_LETTER',
    'T3_ENGAGEMENT_LETTER',
    'T1_COVER_LETTER',
    'COMPILATION_COVER_LETTER',
  ];

  for (const documentType of templates) {
    it(`${documentType} carries no truncated placeholder debris`, async () => {
      const template = await loadTemplate(documentType);
      const text = (await extractParagraphs(template.docx)).join('\n');

      // An opening bracket that never closes is the signature of a replacement
      // that ran off the end of its run.
      const orphaned = text.match(/\[[A-Z]{2,}(?!\w*\])[^\n[\]]{0,20}/g) ?? [];
      const debris = orphaned.filter((hit) => !hit.startsWith('[['));

      expect(debris, `Orphaned placeholder fragments: ${JSON.stringify(debris)}`).toEqual([]);
    });
  }
});
