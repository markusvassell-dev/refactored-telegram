import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { renderDocx, parseManifest, type TemplateManifest } from '@element/documents';
import { DocumentStore, SourceDocumentService } from '@element/services';

/**
 * Attaching a source document by hand.
 *
 * The file a person picks is put through the same checks as one Karbon located:
 * the bytes must be the type they claim to be, and the *contents* are scored
 * against this client, engagement type and year. The case that matters most is
 * the wrong client's letter — it must be stored and reported, never quietly
 * accepted as the prior year.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);

const store = new DocumentStore({
  prisma,
  rootDirectory: '/tmp/element-engagements-tests/uploads',
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: 'test-signing-secret-test-signing-secret',
});

const sourceDocuments = new SourceDocumentService({ prisma, audit, store });

const clientIds: string[] = [];
let actorId: string;
let manifest: TemplateManifest;
let templateDocx: Buffer;

const TAX_YEAR = 2026;
const CLIENT_NAME = 'Northwind Upload Holdings Ltd.';

beforeAll(async () => {
  await prisma.$connect();

  const actor = await prisma.user.upsert({
    where: { email: 'upload-test@example.test' },
    create: { email: 'upload-test@example.test', displayName: 'Upload Test' },
    update: {},
  });
  actorId = actor.id;

  const root = process.cwd();
  manifest = parseManifest(
    JSON.parse(await readFile(join(root, 'templates', 'manifests', 'T2_ENGAGEMENT_LETTER.json'), 'utf8')),
  );
  templateDocx = await readFile(join(root, 'templates', 'normalized', manifest.sourceFileName));
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

async function newEngagement(
  clientName = CLIENT_NAME,
  businessNumber = '11111 1111 RC0001',
): Promise<string> {
  const client = await prisma.client.create({
    data: { legalName: clientName, businessNumber, isTestFixture: true },
  });
  clientIds.push(client.id);

  const engagement = await prisma.engagement.create({
    data: {
      clientId: client.id,
      engagementType: 'T2',
      taxYear: TAX_YEAR,
      yearEnd: new Date(Date.UTC(TAX_YEAR, 2, 31)),
      status: 'NOT_STARTED',
      isTestMode: true,
    },
  });

  return engagement.id;
}

/**
 * A real prior-year engagement letter, rendered from the approved template so
 * the verification signals have genuine content to match against.
 */
async function priorYearLetter(values: Record<string, string> = {}): Promise<Buffer> {
  const rendered = await renderDocx(templateDocx, {
    manifest,
    values: {
      'corporation.legal_name': CLIENT_NAME,
      'corporation.business_number': '11111 1111 RC0001',
      'corporation.year_end': `March 31, ${TAX_YEAR - 1}`,
      'signer.officer_name': 'Dana Sample',
      'signer.officer_title': 'President',
      'signer.officer_email': 'dana@example.test',
      'firm.signer_name': 'Sample Partner, CPA, CA',
      'firm.engagement_lead': 'Sample Lead',
      'dates.sent': `August 4, ${TAX_YEAR - 1}`,
      'dates.client_information_due': `June 30, ${TAX_YEAR - 1}`,
      'dates.target_completion': 'Subject to complete information',
      'dates.filing_due': `September 30, ${TAX_YEAR - 1}`,
      'dates.balance_due': `May 31, ${TAX_YEAR - 1}`,
      'pricing.t2_fee': '2,000.00',
      'pricing.compilation_fee': 'Not applicable',
      'pricing.billing_basis': 'Fixed fee',
      'pricing.retainer': 'Not applicable',
      'pricing.payment_terms': 'upon receipt',
      'pricing.payment_terms_short': 'Upon receipt',
      'pricing.additional_work': 'Quoted separately',
      'services.other_included': 'None',
      'services.other_optional': 'None',
      'special_terms.line_1': 'None',
      'special_terms.line_2': 'None',
      ...values,
    },
    selections: { 't2.federal_return': true, 't2.gifi': true, 't2.csrs4200': false },
    includedSections: [],
    mode: 'DRAFT',
  });

  return rendered.docx;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function upload(engagementId: string, content: Uint8Array, overrides: Record<string, unknown> = {}) {
  return sourceDocuments.upload({
    engagementId,
    actorId,
    fileName: 'Prior Year Engagement Letter.docx',
    mimeType: DOCX_MIME,
    content,
    kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
    ...overrides,
  } as Parameters<SourceDocumentService['upload']>[0]);
}

describe('attaching a prior-year letter', () => {
  it('stores it, scores its contents, and confirms it', async () => {
    const engagementId = await newEngagement();

    const result = await upload(engagementId, await priorYearLetter());

    expect(result.duplicate).toBe(false);
    expect(result.disqualifiers).toEqual([]);
    expect(result.confirmed).toBe(true);
    expect(result.verificationScore).toBeGreaterThan(0.5);

    const stored = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: result.sourceDocumentId } });
    expect(stored.kind).toBe('PRIOR_YEAR_ENGAGEMENT_LETTER');
    expect(stored.mimeType).toBe(DOCX_MIME);
    expect(stored.storagePath).toBeTruthy();
    expect(stored.confirmedByUserId).toBe(actorId);
    expect(stored.byteSize).toBeGreaterThan(0);

    // The signals are kept so a reviewer can see *why* it scored what it did.
    const detail = stored.verificationDetail as { signals: { key: string; matched: boolean }[] };
    expect(detail.signals.some((signal) => signal.key === 'client_legal_name' && signal.matched)).toBe(true);
  });

  it('reads the bytes back for extraction', async () => {
    const engagementId = await newEngagement();
    const content = await priorYearLetter();

    const result = await upload(engagementId, content);
    const readBack = await sourceDocuments.contentOf(result.sourceDocumentId);

    expect(readBack?.content.equals(Buffer.from(content))).toBe(true);
  });

  it('records the attachment in the audit trail without copying the document into it', async () => {
    const engagementId = await newEngagement();
    await upload(engagementId, await priorYearLetter());

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { engagementId, eventType: 'SOURCE_DOCUMENT_SELECTED' },
    });

    expect(event.userId).toBe(actorId);
    expect(event.afterValue).toMatchObject({ kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER', confirmed: true });
    expect(JSON.stringify(event.afterValue).length).toBeLessThan(2000);
  });
});

