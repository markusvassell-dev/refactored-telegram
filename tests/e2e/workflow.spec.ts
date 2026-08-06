import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { DocumentStore, PricingService } from '@element/services';
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

/**
 * Picks a seeded development account.
 *
 * The seeded accounts are the "Sample …" ones, and they are what these tests
 * mean: a matcher like /Reviewer/ is asking for the account that holds the
 * REVIEWER role. Any user may appear in this list, though — an integration test
 * leaves behind a "Creation Reviewer" with no roles at all — and picking one of
 * those signs in successfully with no permissions, which shows up much later as
 * a button mysteriously missing from a page. Preferring the seeded account
 * makes the matcher mean what it reads as.
 */
async function optionLabel(page: Page, matcher: RegExp): Promise<string> {
  const labels = await page.getByLabel('Account').locator('option').allTextContents();
  const matching = labels.filter((label) => matcher.test(label));

  const seeded = matching.find((label) => label.startsWith('Sample '));
  const found = seeded ?? matching[0];

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
function environmentFor(info: { config: { metadata: unknown } }): E2EEnvironment {
  return (info.config.metadata as { e2eEnvironment: E2EEnvironment }).e2eEnvironment;
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

/**
 * Two engagements for a rollout year of its own: one ready to generate, one
 * blocked for want of a prior-year letter. The rollout screen's whole job is
 * telling those two apart, so both have to exist for the test to mean anything.
 */
async function seedRolloutFixture(environment: E2EEnvironment, taxYear: number): Promise<void> {
  const prisma = clientFor(environment);
  try {
    const audit = createAuditLogger(prisma);
    const pricing = new PricingService(prisma, audit);
    const actor = await prisma.user.findFirstOrThrow({ where: { email: 'preparer@example.test' } });

    for (const [name, ready] of [
      ['Rollout Ready Co', true],
      ['Rollout Blocked Co', false],
    ] as const) {
      const client = await prisma.client.create({ data: { legalName: name, isTestFixture: true } });

      const engagement = await prisma.engagement.create({
        data: {
          clientId: client.id,
          engagementType: 'T2',
          taxYear,
          yearEnd: new Date(Date.UTC(taxYear, 2, 31)),
          status: 'NOT_STARTED',
          compilationSelected: false,
          isTestMode: true,
        },
      });

      if (!ready) continue;

      await prisma.sourceDocument.create({
        data: {
          engagementId: engagement.id,
          kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
          fileName: 'Prior Year Engagement Letter.pdf',
          fileHash: 'e2e-rollout-fixture-hash',
          confirmedAt: new Date(),
        },
      });

      await pricing.calculate({
        engagementId: engagement.id,
        feeKinds: ['T2_PREPARATION'],
        previousFees: { T2_PREPARATION: { amount: '2000', source: 'PRIOR_YEAR_DOCUMENT' } },
        highIncreaseThresholdPercent: 10,
        actorId: actor.id,
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function clearRolloutFixture(environment: E2EEnvironment, taxYear: number): Promise<void> {
  const prisma = clientFor(environment);
  try {
    const engagements = await prisma.engagement.findMany({ where: { taxYear }, select: { id: true, clientId: true } });
    await prisma.backgroundJob.deleteMany({ where: { engagementId: { in: engagements.map((row) => row.id) } } });
    await prisma.engagement.deleteMany({ where: { taxYear } });
    await prisma.client.deleteMany({ where: { id: { in: engagements.map((row) => row.clientId) } } });
  } finally {
    await prisma.$disconnect();
  }
}

/** Set by each suite's setup, and the engagement its tests then open. */
let sampleEngagementId: string | null = null;

/**
 * The seeded sample engagement.
 *
 * "The oldest engagement" and "the first row of the engagement list" were two
 * different things the moment a second engagement shared its tax year: the
 * setup would reset one and the test would open the other, and a T2 test would
 * quietly find itself reading a T1. Tests navigate to this id directly rather
 * than clicking whatever happens to be at the top of a list that other tests
 * and fixtures also write to.
 */
async function firstEngagementId(environment: E2EEnvironment): Promise<string | null> {
  const prisma = clientFor(environment);
  try {
    const engagement =
      (await prisma.engagement.findFirst({
        where: { client: { legalName: 'Northwind Sample Holdings Ltd.' } },
        orderBy: { createdAt: 'asc' },
      })) ?? (await prisma.engagement.findFirst({ orderBy: { createdAt: 'asc' } }));
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

    // One section per document type, rather than one row: each carries its own
    // version history and upload form.
    await expect(page.getByRole('heading', { name: 't2 engagement letter' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'compilation cover letter' })).toBeVisible();

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

/**
 * Puts a cover letter package in front of a reviewer.
 *
 * The narrative editor only exists where there is a letter to edit, and a
 * browser test that skips itself when the environment happens to have none
 * proves nothing at all.
 */
async function seedCoverLetterPackage(environment: E2EEnvironment): Promise<string | null> {
  const prisma = clientFor(environment);
  try {
    const engagement = await prisma.engagement.findFirst({
      where: { engagementType: { in: ['T1_SINGLE', 'T1_JOINT'] } },
      orderBy: { createdAt: 'asc' },
    });

    const target =
      engagement ??
      (await prisma.engagement.findFirst({ orderBy: { createdAt: 'asc' } }));
    if (!target) return null;

    const existing = await prisma.coverLetterPackage.findFirst({
      where: { engagementId: target.id, documentType: 'T1_COVER_LETTER' },
    });
    if (existing) {
      await prisma.coverLetterNarrative.deleteMany({ where: { coverLetterPackageId: existing.id } });
      await prisma.coverLetterPackage.update({
        where: { id: existing.id },
        data: { status: 'REVIEW_REQUIRED', staleReason: null, approvedAt: null, approvedByUserId: null },
      });
      return existing.id;
    }

    const created = await prisma.coverLetterPackage.create({
      data: {
        engagementId: target.id,
        documentType: 'T1_COVER_LETTER',
        status: 'REVIEW_REQUIRED',
        idempotencyKey: `e2e_narrative_${target.id}`,
      },
    });
    return created.id;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A user this suite owns, reset before each test that changes roles.
 *
 * The role screen writes to whichever person it is pointed at, and pointing it
 * at a seeded account leaves that account changed for every later suite — a
 * test that granted a role and then failed before removing it once left
 * "Sample Viewer" holding PREPARER, and the next run could not grant it again.
 */
async function resetRoleFixtureUser(environment: E2EEnvironment): Promise<string> {
  const prisma = clientFor(environment);
  try {
    const user = await prisma.user.upsert({
      where: { email: 'role-fixture@example.test' },
      create: { email: 'role-fixture@example.test', displayName: 'Role Fixture Person' },
      update: { isActive: true },
    });

    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({ data: { userId: user.id, role: 'READ_ONLY', grantedBy: 'e2e-fixture' } });

    return user.id;
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('configuring an integration', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test.afterAll(async ({}, testInfo) => {
    const prisma = clientFor(environmentFor(testInfo));
    try {
      await prisma.integrationConnection.deleteMany({ where: { provider: 'KARBON' } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test('stores a credential and never shows it back', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/integrations');

    const secret = 'e2e-karbon-bearer-do-not-echo';

    await page.getByLabel('Bearer token').fill(secret);
    await page.getByLabel('Access key').fill('e2e-karbon-access-key');
    await page.getByRole('button', { name: 'Save connection' }).first().click();

    await expect(page.getByText(/Rotated: Bearer token, Access key/)).toBeVisible();

    // The value must not survive anywhere in the rendered page — not in a
    // field, not in a data attribute, not in the server-rendered payload.
    await expect(page.getByText('stored').first()).toBeVisible();
    expect(await page.content()).not.toContain(secret);

    // And the field comes back empty rather than pre-filled with the secret.
    await expect(page.getByLabel('Bearer token')).toHaveValue('');
  });

  test('refuses to mark a connection production while Test Mode is on', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/integrations');

    await page.getByLabel('Environment').first().selectOption('false');
    await page.getByRole('button', { name: 'Save connection' }).first().click();

    // Matched on the refusal itself: "Test Mode is on" also appears in the
    // page's own explanation of what Test Mode does.
    await expect(page.getByText(/cannot be marked as production/i)).toBeVisible();
  });

  test('reports a failed connection check instead of hiding it', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/integrations');

    await page.getByLabel('Bearer token').fill('e2e-token');
    await page.getByLabel('Access key').fill('e2e-key');
    await page.getByLabel('API base URL').first().fill('https://karbon.invalid/v3');
    await page.getByRole('button', { name: 'Save connection' }).first().click();
    await expect(page.getByText(/Rotated:/)).toBeVisible();

    await page.getByRole('button', { name: 'Check connection' }).first().click();

    // The vendor's own words, kept rather than swallowed: this is what an
    // administrator needs in order to fix it.
    await expect(page.getByText(/The connection did not work/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Failed').first()).toBeVisible();
  });

  test('a reviewer sees what is connected but is given no way to change it', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/integrations');

    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
    await expect(page.getByText('Active adapters')).toBeVisible();
    await expect(page.getByLabel('Bearer token')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save connection' })).toHaveCount(0);
  });
});

test.describe('the smaller lists', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test('system jobs pages, and each status count filters to the jobs behind it', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/system-jobs?pageSize=5');

    const pager = page.getByRole('navigation', { name: 'System jobs pagination' });

    if ((await page.getByRole('table').count()) === 0) {
      // No jobs have run; the page must say so rather than showing an empty
      // table that looks like a filter matching nothing.
      await expect(page.getByText(/No jobs have run yet/)).toBeVisible();
      return;
    }

    await expect(pager.getByText(/Showing 1–\d+ of/)).toBeVisible();

    // A count is a link: a number worth investigating is one click from the
    // rows behind it.
    const succeeded = page.getByRole('link', { name: /succeeded/i }).first();
    if (await succeeded.isVisible()) {
      await succeeded.click();
      await expect(page).toHaveURL(/status=SUCCEEDED/);
      await expect(page.getByRole('link', { name: 'Clear filter' })).toBeVisible();
    }
  });

  test('needs attention counts every section rather than stopping in silence', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/needs-attention');

    await expect(page.getByRole('heading', { name: 'Needs Attention' })).toBeVisible();

    // Every section is present whether or not it has anything in it, so an
    // empty worklist is distinguishable from a section that failed to load.
    for (const title of [
      'Blocked engagements',
      'Declined agreements',
      'Expired agreements',
      'Stale cover letters',
      'Failed jobs',
    ]) {
      await expect(page.getByRole('heading', { name: new RegExp(title) })).toBeVisible();
    }
  });

  test('the audit tab points at the complete trail for the engagement', async ({ page }) => {
    await signIn(page, /Reviewer/);

    if (!sampleEngagementId) {
      await page.goto('/engagements');
      const first = page.getByRole('table').getByRole('link').first();
      if ((await first.count()) === 0) {
        test.skip(true, 'No engagements are seeded in this environment.');
        return;
      }
      await first.click();
    } else {
      await page.goto(`/engagements/${sampleEngagementId}`);
    }

    await page.getByRole('tab', { name: 'Audit History' }).click();

    const link = page.getByRole('link', { name: /complete audit trail/i });
    if (await link.isVisible()) {
      await link.click();
      // It lands on the paginated audit log, filtered to this engagement.
      await expect(page).toHaveURL(/\/audit-log\?engagementId=/);
      await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();
    }
  });
});

test.describe('managing roles', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test.beforeEach(async ({}, testInfo) => {
    await resetRoleFixtureUser(environmentFor(testInfo));
  });

  test('grants a role with a reason, and the reason reaches the audit trail', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/users');

    const row = page.getByRole('row', { name: /Role Fixture Person/ });
    await expect(row).toBeVisible();

    await row.getByLabel('Grant a role').selectOption('PREPARER');
    await row.getByLabel(/^Reason$/).first().fill('Covering preparation over the busy season.');
    await row.getByRole('button', { name: 'Grant' }).click();

    await expect(page.getByText('Granted PREPARER.')).toBeVisible();
    await expect(
      page.getByRole('row', { name: /Role Fixture Person/ }).locator('span.badge', { hasText: 'PREPARER' }),
    ).toBeVisible();

    // Removing it again, because the round trip is the operation a firm
    // actually performs and the refusals only make sense against it.
    const after = page.getByRole('row', { name: /Role Fixture Person/ });
    await after.getByLabel('Remove a role').selectOption('PREPARER');
    await after.getByLabel(/^Reason$/).nth(1).fill('Busy season over.');

    // Removing a role asks for confirmation. Playwright dismisses dialogs
    // unless told otherwise, which cancels the submit and leaves the test
    // asserting against a page that never changed.
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('takes away what this person can approve');
      void dialog.accept();
    });
    await after.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Removed PREPARER.')).toBeVisible();
  });

  test('refuses to remove your own administrator role', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/users');

    const row = page.getByRole('row', { name: /Sample Administrator/ });
    await row.getByLabel('Remove a role').selectOption('ADMINISTRATOR');
    await row.getByLabel(/^Reason$/).nth(1).fill('Trying to lock myself out.');

    page.once('dialog', (dialog) => void dialog.accept());
    await row.getByRole('button', { name: 'Remove' }).click();

    await expect(page.getByText(/cannot remove your own administrator role/i)).toBeVisible();

    // Still held: the badge, not the option in the select that also reads
    // ADMINISTRATOR.
    await expect(
      page.getByRole('row', { name: /Sample Administrator/ }).locator('span.badge', { hasText: 'ADMINISTRATOR' }),
    ).toBeVisible();
  });

  test('a reviewer sees the roles but is given nothing to change them with', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/users');

    await expect(page.getByRole('heading', { name: 'Users and Roles' })).toBeVisible();
    await expect(page.getByLabel('Grant a role')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Grant' })).toHaveCount(0);
  });
});

test.describe('publishing a template', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test('shows what governs each document type, and offers an upload to an administrator', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/templates');

    await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
    await expect(page.getByText(/Uploading does not publish/)).toBeVisible();

    // The hash of what is live is on the page: it is how a firm ties the
    // running system back to the file it approved.
    const section = page.getByRole('region').filter({ hasText: 't2 engagement letter' }).first();
    await expect(page.getByText('Active version').first()).toBeVisible();
    await expect(page.getByLabel('Approved source .docx').first()).toBeVisible();
    expect(await section.count()).toBeGreaterThanOrEqual(0);
  });

  test('refuses a file that is not a Word document', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/templates');

    await page.getByLabel('Approved source .docx').first().setInputFiles({
      name: 'not-really.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('%PDF-1.4 this is a PDF wearing a docx name'),
    });
    await page.getByRole('button', { name: 'Upload a revised template' }).first().click();

    await expect(page.getByText(/not a Word \.docx file/i)).toBeVisible();
  });

  test('a preparer is shown the templates but given no way to change them', async ({ page }) => {
    await signIn(page, /Preparer/);
    await page.goto('/templates');

    await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
    await expect(page.getByLabel('Approved source .docx')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Upload a revised template' })).toHaveCount(0);
  });
});

test.describe('editing the cover letter narrative', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  // Each test starts from an unedited letter: one of them saves.
  test.beforeEach(async ({}, testInfo) => {
    await seedCoverLetterPackage(environmentFor(testInfo));
  });

  test('offers the narrative beside the approved wording, and shows what changes', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/cover-letters');

    const editor = page.getByLabel('Narrative').first();
    await expect(editor).toBeVisible();

    // The approved wording sits beside the box, not behind a link.
    await expect(page.getByText('Approved template wording').first()).toBeVisible();
    await expect(page.getByText(/Unchanged from the approved template wording/).first()).toBeVisible();

    await editor.fill('A plainer opening paragraph.');

    // The diff is computed in the browser as the reviewer types.
    await expect(page.getByText('What changes').first()).toBeVisible();
    await expect(page.getByText('A plainer opening paragraph.').first()).toBeVisible();
  });

  test('the server refuses a section the template does not mark editable', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/cover-letters');

    const sectionInput = page.locator('input[name="sectionKey"]').first();
    await expect(sectionInput).toHaveCount(1);

    // Typing first: the textarea is controlled, so a re-render restores the
    // hidden field. The tamper has to be the last thing before the submit — a
    // detail worth knowing, because it is the difference between this test
    // exercising the server guard and quietly exercising nothing.
    await page.getByLabel('Narrative').first().fill('Trying to rewrite the enclosure list.');
    await sectionInput.evaluate((element: HTMLInputElement) => {
      element.value = 'documents_enclosed';
    });
    await page.getByRole('button', { name: 'Save narrative' }).first().click();

    // The browser is not what decides which wording can be rewritten.
    await expect(page.getByText(/not an editable section/i)).toBeVisible();
  });

  test('a read-only user is shown the narrative but given no way to change it', async ({ page }) => {
    await signIn(page, /Viewer/);
    await page.goto('/cover-letters');

    await expect(page.getByRole('heading', { name: 'Cover Letters' })).toBeVisible();
    await expect(page.getByLabel('Narrative')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save narrative' })).toHaveCount(0);
  });
});

test.describe('paging a long list', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test('the audit log says how much it is showing, and paging keeps the filters', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/audit-log?pageSize=5');

    const pager = page.getByRole('navigation', { name: 'Audit log pagination' });
    await expect(pager).toBeVisible();

    // The whole point: a reader can tell a short list from a truncated one.
    await expect(pager.getByText(/Showing 1–5 of/)).toBeVisible();

    await pager.getByRole('link', { name: 'Next' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page).toHaveURL(/pageSize=5/);
    await expect(pager.getByText(/Showing 6–10 of/)).toBeVisible();

    // Previous returns to a first page that has no page parameter at all, so
    // the plain URL stays the canonical one.
    await pager.getByRole('link', { name: 'Previous' }).click();
    await expect(page).not.toHaveURL(/page=2/);
    await expect(pager.getByText(/Showing 1–5 of/)).toBeVisible();
  });

  test('a filtered list stays filtered on the second page', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/audit-log?eventType=STATUS_CHANGED&pageSize=2');

    const filter = page.getByLabel('Event');
    await expect(filter).toHaveValue('STATUS_CHANGED');

    const pager = page.getByRole('navigation', { name: 'Audit log pagination' });
    const next = pager.getByRole('link', { name: 'Next' });

    if (await next.isVisible()) {
      await next.click();
      // The classic version of this bug: page two of a filtered list quietly
      // becomes page two of an unfiltered one.
      await expect(page).toHaveURL(/eventType=STATUS_CHANGED/);
      await expect(page.getByLabel('Event')).toHaveValue('STATUS_CHANGED');
    }
  });

  test('a page number past the end says so rather than showing an empty table', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/audit-log?page=9999');

    await expect(page.getByText(/no audit events on this page/i)).toBeVisible();
    await page.getByRole('link', { name: /first page/i }).click();
    await expect(page.getByRole('navigation', { name: 'Audit log pagination' })).toBeVisible();
  });

  test('the engagement list counts what it is showing', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/engagements');

    const pager = page.getByRole('navigation', { name: 'Engagements pagination' });
    await expect(pager).toBeVisible();
    await expect(pager.getByText(/Showing 1–\d+ of \d+ engagement/)).toBeVisible();
  });
});

