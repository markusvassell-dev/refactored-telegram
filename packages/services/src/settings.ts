import { z } from 'zod';
import type { PrismaClient } from '@element/database';
import { PermissionError, type Role } from '@element/shared';

/**
 * A Karbon work item status that starts an engagement.
 *
 * Validated rather than trusted, and the reason changed recently. This was a
 * hint that started a document search on an engagement somebody had already
 * created; `engagementType` was declared here and read by nothing. It now
 * decides **which legal document type gets created** — a T2 corporate letter or
 * a T1 personal one — so a typo must disable the trigger rather than falling
 * through to a default. An entry that does not parse is dropped and the rest
 * still work, because one malformed row should not silently stop a firm's
 * whole annual rollover.
 *
 * `workType` is optional and free text because Karbon's vocabulary is
 * tenant-defined — the same reason `ContactType` is not filtered on during the
 * client import. Matching is case-insensitive; a firm that writes
 * "Ready for Letter" should not be defeated by capitalisation.
 */
export const karbonStatusTriggerSchema = z.object({
  workType: z.string().trim().nullish().transform((value) => value ?? ''),
  status: z.string().trim().min(1),
  engagementType: z.enum(['T1_JOINT', 'T1_SINGLE', 'T2', 'T3']),
});

export type KarbonStatusTrigger = z.infer<typeof karbonStatusTriggerSchema>;

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
  async karbonStatusTriggers(): Promise<KarbonStatusTrigger[]> {
    const stored = await this.getRaw<unknown[]>(SETTING_KEYS.karbonStatusTriggers, []);
    if (!Array.isArray(stored)) return [];

    // Each row parsed on its own, so one bad entry costs one trigger rather
    // than all of them.
    return stored.flatMap((row) => {
      const parsed = karbonStatusTriggerSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** Application status -> Karbon work status. Unmapped statuses are skipped. */
  async karbonStatusMap(): Promise<Record<string, string>> {
    return this.getRaw<Record<string, string>>(SETTING_KEYS.karbonStatusMap, {});
  }
}