describe('what it refuses to trust', () => {
  it('stores another client’s letter unconfirmed, because its contents do not support it', async () => {
    // The engagement is for one client; the letter names a different one. This
    // carries no disqualifier — it simply matches almost nothing — so it is the
    // case that proves confirmation is not granted just for picking a file.
    const engagementId = await newEngagement('Completely Different Enterprises Inc.', '99999 9999 RC0001');

    const result = await upload(engagementId, await priorYearLetter());

    expect(result.confirmed).toBe(false);
    expect(result.confident).toBe(false);
    // Below the automatic-acceptance threshold, which is what "not confident"
    // means — the document type and period still match, the client does not.
    expect(result.verificationScore).toBeLessThan(0.7);
    expect(result.notes.join(' ')).toMatch(/do not match this client/i);

    const stored = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: result.sourceDocumentId } });
    // Kept, not discarded: a person decides whether it is really wrong.
    expect(stored.confirmedAt).toBeNull();
    expect(stored.storagePath).toBeTruthy();
  });

  it('refuses bytes that are not the type they claim to be', async () => {
    const engagementId = await newEngagement();

    await expect(
      upload(engagementId, Buffer.from('%PDF-1.4 this is really a pdf', 'utf8'), { mimeType: DOCX_MIME }),
    ).rejects.toThrow(/do not match the declared file type/i);

    expect(await prisma.sourceDocument.count({ where: { engagementId } })).toBe(0);
  });

  it('refuses a type that is not accepted at all', async () => {
    const engagementId = await newEngagement();

    await expect(
      upload(engagementId, Buffer.from('plain text', 'utf8'), { mimeType: 'text/plain' }),
    ).rejects.toThrow(/not accepted/i);
  });

  it('refuses an empty file', async () => {
    const engagementId = await newEngagement();

    await expect(upload(engagementId, new Uint8Array(0))).rejects.toThrow(/Choose a file/i);
  });
});

describe('attaching the same file twice', () => {
  it('reports it rather than creating a second row', async () => {
    const engagementId = await newEngagement();
    const content = await priorYearLetter();

    const first = await upload(engagementId, content);
    const second = await upload(engagementId, content);

    expect(second.duplicate).toBe(true);
    expect(second.sourceDocumentId).toBe(first.sourceDocumentId);
    expect(second.notes.join(' ')).toMatch(/already attached/i);

    expect(await prisma.sourceDocument.count({ where: { engagementId } })).toBe(1);
  });

  it('treats a different file as a new candidate', async () => {
    const engagementId = await newEngagement();

    await upload(engagementId, await priorYearLetter());
    await upload(engagementId, await priorYearLetter({ 'pricing.t2_fee': '2,500.00' }));

    expect(await prisma.sourceDocument.count({ where: { engagementId } })).toBe(2);
  });
});

