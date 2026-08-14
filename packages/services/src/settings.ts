import type { PrismaClient } from '@element/database';
import { PermissionError, type Role } from '@element/shared';

/**
 * System settings, including the Test Mode switch.
 *
 * Test Mode defaults to ON. Turning production sending on is a deliberate,
 * administrator-only act that is recorded in the audit trail — the application
 * is designed to make confusing test and production difficult.
 */

export const SETTING_KEYS = {
  testMode: 'test_mode',
  productionSendingEnabled: 'production_sending_enabled',
  highIncreaseThresholdPercent: 'high_fee_increase_threshold_percent',
  requireFinalApproverByEngagementType: 'require_final_approver_by_engagement_type',
  priorYearFilenamePatterns: 'prior_year_filename_patterns',
  karbonStatusTriggers: 'karbon_status_triggers',
  karbonStatusMap: 'karbon_status_map',
  productName: 'product_name',
  aiExtractionEnabled: 'ai_extraction_enabled',
  documentRetentionHours: 'document_retention_hours',
  /**
   * The user who signs on the firm's behalf, by default.
   *
   * Decided once rather than on every engagement, and overridable on an
   * individual one — the partner who owns a client is not always the person who
   * signs for the firm. Unset means no firm signer is proposed, and the
   * engagement will say so rather than sending a letter nobody countersigned.
   */
  firmSignerUserId: 'firm_signer_user_id',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export interface TestModeState {
  /** True when the application must not touch anything production. */
  testMode: boolean;
  /** True only when an administrator has explicitly armed production sending. */
  productionSendingEnabled: boolean;
  /** Human-readable banner text; null when running in production mode. */
  banner: string | null;
}

export class SettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async getRaw<T>(key: SettingKey, fallback: T): Promise<T> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    return row ? (row.value as T) : fallback;
  }

  async set(
    key: SettingKey,
    value: unknown,
    actor: { id: string; roles: readonly Role[] },
  ): Promise<void> {
    if (!actor.roles.includes('ADMINISTRATOR')) {
      throw new PermissionError('Only an administrator can change system settings.');
    }

    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: value as never, updatedBy: actor.id },
      update: { value: value as never, updatedBy: actor.id },
    });
  }

  /**
   * Resolves Test Mode.
   *
   * The environment variable is a floor, not a suggestion: if the deployment
   * says TEST_MODE the database cannot turn it off. That way a restored
   * production database cannot accidentally arm a staging environment.
   */
  async testModeState(env: { TEST_MODE: boolean; ALLOW_PRODUCTION_SENDING: boolean; APP_ENV: string }): Promise<TestModeState> {
    const storedTestMode = await this.getRaw<boolean>(SETTING_KEYS.testMode, true);
    const storedProductionSending = await this.getRaw<boolean>(SETTING_KEYS.productionSendingEnabled, false);

    const testMode = env.TEST_MODE || storedTestMode;
    const productionSendingEnabled = !testMode && env.ALLOW_PRODUCTION_SENDING && storedProductionSending;

    return {
      testMode,
      productionSendingEnabled,
      banner: testMode
        ? `TEST MODE — ${env.APP_ENV.toUpperCase()} — no real client will be contacted and nothing is written to production Karbon or Adobe Sign.`
        : productionSendingEnabled
          ? null
          : 'PRODUCTION SENDING IS DISABLED — documents can be prepared and approved but not sent.',
    };
  }

  async highIncreaseThresholdPercent(fallback: number): Promise<number> {
    return this.getRaw<number>(SETTING_KEYS.highIncreaseThresholdPercent, fallback);
  }

  async productName(fallback: string): Promise<string> {
    return this.getRaw<string>(SETTING_KEYS.productName, fallback);
  }

  /**
   * Whether a partner or final approver must sign off before sending, per
   * engagement type. Production defaults require at least one internal
   * reviewer, with elevated approval for exceptions.
   */
  async requiresFinalApprover(engagementType: string): Promise<boolean> {
    const map = await this.getRaw<Record<string, boolean>>(SETTING_KEYS.requireFinalApproverByEngagementType, {});
    return map[engagementType] ?? true;
  }

  /** Karbon Work Item statuses that may trigger generation. */
  async karbonStatusTriggers(): Promise<{ workType: string; status: string; engagementType: string }[]> {
    return this.getRaw(SETTING_KEYS.karbonStatusTriggers, []);
  }

  /** Application status -> Karbon work status. Unmapped statuses are skipped. */
  async karbonStatusMap(): Promise<Record<string, string>> {
    return this.getRaw<Record<string, string>>(SETTING_KEYS.karbonStatusMap, {});
  }
}
