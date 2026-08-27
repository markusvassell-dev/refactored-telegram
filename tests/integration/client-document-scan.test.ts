import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { MockKarbonProvider, type KarbonProvider } from '@element/integrations';
import { ClientDocumentScanService, DocumentStore, JobQueue } from '@element/services';
import { createLogger } from '@element/shared';
import { makePdf } from '../helpers/pdf.js';

/**
 * Reading every document a client has.
 *
 * The properties worth holding are not "how much did it find". They are that it
 * never treats a document it could not identify as this client's, never reports
 * a partial read as a complete one, and never quietly loses a file it could not
 * open.
 *
 * Every fixture here is a real PDF with a real text layer, because the scan runs
 * pdf.js over the bytes: a buffer of plain text named `.pdf` is not a weak
 * document but an unreadable one, and it would exercise the "no text layer"
 * branch while appearing to test acceptance.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const queue = new JobQueue(prisma, logger);
const store = new DocumentStore({
  prisma,
  rootDirectory: '/tmp/element-engagements-tests/scan',
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: 'test-signing-secret-test-signing-secret',
});

const scanner = new ClientDocumentScanService({ prisma, audit, store, queue, logger });

let clientId: string;

/**
 * Engagements are unique on (client, type, year), so each one gets its own — and
 * every document is then built for *that* engagement's prior year. A fixture
 * whose letter says 2025 under an engagement for year 3301 fails the tax-year
 * signal, which costs it two points of a fifteen-point scale and refuses a
 * document the test means to be accepted.
 */
let nextTaxYear = 2019;

const CLIENT_NAME = 'Northwind Scan Holdings Ltd.';
const BUSINESS_NUMBER = '12345 6789 RC0001';

function letter(year: number, options: { name?: string; bn?: string } = {}): Buffer {
  return makePdf(
    [
      'Corporate Income Tax (T2) Engagement Letter',
      `To: ${options.name ?? CLIENT_NAME}`,
      `Business Number: ${options.bn ?? BUSINESS_NUMBER}`,
      `Taxation year-end: March 31, ${year}`,
      `We are pleased to confirm our understanding for the ${year} taxation year.`,
      'Billing basis\tFixed fee, billed on completion',
      'T2 preparation fee\t$1,800.00',
    ].join('\n'),
  );
}

function trialBalance(): Buffer {
  return makePdf(['Trial Balance', 'Account Debit Credit', '1000 Cash 51,204 0'].join('\n'));
}

function notice(year: number): Buffer {
  return makePdf(
    ['Notice of Assessment', '', CLIENT_NAME, '', `Business Number (BN): ${BUSINESS_NUMBER}`, `Tax year-end: ${year}-03-31`].join(
      '\n',
    ),
  );
}

beforeAll(async () => {
  await prisma.$connect();
  const client = await prisma.client.create({
    data: {
      legalName: CLIENT_NAME,
      businessNumber: BUSINESS_NUMBER,
      karbonEntityKey: `entity-${randomUUID().slice(0, 8)}`,
      isTestFixture: true,
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  const engagements = await prisma.engagement.findMany({ where: { clientId }, select: { id: true } });
  const ids = engagements.map((engagement) => engagement.id);
  await prisma.sourceDocumentScan.deleteMany({ where: { engagementId: { in: ids } } });
  await prisma.backgroundJob.deleteMany({ where: { engagementId: { in: ids } } });
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.karbonWorkItem.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.$disconnect();
});

/** An engagement, its Karbon work item key, and the year its documents are from. */
async function newT2() {
  nextTaxYear += 1;
  const priorYear = nextTaxYear - 1;

  const workItem = await prisma.karbonWorkItem.create({
    data: { karbonKey: `wi-${randomUUID().slice(0, 8)}`, clientId, title: 'T2', taxYear: nextTaxYear },
  });

  const engagement = await prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T2',
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(priorYear, 2, 31)),
      status: 'NOT_STARTED',
      isTestMode: true,
      karbonWorkItemId: workItem.id,
    },
  });

  return { engagement, workItemKey: workItem.karbonKey, priorYear };
}

function karbonWith(documents: { documentId: string; fileName: string; content: Buffer; workItemKey: string }[]) {
  return new MockKarbonProvider({
    documents: documents.map((document) => ({
      documentId: document.documentId,
      fileName: document.fileName,
      workItemKey: document.workItemKey,
      content: document.content,
      mimeType: document.fileName.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
    })),
  });
}

function run(engagementId: string, karbon: KarbonProvider) {
  return scanner.scan({ engagementId, karbon, correlationId: randomUUID(), actorId: null });
}