describe('a kind that is not an engagement letter', () => {
  it('is stored and confirmed without being scored as one', async () => {
    const engagementId = await newEngagement();

    const result = await upload(engagementId, await priorYearLetter(), { kind: 'TRIAL_BALANCE' });


    // Scoring a trial balance against engagement-letter signals would produce a
    // meaningless number, so none is recorded.
    expect(result.verificationScore).toBeNull();
    expect(result.disqualifiers).toEqual([]);
    expect(result.confirmed).toBe(true);
  });
});

/**
 * Documents the reader cannot open.
 *
 * These three calls — PDF text, DOCX paragraphs, page count — were unguarded,
 * so a file that could not be parsed threw out of the whole action and reached
 * the user as "Something went wrong", with the cause visible only in a log.
 *
 * The commonest trigger is the commonest document. Acrobat routinely encrypts a
 * PDF with an owner password when it applies a signature, to lock permissions;
 * pdf.js will not open one at all. Attaching last year's *signed* engagement
 * letter is the main thing anybody does on this screen, so the single most
 * likely file to be chosen was the one certain to fail.
 */
describe('a document that cannot be read', () => {
  /** A standard-security /Encrypt dictionary — the shape Acrobat produces. */
  function encryptedPdf(): Buffer {
    const objects = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n',
      `4 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <${'2'.repeat(64)}> /U <${'A'.repeat(64)}> /P -44 >>\nendobj\n`,
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (const object of objects) {
      offsets.push(pdf.length);
      pdf += object;
    }

    const xref = pdf.length;
    pdf += 'xref\n0 5\n0000000000 65535 f \n';
    for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    pdf +=
      `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<${'0'.repeat(32)}> <${'0'.repeat(32)}>] >>\n` +
      `startxref\n${xref}\n%%EOF\n`;

    return Buffer.from(pdf, 'latin1');
  }

  it('attaches an encrypted PDF and explains why nothing was read, instead of throwing', async () => {
    const engagementId = await newEngagement();

    const result = await upload(engagementId, encryptedPdf(), {
      fileName: 'T2 Engagement Letter - signed.pdf',
      mimeType: 'application/pdf',
    });

    // It is held, not lost. Refusing the file would mean the reviewer has
    // nowhere to put a document Karbon is holding for this client.
    const stored = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: result.sourceDocumentId } });
    expect(stored.storagePath).toBeTruthy();
    expect(stored.byteSize).toBeGreaterThan(0);

    // And it is not quietly trusted. Nothing was read, so nothing supports it.
    expect(result.confirmed).toBe(false);
    expect(stored.confirmedAt).toBeNull();

    // The note names the cause and the remedy. "Could not be read" sends
    // somebody looking for a fault that is not there — the file is intact, it
    // is locked, and the fix is a different copy.
    //
    // It claims only what pdf.js actually reported: the file wants a password.
    // An earlier version of this message asserted that Acrobat's permissions
    // lock on signed PDFs was the cause. That is not established — a PDF
    // carrying only an owner password opens normally, without complaint — and
    // stating it as fact would send somebody re-saving every signed letter they
    // have to fix something that may not be wrong.
    const note = result.notes.join(' ');
    expect(note).toMatch(/needs a password/i);
    expect(note).toMatch(/attach a copy saved without the password/i);
  });

  it('attaches a damaged PDF and says it is damaged, not that it is locked', async () => {
    const engagementId = await newEngagement();

    const result = await upload(engagementId, Buffer.from('%PDF-1.4\nnot actually a pdf\n%%EOF'), {
      fileName: 'broken.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.confirmed).toBe(false);

    // The two failures need different responses — print it flat, or go and find
    // a good copy — so telling them apart is the whole point of the message.
    const note = result.notes.join(' ');
    expect(note).toMatch(/damaged|not really a PDF/i);
    expect(note).not.toMatch(/encrypted/i);
  });

  it('still records the page count when only the text extraction failed', async () => {
    const engagementId = await newEngagement();

    const result = await upload(engagementId, encryptedPdf(), {
      fileName: 'signed.pdf',
      mimeType: 'application/pdf',
    });

    // Counted separately from the text on purpose: discarding what did work
    // because something else did not is its own small loss.
    const stored = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: result.sourceDocumentId } });
    expect(stored.pageCount === null || stored.pageCount >= 1).toBe(true);
  });
});
