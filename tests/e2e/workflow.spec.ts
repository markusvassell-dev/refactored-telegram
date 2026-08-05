import { expect, test, type Page, type WorkerInfo } from '@playwright/test';
import { PrismaClient } from '@element/database';
import { DocumentStore } from '@element/services';
import type { E2EEnvironment } from '../../playwright.config';

/**
 * Browser end-to-end tests.
 *
 * Test Mode is on for the whole run, so nothing reaches a real client, Karbon
 * or Adobe Sign. The permanent banner asserted below is the same one a user
 * would see.
 */

async function signIn(page: Page, accountMatcher: RegExp): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Account').selectOption({ label: await optionLabel(page, accountMatcher) });
  await page.getByRole('button', { name: 'Sign in for development' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function optionLabel(page: Page, matcher: RegExp): Promise<string> {
  const labels = await page.getByLabel('Account').locator('option').allTextContents();
  const found = labels.find((label) => matcher.test(label));
  if (!found) throw new Error(`No seeded account matched ${matcher}. Run the seed first.`);
  return found;
}

/**
 * The database, storage directory and signing secret the server under test is
 * actually using, resolved once by the config and handed down through
 * `metadata`. Reading `process.env` here instead would be unreliable: importing
 * the Prisma client loads `.env` into this worker, which the process that
 * launched the server never saw.
 */
function environmentFor(worker: WorkerInfo): E2EEnvironment {
  return (worker.config.metadata as { e2eEnvironment: E2EEnvironment }).e2eEnvironment;
}

function clientFor(environment: E2EEnvironment): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: environment.databaseUrl } } });
}

/** A small but structurally valid PDF, so the fixture opens in a real viewer. */
function minimalPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}

/**
 * Puts a real PDF working copy where the server under test will find it, and
 * points a document version at it — the state a reviewer is in when they are
 * asked to approve something.
 */
async function seedPreviewableVersion(
  environment: E2EEnvironment,
): Promise<{ engagementId: string; versionId: string } | null> {
  const prisma = clientFor(environment);
  try {
    const engagement = await prisma.engagement.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!engagement) return null;

    const store = new DocumentStore({
      rootDirectory: environment.storageDirectory,
      retentionHours: 72,
      maxBytes: 25 * 1024 * 1024,
      signingSecret: environment.sessionSecret,
    });

    const stored = await store.put({
      content: minimalPdf(),
      fileName: 'Preview_Fixture_Engagement_Letter.pdf',
      mimeType: 'application/pdf',
      scope: engagement.id,
    });

    const highest = await prisma.documentVersion.findFirst({
      where: { engagementId: engagement.id },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });

    const version = await prisma.documentVersion.create({
      data: {
        engagementId: engagement.id,
        documentType: 'T2_ENGAGEMENT_LETTER',
        versionNumber: (highest?.versionNumber ?? 0) + 1,
        status: 'DRAFT',
        generatedPdfReference: stored.reference,
        pdfHash: stored.hash,
        pageCount: 1,
      },
    });

    return { engagementId: engagement.id, versionId: version.id };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Returns an engagement to its unprepared state.
 *
 * Preparation is deliberately idempotent, so running it twice tells you
 * nothing about what it does the first time — and the seeded engagement
 * survives between runs. Clearing the derived rows first is what makes the
 * assertions about blocked deadlines and unconfirmed services meaningful.
 */
async function resetPreparation(environment: E2EEnvironment, engagementId: string): Promise<void> {
  const prisma = clientFor(environment);
  try {
    await prisma.fieldConflict.deleteMany({ where: { engagementId } });
    await prisma.extractedField.deleteMany({ where: { engagementId } });
    await prisma.calculatedDate.deleteMany({ where: { engagementId } });
    await prisma.serviceSelection.deleteMany({ where: { engagementId } });
    await prisma.feeCalculation.deleteMany({ where: { engagementId } });
  } finally {
    await prisma.$disconnect();
  }
}

async function firstEngagementId(environment: E2EEnvironment): Promise<string | null> {
  const prisma = clientFor(environment);
  try {
    const engagement = await prisma.engagement.findFirst({ orderBy: { createdAt: 'asc' } });
    return engagement?.id ?? null;
  } finally {
    await prisma.$disconnect();
  }
}

async function deleteVersion(environment: E2EEnvironment, versionId: string): Promise<void> {
  const prisma = clientFor(environment);
  try {
    await prisma.documentVersion.delete({ where: { id: versionId } });
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('access control', () => {
  test('an anonymous visitor is asked to sign in and cannot reach an engagement', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in required' })).toBeVisible();

    // Server-side authorisation, not merely a hidden link.
    const response = await page.request.get('/engagements');
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('the development login is offered only because this is a test environment', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Microsoft Entra ID' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Development login' })).toBeVisible();
  });
});

