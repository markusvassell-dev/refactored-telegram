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

  // A placeholder is a valid string and a valid URL, so the schema has no
  // grounds to reject it — and the service then starts, passes its health
  // check, and fails at the first sign-in instead. Warned about here, loudly,
  // rather than left to be discovered by a person trying to log in.
  const hints = platformHints();
  if (hints.length > 0) {
    process.stderr.write('\n');
    for (const hint of hints) process.stderr.write(`WARNING: ${hint}\n`);
    process.stderr.write('         The service will start, but this will not work until it is corrected.\n');
  }
} catch (error) {
  process.stderr.write('\n');
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);

  for (const hint of platformHints()) {
    process.stderr.write(`\n${hint}\n`);
  }

  process.stderr.write('\nFATAL: the service was not started because its configuration is incomplete.\n');
  process.stderr.write('       Set the variables named above and redeploy.\n');
  process.exit(1);
}

/**
 * "Invalid URL" is true but useless. A platform variable that resolved to
 * nothing leaves behind the surrounding text — `https://` with no host — and the
 * fix is not to correct the variable but to create the thing it points at.
 */
function platformHints(): string[] {
  const hints: string[] = [];
  const base = process.env.APP_BASE_URL ?? '';

  if (/^https?:\/\/$/.test(base.trim())) {
    hints.push(
      [
        `APP_BASE_URL is "${base.trim()}" — a scheme with no host, which means a`,
        'platform variable resolved to nothing rather than being set wrongly.',
        'On Railway this is ${{RAILWAY_PUBLIC_DOMAIN}} on a service that has no',
        'domain yet: Settings -> Networking -> Generate Domain, then redeploy.',
        'A service with no public domain of its own (the worker) needs the web',
        "service's domain here instead, because the value is used for the deep",
        'links written into Karbon.',
      ].join('\n'),
    );
  } else if (base.includes('PASTE_YOUR') || base.includes('<') || base.includes('example.com')) {
    hints.push(
      `APP_BASE_URL is still a placeholder: "${base.trim()}". Replace it with the service's real public URL — it is what the deep links written into Karbon point at.`,
    );
  }

  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.includes('PASTE_YOUR') && name !== 'APP_BASE_URL') {
      // The value itself is not printed: these are credential slots.
      hints.push(`${name} is still set to a placeholder value.`);
    }
  }

  return hints;
}