describe('what a scan accepts', () => {
  it('accepts a document it can identify and refuses one it cannot', async () => {
    const { engagement, workItemKey, priorYear } = await newT2();

    const karbon = karbonWith([
      { documentId: 'ours', fileName: `${priorYear} Engagement Letter.pdf`, content: letter(priorYear), workItemKey },
      {
        documentId: 'someone-else',
        fileName: `${priorYear} Engagement Letter.pdf`,
        content: letter(priorYear, { name: 'Southwind Trading Inc.', bn: '99999 8888 RC0001' }),
        workItemKey,
      },
    ]);

    const result = await run(engagement.id, karbon);

    expect(result.documentsRead).toBe(2);
    expect(result.documentsAccepted).toBe(1);

    const rows = await prisma.sourceDocument.findMany({ where: { engagementId: engagement.id } });
    const accepted = rows.filter((row) => row.confirmedAt !== null);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.karbonDocumentId).toBe('ours');
  });

  /**
   * Every considered document keeps a score and a reason, accepted or not.
   * "It found nothing" and "it looked at eleven things and none of them were
   * yours" are different answers, and only one of them is actionable.
   */
  it('records a score and a reason against every document it refused', async () => {
    const { engagement, workItemKey, priorYear } = await newT2();

    const karbon = karbonWith([
      {
        documentId: 'stranger',
        fileName: 'letter.pdf',
        content: letter(priorYear, { name: 'Southwind Trading Inc.', bn: '99999 8888 RC0001' }),
        workItemKey,
      },
    ]);

    await run(engagement.id, karbon);

    const row = await prisma.sourceDocument.findFirstOrThrow({
      where: { engagementId: engagement.id, karbonDocumentId: 'stranger' },
    });

    expect(row.confirmedAt).toBeNull();
    expect(row.verificationScore).not.toBeNull();
    expect(JSON.stringify(row.verificationDetail)).toMatch(/refusals/);
  });

  it('files a document under what it actually is, not under what was looked for', async () => {
    const { engagement, workItemKey, priorYear } = await newT2();

    const karbon = karbonWith([
      { documentId: 'noa', fileName: 'cra.pdf', content: notice(priorYear), workItemKey },
      { documentId: 'tb', fileName: `${priorYear} Engagement Letter.pdf`, content: trialBalance(), workItemKey },
    ]);

    await run(engagement.id, karbon);

    const rows = await prisma.sourceDocument.findMany({ where: { engagementId: engagement.id } });
    const byId = new Map(rows.map((row) => [row.karbonDocumentId, row]));

    expect(byId.get('noa')?.kind).toBe('NOTICE_OF_ASSESSMENT');
    // Named as a letter, and it is a trial balance.
    expect(byId.get('tb')?.kind).toBe('TRIAL_BALANCE');
  });

  it('never downloads a file it cannot read', async () => {
    const { engagement, workItemKey } = await newT2();

    const karbon = karbonWith([{ documentId: 'sheet', fileName: 'workings.xlsx', content: Buffer.from('binary'), workItemKey }]);

    const result = await run(engagement.id, karbon);

    expect(result.documentsConsidered).toBe(0);
    const downloads = karbon.calls.filter((call) => call.operation === 'downloadDocuments');
    expect(downloads).toHaveLength(0);
  });

  it('produces one row for the same file listed under two scopes', async () => {
    const { engagement, workItemKey, priorYear } = await newT2();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

    // One file, filed against both the work item and the client — which is one
    // seeded document carrying both keys, because the file key *is* its
    // identity. Seeding it twice under the same id would collapse to a single
    // entry in one scope, and the test would pass without ever listing the same
    // document twice.
    const karbon = new MockKarbonProvider({
      documents: [
        {
          documentId: 'shared',
          fileName: `${priorYear} Engagement Letter.pdf`,
          workItemKey,
          entityKey: client.karbonEntityKey as string,
          content: letter(priorYear),
          mimeType: 'application/pdf',
        },
      ],
    });

    const result = await run(engagement.id, karbon);

    // The premise, asserted rather than assumed: it really was handed to the
    // scan twice.
    expect(result.documentsConsidered).toBe(2);

    const rows = await prisma.sourceDocument.findMany({
      where: { engagementId: engagement.id, karbonDocumentId: 'shared' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('what a scan writes', () => {
  it('takes values from an accepted document and cites where each came from', async () => {
    const { engagement, workItemKey, priorYear } = await newT2();

    const karbon = karbonWith([
      { documentId: 'ours', fileName: `${priorYear} Engagement Letter.pdf`, content: letter(priorYear), workItemKey },
    ]);

    const result = await run(engagement.id, karbon);
    expect(result.tokensFilled).toBeGreaterThan(0);

    const fields = await prisma.extractedField.findMany({
      where: { engagementId: engagement.id, source: 'PRIOR_YEAR_DOCUMENT' },
      include: { evidence: true },
    });

    const billing = fields.find((field) => field.token === 'pricing.billing_basis');
    expect(billing?.value).toBe('Fixed fee, billed on completion');
    expect(billing?.evidence.length).toBeGreaterThan(0);
    expect(billing?.evidence[0]?.sourceDocumentId).not.toBeNull();
  });

  it('leaves a value a reviewer confirmed exactly as they left it', async () => {
    const { engagement, workItemKey, priorYear } = await newT2();

    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: 'pricing.billing_basis',
        value: 'Time and materials, billed monthly',
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: 'MANUAL_ENTRY',
        manuallyConfirmed: true,
        confirmedAt: new Date(),
        confidence: 1,
      },
    });

    // The document says something different, and is accepted — so the guard is
    // what keeps the reviewer's answer, not the absence of a competing one.
    const karbon = karbonWith([
      { documentId: 'ours', fileName: `${priorYear} Engagement Letter.pdf`, content: letter(priorYear), workItemKey },
    ]);
    const result = await run(engagement.id, karbon);
    expect(result.documentsAccepted).toBe(1);

    const stored = await prisma.extractedField.findFirstOrThrow({
      where: { engagementId: engagement.id, token: 'pricing.billing_basis' },
    });
    expect(stored.value).toBe('Time and materials, billed monthly');
  });
});

describe('what a scan reports', () => {
  /**
   * The distinction the whole record exists for. Ninety-one documents from a
   * complete read and ninety-one from a read that lost a scope are not the same
   * answer, and only the second one makes "this client has no prior-year
   * letter" a claim nobody should act on.
   */
  it('reports a scope it could not read rather than treating it as empty', async () => {
    const { engagement, workItemKey, priorYear } = await newT2();

    const karbon = karbonWith([
      { documentId: 'ours', fileName: `${priorYear} Engagement Letter.pdf`, content: letter(priorYear), workItemKey },
    ]);

    const failing: KarbonProvider = Object.assign(Object.create(Object.getPrototypeOf(karbon)), karbon, {
      listDocuments: async (scope: { workItemKey?: string; entityKey?: string }) => {
        if (scope.entityKey) throw new Error('Karbon timed out reading the client’s own documents.');
        return karbon.listDocuments(scope);
      },
    });

    const result = await run(engagement.id, failing);

    expect(result.complete).toBe(false);
    expect(result.scopesFailed).toBeGreaterThan(0);

    const scan = await prisma.sourceDocumentScan.findFirstOrThrow({
      where: { engagementId: engagement.id },
      orderBy: { startedAt: 'desc' },
    });
    expect(scan.complete).toBe(false);
    expect(JSON.stringify(scan.failureDetail)).toMatch(/timed out/i);

    // And what it did read is still saved.
    expect(result.documentsAccepted).toBe(1);
  });

  it('reports a complete read as complete', async () => {
    const { engagement, workItemKey, priorYear } = await newT2();

    const karbon = karbonWith([
      { documentId: 'ours', fileName: `${priorYear} Engagement Letter.pdf`, content: letter(priorYear), workItemKey },
    ]);

    const result = await run(engagement.id, karbon);

    expect(result.complete).toBe(true);
    expect(result.scopesFailed).toBe(0);
  });

  it('says nothing was read when the engagement is not linked to Karbon', async () => {
    const unlinked = await prisma.client.create({
      data: { legalName: `Unlinked ${randomUUID().slice(0, 8)}`, isTestFixture: true },
    });
    const engagement = await prisma.engagement.create({
      data: {
        clientId: unlinked.id,
        engagementType: 'T2',
        taxYear: (nextTaxYear += 1),
        yearEnd: new Date(Date.UTC(2025, 2, 31)),
        status: 'NOT_STARTED',
        isTestMode: true,
      },
    });

    const result = await run(engagement.id, new MockKarbonProvider());

    expect(result.reason).toMatch(/not linked to Karbon/i);
    expect(result.scanId).toBeNull();

    await prisma.engagement.deleteMany({ where: { clientId: unlinked.id } });
    await prisma.client.deleteMany({ where: { id: unlinked.id } });
  });
});