test.describe('Test Mode', () => {
  test('shows a permanent banner on every page', async ({ page }) => {
    await signIn(page, /Administrator/);

    for (const path of ['/', '/engagements', '/review-queue', '/settings', '/integrations']) {
      await page.goto(path);
      await expect(page.getByRole('status').filter({ hasText: 'TEST MODE' })).toBeVisible();
    }
  });

  test('reports the mock adapters honestly on the Integrations page', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/integrations');

    await expect(page.getByRole('heading', { name: 'Active adapters' })).toBeVisible();
    // The page must say plainly what is really connected.
    await expect(page.getByText(/mock adapter|blocked \(test mode/i).first()).toBeVisible();

    // The capability matrix distinguishes verified from unverified.
    await expect(page.getByRole('heading', { name: 'Karbon capability matrix' })).toBeVisible();
    await expect(page.getByText('unverified').first()).toBeVisible();
    await expect(page.getByText('unsupported').first()).toBeVisible();
  });

  test('production sending cannot be armed while the environment sets TEST_MODE', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/settings');

    // Exact, because the explanatory paragraph also contains "Test Mode is on".
    await expect(page.getByText('Test Mode is ON', { exact: true })).toBeVisible();

    const armButton = page.getByRole('button', { name: /Arm production sending/i });
    await expect(armButton).toBeDisabled();
    await expect(page.getByText(/environment sets TEST_MODE/i)).toBeVisible();
  });
});

test.describe('templates', () => {
  test('marks the three unsupplied document types as awaiting an approved template', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/templates');

    const table = page.getByRole('table');
    await expect(table).toContainText('t2 engagement letter');
    await expect(table).toContainText('compilation cover letter');

    // Nothing is generated for a document type with no approved template.
    await expect(page.getByText('awaiting approved template').first()).toBeVisible();
    await expect(page.getByText(/will not invent legal wording/i)).toBeVisible();
  });
});

test.describe('role permissions', () => {
  test('a read-only user cannot reach the audit log', async ({ page }) => {
    await signIn(page, /Viewer/);

    const response = await page.request.get('/audit-log');
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('an administrator can read the audit log', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/audit-log');
    await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();
    await expect(page.getByText(/Append-only/i)).toBeVisible();
  });
});

test.describe('preparing an engagement', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test.beforeAll(async ({}, worker) => {
    const environment = environmentFor(worker);
    const id = await firstEngagementId(environment);
    if (id) await resetPreparation(environment, id);
  });

  test('preparing proposes deadlines, blocks the ones it cannot know, and never confirms a service itself', async ({
    page,
  }) => {
    await signIn(page, /Preparer/);
    await page.goto('/engagements');

    const firstEngagement = page.getByRole('table').getByRole('link').first();
    if ((await firstEngagement.count()) === 0) test.skip(true, 'No engagements are seeded in this environment.');
    await firstEngagement.click();

    await page.getByRole('button', { name: 'Prepare', exact: true }).click();
    await expect(page.getByText(/Prepared:/)).toBeVisible();

    // A deadline whose inputs are unknown is blocked, and the question that
    // would unblock it is asked outright rather than assumed.
    await page.getByRole('tab', { name: 'Dates and Deadlines' }).click();
    const datesPanel = page.getByRole('tabpanel');
    await expect(datesPanel).toContainText('three-month balance-due day');
    await expect(datesPanel).toContainText('Not answered');
    await expect(datesPanel).toContainText(/depends on information that has not been confirmed/i);

    await datesPanel.getByRole('radio', { name: 'No', exact: true }).check();
    await page.getByRole('button', { name: /Record answer|Change answer/ }).click();
    await expect(page.getByText(/recalculated/i)).toBeVisible();

    // Last year's tick is a suggestion; this year's answer is a separate act.
    await page.getByRole('tab', { name: 'Services' }).click();
    const servicesPanel = page.getByRole('tabpanel');
    await expect(servicesPanel).toContainText('suggestion');
    await expect(servicesPanel.getByRole('button', { name: 'Include' }).first()).toBeVisible();
    await expect(servicesPanel.getByRole('button', { name: 'Exclude' }).first()).toBeVisible();
  });

  test('a reviewer is told plainly when there is no document to read', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/engagements');

    const firstEngagement = page.getByRole('table').getByRole('link').first();
    if ((await firstEngagement.count()) === 0) test.skip(true, 'No engagements are seeded in this environment.');
    await firstEngagement.click();

    await page.getByRole('tab', { name: 'Document Preview' }).click();
    const panel = page.getByRole('tabpanel');

    const frame = panel.locator('iframe');
    if ((await frame.count()) > 0) {
      // A generated version must be readable in place, not merely described.
      await expect(frame).toHaveAttribute('src', /\/api\/documents\/.*signature=/);
      await expect(panel.getByRole('link', { name: /Open PDF/ })).toBeVisible();
    } else {
      await expect(panel).toContainText(/No document has been generated yet|cannot read/i);
    }
  });
});

