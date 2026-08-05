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
