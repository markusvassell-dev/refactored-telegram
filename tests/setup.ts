/**
 * Test bootstrap.
 *
 * Supplies a complete, obviously-fake environment so `env()` validates without
 * anyone needing a .env file, and forces Test Mode on for the whole suite.
 */

const environment = process.env as Record<string, string | undefined>;

function withDefault(key: string, value: string): void {
  environment[key] ??= value;
}

withDefault('APP_NAME', 'Element Engagements');
withDefault('APP_ENV', 'test');
withDefault('NODE_ENV', 'test');
withDefault('APP_BASE_URL', 'http://localhost:3000');
withDefault('TEST_MODE', 'true');
withDefault('ALLOW_PRODUCTION_SENDING', 'false');
withDefault('DEV_LOGIN_ENABLED', 'true');

withDefault(
  'DATABASE_URL',
  environment.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/element_engagements_test?schema=public',
);

// Deterministic, non-secret test keys. Nothing here is used outside tests.
withDefault('ENCRYPTION_KEY', '0'.repeat(64));
withDefault('SESSION_SECRET', '1'.repeat(64));
withDefault('ADOBE_SIGN_WEBHOOK_SECRET', 'test-adobe-webhook-secret');
withDefault('KARBON_WEBHOOK_SECRET', 'test-karbon-webhook-secret');

withDefault('DOCUMENT_TEMP_DIRECTORY', '/tmp/element-engagements-tests');
withDefault('DOCUMENT_STORAGE_DIRECTORY', '/tmp/element-engagements-tests/storage');
withDefault('DOCUMENT_RETENTION_HOURS', '72');
withDefault('HIGH_FEE_INCREASE_THRESHOLD_PERCENT', '10');
withDefault('LOG_LEVEL', 'error');
