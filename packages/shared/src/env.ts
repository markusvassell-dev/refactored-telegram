import { z } from 'zod';

/**
 * Runtime environment contract.
 *
 * Every credential is read from the environment or the platform secret manager.
 * Nothing in this file may contain a default that is a real secret.
 *
 * The exact credential names required by Karbon and Adobe Acrobat Sign must be
 * confirmed against their current official documentation before production use;
 * see docs/karbon-capability-matrix.md and docs/adobe-sign-setup.md.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalString = z.string().trim().min(1).optional();

export const appEnvSchema = z.enum(['development', 'test', 'staging', 'production']);
export type AppEnv = z.infer<typeof appEnvSchema>;

export const envSchema = z
  .object({
    // ---- Application ----
    APP_NAME: z.string().trim().min(1).default('Element Engagements'),
    APP_BASE_URL: z.string().url().default('http://localhost:3000'),
    APP_ENV: appEnvSchema.default('development'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /**
     * Test Mode. When true the application refuses every outbound production
     * side effect (real e-mail, real Adobe Sign agreements, production Karbon
     * writes). Defaults to ON so that a misconfigured deployment fails safe.
     */
    TEST_MODE: bool.default(true),

    /**
     * Production sending must be armed explicitly by an administrator.
     * TEST_MODE=false alone is not sufficient; see SystemSetting
     * `production_sending_enabled`.
     */
    ALLOW_PRODUCTION_SENDING: bool.default(false),

    // ---- Data ----
    DATABASE_URL: z.string().min(1),

    /** 32-byte key, hex or base64, used for envelope encryption of stored secrets. */
    ENCRYPTION_KEY: z.string().min(32),
    /** Session cookie sealing secret. */
    SESSION_SECRET: z.string().min(32),

    // ---- Microsoft Entra ID ----
    ENTRA_TENANT_ID: optionalString,
    ENTRA_CLIENT_ID: optionalString,
    ENTRA_CLIENT_SECRET: optionalString,
    ENTRA_REDIRECT_URI: optionalString,

    /** Only honoured when APP_ENV is development or test. */
    DEV_LOGIN_ENABLED: bool.default(false),

    /**
     * Comma-separated e-mail addresses granted ADMINISTRATOR on sign-in.
     *
     * Without this a first deployment is unusable: directory role mapping is
     * empty until an administrator configures it, so the first person to sign in
     * arrives with no roles and no way to grant themselves any. This is the only
     * way a role is granted without an existing administrator, so it is narrow
     * on purpose — it grants nothing by itself, it takes effect only after
     * Entra ID has authenticated the address, and every grant is audited.
     *
     * Clear it once real administrators exist.
     */
    BOOTSTRAP_ADMIN_EMAILS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),

    // ---- Karbon ----
    //
    // Vendor credentials are deliberately absent. They live in
    // `IntegrationConnection`, encrypted, entered on the Integrations screen —
    // which is also where the sandbox-or-production flag lives. That flag is
    // what Test Mode keys off, and an environment variable has no such flag: a
    // credential supplied that way could not be told apart from a sandbox one,
    // and Test Mode's guarantee would quietly become a convention. Two sources
    // for one secret would also mean a screen that says "not configured" while
    // the application is happily writing to a live tenant.
    KARBON_API_BASE_URL: z.string().url().default('https://api.karbonhq.com/v3'),
    /** Shared secret this application chooses, for verifying inbound webhooks. */
    KARBON_WEBHOOK_SECRET: optionalString,

    // ---- Adobe Acrobat Sign ----
    ADOBE_SIGN_API_BASE_URL: optionalString,
    ADOBE_SIGN_REDIRECT_URI: optionalString,
    /** Shared secret this application chooses, for verifying inbound webhooks. */
    ADOBE_SIGN_WEBHOOK_SECRET: optionalString,

    // ---- AI-assisted extraction (opt-in only) ----
    AI_EXTRACTION_ENABLED: bool.default(false),
    AI_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
    AI_API_KEY: optionalString,
    AI_MODEL: z.string().default('claude-sonnet-5'),
    AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),

    // ---- Documents ----
    DOCUMENT_TEMP_DIRECTORY: z.string().default('/tmp/element-engagements'),
    DOCUMENT_STORAGE_DIRECTORY: z.string().default('/var/lib/element-engagements/storage'),
    DOCUMENT_RETENTION_HOURS: z.coerce.number().int().positive().default(72),
    DOCUMENT_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
    LIBREOFFICE_BINARY: z.string().default('soffice'),
    PDF_CONVERSION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

    // ---- Pricing / policy ----
    HIGH_FEE_INCREASE_THRESHOLD_PERCENT: z.coerce.number().nonnegative().default(10),

    // ---- Worker ----
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3001),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((env, ctx) => {
    const isProdLike = env.APP_ENV === 'production' || env.APP_ENV === 'staging';

    if (isProdLike && env.DEV_LOGIN_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_LOGIN_ENABLED'],
        message: 'The local development login cannot be enabled in staging or production.',
      });
    }

    if (isProdLike && (!env.ENTRA_TENANT_ID || !env.ENTRA_CLIENT_ID || !env.ENTRA_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENTRA_CLIENT_ID'],
        message:
          'Microsoft Entra ID configuration (ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET) is required outside development.',
      });
    }

    if (env.AI_EXTRACTION_ENABLED && (env.AI_PROVIDER === 'none' || !env.AI_API_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_EXTRACTION_ENABLED'],
        message: 'AI extraction requires AI_PROVIDER and AI_API_KEY to be configured.',
      });
    }

    if (env.ALLOW_PRODUCTION_SENDING && env.TEST_MODE) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_PRODUCTION_SENDING'],
        message: 'ALLOW_PRODUCTION_SENDING cannot be true while TEST_MODE is on.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper — resets the memoised environment. */
export function resetEnvCache(): void {
  cached = null;
}
