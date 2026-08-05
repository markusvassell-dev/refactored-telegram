import { loadEnv } from '@element/shared';

/**
 * Pre-flight environment check.
 *
 * The environment is otherwise validated lazily, on the first request that
 * needs it. That turns a missing variable into a 500 on every page of an
 * apparently healthy deployment — the health check passes, because it does not
 * touch configuration, and the operator is left guessing.
 *
 * Running this before the server starts makes a misconfiguration what it should
 * be: a failed deploy, with the offending key named in the log.
 */

try {
  const env = loadEnv();

  process.stdout.write('    environment OK\n');
  process.stdout.write(`      APP_ENV                  ${env.APP_ENV}\n`);
  process.stdout.write(`      APP_BASE_URL             ${env.APP_BASE_URL}\n`);
  process.stdout.write(`      TEST_MODE                ${env.TEST_MODE}\n`);
  process.stdout.write(`      ALLOW_PRODUCTION_SENDING ${env.ALLOW_PRODUCTION_SENDING}\n`);

  // Names only. The values are credentials and never belong in a deploy log.
  const configured = [
    env.ENTRA_CLIENT_ID ? 'entra-id' : null,
    env.KARBON_BEARER_TOKEN ? 'karbon' : null,
    env.ADOBE_SIGN_CLIENT_ID ? 'adobe-sign' : null,
  ].filter((name): name is string => name !== null);

  process.stdout.write(`      integrations configured  ${configured.length > 0 ? configured.join(', ') : 'none'}\n`);

  if (env.BOOTSTRAP_ADMIN_EMAILS.length > 0) {
    process.stdout.write(
      `      bootstrap administrators ${env.BOOTSTRAP_ADMIN_EMAILS.length} address(es) will be granted ADMINISTRATOR on sign-in\n`,
    );
  }
} catch (error) {
  process.stderr.write('\n');
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write('\nFATAL: the service was not started because its configuration is incomplete.\n');
  process.stderr.write('       Set the variables named above and redeploy.\n');
  process.exit(1);
}
