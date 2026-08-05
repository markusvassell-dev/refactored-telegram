import { expect, test, type Page } from '@playwright/test';

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