test.describe('filling in the structured fields', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test.beforeAll(async ({}, worker) => {
    const environment = environmentFor(worker);
    const id = await firstEngagementId(environment);
    if (id) await resetPreparation(environment, id);
  });

  test('offers a labelled form built from the template, and refuses a value that is not valid', async ({ page }) => {
    await signIn(page, /Preparer/);
    await page.goto('/engagements');

    const firstEngagement = page.getByRole('table').getByRole('link').first();
    if ((await firstEngagement.count()) === 0) test.skip(true, 'No engagements are seeded in this environment.');
    await firstEngagement.click();

    await page.getByRole('tab', { name: 'Client Information' }).click();
    const panel = page.getByRole('tabpanel');

    // Labelled and grouped, not a box asking for a raw token.
    await expect(panel.getByRole('heading', { name: 'Client', exact: true })).toBeVisible();
    await expect(panel.getByText(/required field\(s\) have no value yet/)).toBeVisible();

    const legalName = panel.getByLabel('Corporation legal name');
    await expect(legalName).toBeVisible();
    // The bracketed text from the approved letter, so the field is recognisable.
    await expect(panel.getByText('Fills [LEGAL NAME OF CORPORATION] in the approved letter.')).toBeVisible();

    await legalName.fill('Northwind Sample Holdings Ltd.');
    await panel.getByRole('button', { name: 'Save client' }).click();
    await expect(page.getByText(/Saved 1 value/)).toBeVisible();

    // Reloading proves it was stored rather than only shown.
    await page.reload();
    await page.getByRole('tab', { name: 'Client Information' }).click();
    await expect(page.getByLabel('Corporation legal name')).toHaveValue('Northwind Sample Holdings Ltd.');

    // A value that fails its own definition is reported, not stored. This one
    // gets past the browser's own email check, so it exercises the server rule
    // rather than the input type.
    const signers = page.getByRole('tabpanel');
    await signers.getByLabel('Signing officer email address').fill('officer@example');
    await signers.getByRole('button', { name: 'Save signers' }).click();
    await expect(page.getByText(/must be an email address/)).toBeVisible();
  });

  test('shows a fee as read-only, because the pricing engine decides it', async ({ page }) => {
    await signIn(page, /Preparer/);
    await page.goto('/engagements');

    const firstEngagement = page.getByRole('table').getByRole('link').first();
    if ((await firstEngagement.count()) === 0) test.skip(true, 'No engagements are seeded in this environment.');
    await firstEngagement.click();

    await page.getByRole('tab', { name: 'Client Information' }).click();
    const fee = page.getByRole('tabpanel').getByLabel('T2 preparation fee');

    await expect(fee).toHaveAttribute('readonly', '');
    await expect(page.getByRole('tabpanel').getByText(/Set by the pricing engine/).first()).toBeVisible();
  });
});

