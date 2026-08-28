import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { SETTING_KEYS, SettingsService } from '@element/services';

/**
 * The deployment's Test Mode is a floor, and the screen has to say so.
 *
 * `testMode` resolves as `env.TEST_MODE || stored`, deliberately: a restored
 * production database must not be able to arm a staging environment. The cost
 * is that turning Test Mode off in the application, under a deployment that
 * pins it on, writes a value that changes nothing.
 *
 * That is exactly what happened. The toggle saved, the audit event was written,
 * and the action reported "Test Mode is off" — above a banner still reading TEST
 * MODE. Nothing errored, and the only reasonable conclusion available to the
 * person doing it was that the toggle was broken.
 *
 * These fix the resolution in place, so the refusal in `setTestMode` cannot
 * drift away from the rule it exists to explain.
 */

const prisma = new PrismaClient();
const settings = new SettingsService(prisma);

const PINNED = { TEST_MODE: true, ALLOW_PRODUCTION_SENDING: false, APP_ENV: 'production' };
const RELEASED = { TEST_MODE: false, ALLOW_PRODUCTION_SENDING: true, APP_ENV: 'production' };

async function store(testMode: boolean, productionSending: boolean): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEYS.testMode },
    create: { key: SETTING_KEYS.testMode, value: testMode as never },
    update: { value: testMode as never },
  });
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEYS.productionSendingEnabled },
    create: { key: SETTING_KEYS.productionSendingEnabled, value: productionSending as never },
    update: { value: productionSending as never },
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Left as it was found: on. Anything else would arm a shared test database.
  await store(true, false);
  await prisma.$disconnect();
});

describe('the deployment wins', () => {
  it('keeps Test Mode on however the database is set', async () => {
    await store(false, true);

    const state = await settings.testModeState(PINNED);

    expect(state.testMode).toBe(true);
    expect(state.productionSendingEnabled).toBe(false);
    expect(state.banner).toMatch(/test mode/i);
  });

  it('releases it once the variable does, with no second visit to the screen', async () => {
    // The stored `false` above is still in place. This is what makes the
    // refusal safe to state as it is: the preference is not silently kept,
    // so nothing is armed behind the operator's back.
    await store(false, true);

    const state = await settings.testModeState(RELEASED);

    expect(state.testMode).toBe(false);
    expect(state.productionSendingEnabled).toBe(true);
    expect(state.banner).toBeNull();
  });

  it('refuses to send while the deployment withholds it, however the screen is set', async () => {
    // The halfway state, and a real one: TEST_MODE cleared on Railway while
    // ALLOW_PRODUCTION_SENDING is still false. Test Mode genuinely lifts, and
    // sending must not — the environment has to permit it too, whatever an
    // administrator armed on the screen beforehand.
    await store(false, true);

    const state = await settings.testModeState({
      TEST_MODE: false,
      ALLOW_PRODUCTION_SENDING: false,
      APP_ENV: 'production',
    });

    expect(state.testMode).toBe(false);
    expect(state.productionSendingEnabled).toBe(false);
    expect(state.banner).toMatch(/production sending is disabled/i);
  });

  it('still needs production sending armed in the application', async () => {
    // Both locks are real. Clearing the environment alone is not enough.
    await store(false, false);

    const state = await settings.testModeState(RELEASED);

    expect(state.testMode).toBe(false);
    expect(state.productionSendingEnabled).toBe(false);
    expect(state.banner).toMatch(/production sending is disabled/i);
  });
});
