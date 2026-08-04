/**
 * Manual smoke check for the document pipeline.
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/smoke-render.ts
 *
 * Renders the T2 engagement letter twice — with and without CSRS 4200 — and
 * converts both to PDF. Uses obviously fake sample data only.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  convertDocxToPdf,
  extractParagraphs,
  parseManifest,
  renderDocx,
  requiredFieldTokens,
  validateRenderedDocument,
} from '@element/documents';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'tmp-smoke');

const VALUES: Record<string, string> = {
  'corporation.legal_name': 'Northwind Sample Holdings Ltd.',
  'corporation.business_number': '00000 0000 RC0001',
  'corporation.year_end': 'March 31, 2026',
  'signer.officer_name': 'Sample Signing Officer',
  'signer.officer_title': 'President',
  'signer.officer_email': 'officer@example.test',
  'firm.signer_name': 'Sample Partner, CPA, CA',
  'firm.engagement_lead': 'Sample Lead, lead@example.test, 555-0100',
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
  'compilation.intended_use': 'Corporate tax filing and internal management',
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

async function renderCase(label: string, compilationSelected: boolean): Promise<void> {
  const manifest = parseManifest(
    JSON.parse(await readFile(join(ROOT, 'templates/manifests/T2_ENGAGEMENT_LETTER.json'), 'utf8')),
  );
  const template = await readFile(join(ROOT, 'templates/normalized/T2 Engagement Letter.docx'));

  const includedSections = compilationSelected ? ['csrs_4200'] : [];
  const values = { ...VALUES };
  if (!compilationSelected) values['pricing.compilation_fee'] = 'Not applicable';

  const rendered = await renderDocx(template, {
    manifest,
    values,
    selections: {
      't2.federal_return': true,
      't2.provincial_schedules': true,
      't2.gifi': true,
      't2.efile': true,
      't2.csrs4200': compilationSelected,
    },
    includedSections,
    mode: 'DRAFT',
  });

  await mkdir(OUT, { recursive: true });
  const docxPath = join(OUT, `T2-${label}.docx`);
  await writeFile(docxPath, rendered.docx);

  const pdf = await convertDocxToPdf(rendered.docx, { tempDirectory: OUT });
  await writeFile(join(OUT, `T2-${label}.pdf`), pdf.pdf);

  const report = await validateRenderedDocument({
    docx: rendered.docx,
    manifest,
    requiredTokens: requiredFieldTokens(manifest, includedSections),
    values,
    pdfPageCount: pdf.pageCount,
    pdfConverted: true,
    expectedClientName: 'Northwind Sample Holdings Ltd.',
    expectedYearText: 'March 31, 2026',
  });

  const paragraphs = await extractParagraphs(rendered.docx);
  const text = paragraphs.join('\n');

  process.stdout.write(
    `\n=== ${label} (compilation ${compilationSelected ? 'SELECTED' : 'NOT selected'}) ===\n` +
      `  removed sections     ${rendered.removedSections.join(', ') || '(none)'}\n` +
      `  removed blocks       ${rendered.removedBlockCount}\n` +
      `  unresolved tokens    ${rendered.unresolvedTokens.join(', ') || '(none)'}\n` +
      `  empty tokens         ${rendered.emptyTokens.join(', ') || '(none)'}\n` +
      `  pdf pages            ${pdf.pageCount}\n` +
      `  validation           ${report.ok ? 'PASS' : 'FAIL'} (${report.errorCount} errors, ${report.warningCount} warnings)\n` +
      `  contains 3A          ${text.includes('3A. Optional compilation engagement')}\n` +
      `  contains checklist   ${text.includes('Internal customization checklist')}\n` +
      `  contains COMPILATION REPORT ${text.includes('COMPILATION ENGAGEMENT REPORT')}\n` +
      `  csrs box ticked      ${text.includes('☒ Compilation engagement under CSRS 4200')}\n`,
  );

  for (const issue of report.issues) {
    process.stdout.write(`  [${issue.severity}] ${issue.code}: ${issue.message}${issue.detail ? ` — ${issue.detail}` : ''}\n`);
  }
}

await renderCase('with-compilation', true);
await renderCase('without-compilation', false);