test.describe('reading the document under review', () => {
  // Skipped against an external server, where this process cannot put a file
  // where that server would look for it.
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the storage directory this run manages.');

  let engagementId: string | null = null;
  let versionId: string | null = null;

  test.beforeAll(async ({}, worker) => {
    const fixture = await seedPreviewableVersion(environmentFor(worker));
    engagementId = fixture?.engagementId ?? null;
    versionId = fixture?.versionId ?? null;
  });

  test.afterAll(async ({}, worker) => {
    if (versionId) await deleteVersion(environmentFor(worker), versionId);
  });

  test('the approved PDF is embedded, downloadable, and refuses a tampered link', async ({ page, request }) => {
    if (!engagementId) test.skip(true, 'No engagement is seeded in this environment.');

    await signIn(page, /Reviewer/);
    await page.goto(`/engagements/${engagementId}`);
    await page.getByRole('tab', { name: 'Document Preview' }).click();

    const panel = page.getByRole('tabpanel');
    const frame = panel.locator('iframe');
    await expect(frame).toBeVisible();

    const source = await frame.getAttribute('src');
    expect(source).toMatch(/^\/api\/documents\/.+expires=\d+&signature=[A-Za-z0-9_-]+$/);

    // The framed response must itself permit being framed by this origin —
    // a blanket X-Frame-Options: DENY would leave a blank panel.
    const embedded = await page.request.get(source as string);
    expect(embedded.status()).toBe(200);
    expect(embedded.headers()['content-type']).toBe('application/pdf');
    expect(embedded.headers()['content-disposition']).toMatch(/^inline/);
    expect(embedded.headers()['x-frame-options']).toBe('SAMEORIGIN');
    expect(embedded.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(embedded.headers()['cache-control']).toContain('no-store');

    await expect(panel.getByRole('link', { name: /Open PDF in a new tab/ })).toBeVisible();

    // A link is only as good as its signature.
    const tampered = (source as string).replace(/signature=[A-Za-z0-9_-]+/, `signature=${'A'.repeat(43)}`);
    expect((await page.request.get(tampered)).status()).toBe(403);

    // Both checks are independent: `request` carries no session, so even the
    // genuine link is refused. A forwarded URL is useless to an outsider.
    expect((await request.get(source as string)).status()).toBe(401);
  });
});

test.describe('accessibility basics', () => {
  test('every page is reachable by keyboard and has one main landmark', async ({ page }) => {
    await signIn(page, /Reviewer/);

    for (const path of ['/', '/engagements', '/review-queue', '/cover-letters']) {
      await page.goto(path);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

      // The skip link is the first thing a keyboard user reaches.
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    }
  });

  test('the review workspace tabs are correctly wired for screen readers', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/engagements');

    const firstEngagement = page.getByRole('table').getByRole('link').first();
    if ((await firstEngagement.count()) === 0) test.skip(true, 'No engagements are seeded in this environment.');

    await firstEngagement.click();

    const tablist = page.getByRole('tablist', { name: 'Engagement review' });
    await expect(tablist).toBeVisible();

    const overview = page.getByRole('tab', { name: 'Overview' });
    await expect(overview).toHaveAttribute('aria-selected', 'true');

    const pricing = page.getByRole('tab', { name: 'Pricing' });
    await pricing.click();
    await expect(pricing).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toContainText(/rounded upward to the next \$5|Fee derivation/i);
  });
});

test.describe('health endpoints', () => {
  test('liveness and readiness both respond', async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBe(true);
    expect((await health.json()).status).toBe('ok');

    const ready = await request.get('/api/ready');
    expect(ready.ok()).toBe(true);

    const readyBody = await ready.json();
    expect(readyBody.database).toBe('ok');
    expect(readyBody.testMode).toBe(true);
  });
});

test.describe('webhooks', () => {
  test('an Adobe payload with a bad signature is rejected', async ({ request }) => {
    const response = await request.post('/api/webhooks/adobe-sign', {
      data: { eventId: 'forged', event: 'AGREEMENT_WORKFLOW_COMPLETED', agreementId: 'x' },
      headers: { 'x-adobe-signature': 'invalid' },
    });

    expect(response.status()).toBe(400);
  });

  test('the Adobe verification handshake echoes the client id', async ({ request }) => {
    const response = await request.get('/api/webhooks/adobe-sign', {
      headers: { 'x-adobesign-clientid': 'test-client-id' },
    });

    expect(response.ok()).toBe(true);
    expect((await response.json()).xAdobeSignClientId).toBe('test-client-id');
  });
});