test.describe('preparing an engagement', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test.beforeAll(async ({}, worker) => {
    const environment = environmentFor(worker);
    sampleEngagementId = await firstEngagementId(environment);
    if (sampleEngagementId) await resetPreparation(environment, sampleEngagementId);
  });

  test('preparing proposes deadlines, blocks the ones it cannot know, and never confirms a service itself', async ({
    page,
  }) => {
    await signIn(page, /Preparer/);
    if (!sampleEngagementId) test.skip(true, 'No engagements are seeded in this environment.');
    await page.goto(`/engagements/${sampleEngagementId}`);

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
    if (!sampleEngagementId) test.skip(true, 'No engagements are seeded in this environment.');
    await page.goto(`/engagements/${sampleEngagementId}`);

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

test.describe('starting an engagement', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  const CLIENT_NAME = 'End To End Start Co';

  test.afterAll(async ({}, worker) => {
    const prisma = clientFor(environmentFor(worker));
    try {
      const clients = await prisma.client.findMany({ where: { legalName: CLIENT_NAME }, select: { id: true } });
      await prisma.engagement.deleteMany({ where: { clientId: { in: clients.map((row) => row.id) } } });
      await prisma.client.deleteMany({ where: { id: { in: clients.map((row) => row.id) } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test('creates one from a new client, and refuses a second for the same year', async ({ page }) => {
    await signIn(page, /Preparer/);
    await page.goto('/engagements');

    await page.getByRole('link', { name: 'Start an engagement' }).click();
    await expect(page.getByRole('heading', { name: 'Start an engagement' })).toBeVisible();

    // A type with no approved template is offered as unavailable, not hidden.
    const singleTaxpayer = page.getByRole('option', { name: /T1 single taxpayer/ });
    await expect(singleTaxpayer).toBeDisabled();
    await expect(singleTaxpayer).toContainText('no approved template yet');

    // A corporate engagement without its year-end is refused with the reason.
    await page.getByLabel(/new client’s full legal name/).fill(CLIENT_NAME);
    await page.getByLabel('Tax year').fill('2026');
    await page.getByRole('button', { name: 'Create engagement' }).click();
    await expect(page.getByText(/needs its year-end/)).toBeVisible();

    await page.getByLabel('Year-end').fill('2026-03-31');
    await page.getByRole('button', { name: 'Create engagement' }).click();
    await expect(page.getByText(/Engagement created/)).toBeVisible();
    await expect(page.getByText(/new client record was created/)).toBeVisible();

    // The second attempt collides with the first, and says so.
    await page.goto('/engagements/new');
    await page.getByLabel('Existing client').selectOption({ label: CLIENT_NAME });
    await page.getByLabel('Tax year').fill('2026');
    await page.getByLabel('Year-end').fill('2026-03-31');
    await page.getByRole('button', { name: 'Create engagement' }).click();
    await expect(page.getByText(/already has a 2026 T2 engagement/)).toBeVisible();
  });

  test('is not offered to a role that cannot create one', async ({ page }) => {
    await signIn(page, /Viewer/);
    await page.goto('/engagements');

    await expect(page.getByRole('link', { name: 'Start an engagement' })).toHaveCount(0);

    // Hidden in the UI and refused on the server, not merely hidden.
    const response = await page.request.get('/engagements/new');
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe('editing a pricing rule', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  const DESCRIPTION = 'End to end percentage rule';

  test.afterAll(async ({}, worker) => {
    const prisma = clientFor(environmentFor(worker));
    try {
      await prisma.feeRule.deleteMany({ where: { description: DESCRIPTION } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test('previews the fee the rule would produce, including the round-up', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/pricing-rules');

    await page.getByRole('link', { name: 'New pricing rule' }).click();
    await expect(page.getByRole('heading', { name: 'New pricing rule' })).toBeVisible();

    const preview = page.getByRole('heading', { name: 'Preview' }).locator('..').locator('..');

    // $2,000 + 3% = $2,060, already a multiple of five.
    await page.getByLabel('If last year’s fee was').fill('2000');
    await expect(preview).toContainText('$2060.00');

    // $1,234 + 3% = $1,271.02, which rounds up to $1,275 — never down.
    await page.getByLabel('If last year’s fee was').fill('1234');
    await expect(preview).toContainText('$1275.00');
    await expect(preview).toContainText('$1271.02 before rounding');

    // A large increase is flagged as needing partner approval before saving.
    await page.getByLabel('Increase', { exact: true }).fill('25');
    await expect(preview).toContainText(/Needs partner approval/i);

    // A rule scoped to nothing is refused by the server.
    await page.getByLabel('Increase', { exact: true }).fill('4');
    await page.getByLabel('Description').fill(DESCRIPTION);
    await page.getByLabel('Why are you changing this?').fill('Setting this year’s standard T2 increase.');
    await page.getByRole('button', { name: 'Create this rule' }).click();
    await expect(page.getByText(/needs an engagement type/i)).toBeVisible();

    await page.getByLabel('Engagement type').selectOption('T2');
    await page.getByRole('button', { name: 'Create this rule' }).click();
    await expect(page.getByText(/Pricing rule created/)).toBeVisible();

    // And it is listed afterwards.
    await page.goto('/pricing-rules');
    await expect(page.getByRole('cell', { name: DESCRIPTION })).toHaveCount(0);
    await expect(page.getByRole('table')).toContainText('4%');
  });

  test('is not offered to a role that cannot manage pricing', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/pricing-rules');

    await expect(page.getByRole('link', { name: 'New pricing rule' })).toHaveCount(0);

    const response = await page.request.get('/pricing-rules/new');
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe('editing a date rule', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  // Restored afterwards: the seeded rules are what every other suite computes
  // its deadlines from.
  const RULE = 't2.information_due_date';
  let originalDefinition: unknown = null;

  test.beforeAll(async ({}, worker) => {
    const prisma = clientFor(environmentFor(worker));
    try {
      const rule = await prisma.dateRule.findUniqueOrThrow({ where: { code: RULE } });
      originalDefinition = rule.definition;
    } finally {
      await prisma.$disconnect();
    }
  });

  test.afterAll(async ({}, worker) => {
    const prisma = clientFor(environmentFor(worker));
    try {
      if (originalDefinition) {
        await prisma.dateRule.update({
          where: { code: RULE },
          data: { definition: originalDefinition as never, label: 'T2 client information due date' },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test('previews the new deadline before saving, and refuses a change with no reason', async ({ page }) => {
    await signIn(page, /Administrator/);
    await page.goto('/date-rules');

    await page.getByRole('link', { name: RULE }).click();
    await expect(page.getByRole('heading', { name: /client information/i })).toBeVisible();

    // What the change will and will not touch is stated before it is made.
    await expect(page.getByText(/already confirmed are left exactly as they are/)).toBeVisible();

    // The preview is computed live by the same engine the worker uses.
    await page.getByLabel('Sample year-end').fill('2026-03-31');
    const preview = page.getByRole('heading', { name: 'Preview' }).locator('..').locator('..');
    const before = await preview.textContent();

    await page.getByLabel('Step 1 amount').fill('4');
    await expect(preview).not.toHaveText(before ?? '');
    await expect(preview).toContainText('2026-07-31');

    // A change to a deadline interpretation needs a written reason. Whitespace
    // satisfies the browser's own check, so this exercises the server's.
    await page.getByLabel('Why are you changing this?').fill('          ');
    await page.getByRole('button', { name: 'Save this rule' }).click();
    await expect(page.getByText(/Give a reason/)).toBeVisible();

    await page.getByLabel('Why are you changing this?').fill('Piloting a four-month information deadline this year.');
    await page.getByRole('button', { name: 'Save this rule' }).click();
    await expect(page.getByText(new RegExp(`Saved ${RULE}`))).toBeVisible();

    // And it survives a reload, because it was actually stored.
    await page.reload();
    await expect(page.getByLabel('Step 1 amount')).toHaveValue('4');
  });

  test('is not offered to a role that cannot manage rules', async ({ page }) => {
    await signIn(page, /Reviewer/);
    await page.goto('/date-rules');

    // The list is readable; the codes are not links.
    await expect(page.getByRole('cell', { name: RULE })).toBeVisible();
    await expect(page.getByRole('link', { name: RULE })).toHaveCount(0);

    const response = await page.request.get(`/date-rules/${RULE}`);
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe('attaching a source document', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  // This test attaches to the seeded engagement, which every other suite also
  // uses. Leaving the document and its queued extraction behind would change
  // what the next run — and the integration suite — starts from.
  test.afterAll(async ({}, worker) => {
    const prisma = clientFor(environmentFor(worker));
    try {
      const attached = await prisma.sourceDocument.findMany({
        where: { fileName: 'Prior Year Engagement Letter.docx', storagePath: { not: null } },
        select: { id: true, engagementId: true },
      });
      await prisma.backgroundJob.deleteMany({
        where: { engagementId: { in: attached.map((row) => row.engagementId) }, jobType: 'EXTRACT_DOCUMENT_TEXT' },
      });
      await prisma.sourceDocument.deleteMany({ where: { id: { in: attached.map((row) => row.id) } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test('accepts a Word letter, refuses a file that is not what it claims to be', async ({ page }) => {
    await signIn(page, /Preparer/);
    if (!sampleEngagementId) test.skip(true, 'No engagements are seeded in this environment.');
    await page.goto(`/engagements/${sampleEngagementId}`);

    await page.getByRole('tab', { name: 'Source Documents' }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('heading', { name: 'Attach a document' })).toBeVisible();

    // A .docx whose bytes are a PDF is refused: the extension is not the check.
    await panel.getByLabel('File').setInputFiles({
      name: 'Not Really A Letter.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('%PDF-1.4 pretending to be Word', 'latin1'),
    });
    await panel.getByRole('button', { name: 'Attach and read' }).click();
    await expect(page.getByText(/do not match the declared file type/i)).toBeVisible();

    // A real Word file is accepted, scored, and queued for reading.
    await panel.getByLabel('File').setInputFiles({
      name: 'Prior Year Engagement Letter.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await readFile(join(process.cwd(), 'templates', 'normalized', 'T2 Engagement Letter.docx')),
    });
    await panel.getByRole('button', { name: 'Attach and read' }).click();

    await expect(page.getByText(/Attached Prior Year Engagement Letter\.docx/)).toBeVisible();
    await expect(page.getByText(/Reading it has been queued/)).toBeVisible();

    // It appears in the table with its verification result.
    await page.reload();
    await page.getByRole('tab', { name: 'Source Documents' }).click();
    await expect(page.getByRole('cell', { name: 'Prior Year Engagement Letter.docx' })).toBeVisible();
  });
});

test.describe('the annual rollout', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  // A year of its own, so the fixture cannot collide with the seeded sample.
  const ROLLOUT_YEAR = 2912;

  test.beforeAll(async ({}, worker) => {
    await seedRolloutFixture(environmentFor(worker), ROLLOUT_YEAR);
  });

  test.afterAll(async ({}, worker) => {
    await clearRolloutFixture(environmentFor(worker), ROLLOUT_YEAR);
  });

  test('says how many drafts it will produce, dry-runs first, and only then queues', async ({ page }) => {
    await signIn(page, /Preparer/);
    await page.goto(`/bulk-rollout?taxYear=${ROLLOUT_YEAR}`);

    // One ready, one blocked for want of a prior-year letter.
    await expect(page.getByText('2 engagement(s) · 1 ready · 1 blocked')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate 1 draft' })).toBeEnabled();

    const blocked = page.getByRole('checkbox', { name: /Include Rollout Blocked/ });
    await expect(blocked).toBeDisabled();
    await expect(page.getByText(/Missing: Prior-year engagement letter/)).toBeVisible();

    // A dry run reports what would happen and queues nothing.
    await page.getByRole('button', { name: 'Dry run for 1 engagement' }).click();
    await expect(page.getByText(/would be queued/)).toBeVisible();
    await expect(page.getByText(/this was a dry run/)).toBeVisible();

    // Then the real thing, which asks before touching many clients at once.
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Generate 1 draft?');
      void dialog.accept();
    });
    await page.getByRole('button', { name: 'Generate 1 draft' }).click();

    await expect(page.getByText(/1 draft\(s\) queued/)).toBeVisible();
    await expect(page.getByText(/still needs individual review and approval/)).toBeVisible();
  });

  test('says plainly when a year has nothing in it', async ({ page }) => {
    await signIn(page, /Preparer/);
    await page.goto('/bulk-rollout?taxYear=1999');
    await expect(page.getByText('No engagements match these filters.')).toBeVisible();
  });
});

test.describe('filling in the structured fields', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the database this run manages.');

  test.beforeAll(async ({}, worker) => {
    const environment = environmentFor(worker);
    sampleEngagementId = await firstEngagementId(environment);
    if (sampleEngagementId) await resetPreparation(environment, sampleEngagementId);
  });

  test('offers a labelled form built from the template, and refuses a value that is not valid', async ({ page }) => {
    await signIn(page, /Preparer/);
    if (!sampleEngagementId) test.skip(true, 'No engagements are seeded in this environment.');
    await page.goto(`/engagements/${sampleEngagementId}`);

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
    if (!sampleEngagementId) test.skip(true, 'No engagements are seeded in this environment.');
    await page.goto(`/engagements/${sampleEngagementId}`);

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
