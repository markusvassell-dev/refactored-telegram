import { PrismaClient } from '@element/database';
import { MicrosoftGraphMailer } from '@element/integrations';
import { createLogger, describeSenderProblem, loadEnv } from '@element/shared';

/**
 * Proving that staff notification e-mail works.
 *
 * Without this the only way to find out is to wait for a client to sign, and
 * discover then that the sender mailbox does not exist or the permission was
 * never consented. That is the wrong moment to learn it.
 *
 * Two steps, in the order the failures actually happen:
 *
 *   1. A health check. Fetches an application token and reads the sending
 *      mailbox. This alone catches the three things that go wrong — a wrong
 *      tenant or secret, a mailbox that does not exist, and a `Mail.Send`
 *      application permission that was never granted or consented.
 *   2. Optionally, one real message to an address you name.
 *
 * The address is never defaulted. Sending mail is an outbound side effect and
 * the recipient is a decision, not a convenience.
 *
 * Usage:
 *   pnpm verify:email                        # health check only
 *   pnpm verify:email --to you@yourfirm.ca   # and send one message
 */

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: 'warn', base: { service: 'verify-email' } });

  process.stdout.write('\nStaff notification e-mail\n');
  process.stdout.write(`  enabled      ${env.NOTIFICATION_EMAIL_ENABLED ? 'yes' : 'NO — nothing will be sent'}\n`);
  process.stdout.write(`  sending as   ${env.NOTIFICATION_EMAIL_SENDER ?? '(not set)'}\n`);
  process.stdout.write(`  tenant       ${env.ENTRA_TENANT_ID ?? '(not set)'}\n\n`);

  if (!env.NOTIFICATION_EMAIL_ENABLED) {
    process.stderr.write('NOTIFICATION_EMAIL_ENABLED is off, so no mail is sent whatever else is configured.\n');
    process.stderr.write('Set it to true, set NOTIFICATION_EMAIL_SENDER, and redeploy.\n\n');
    process.exit(1);
  }

  // A placeholder domain reaches Microsoft, is refused, and the refusal reads
  // as a permissions problem — sending somebody to Entra to re-check a consent
  // that was never the issue. Caught here instead.
  const senderProblem = describeSenderProblem(env.NOTIFICATION_EMAIL_SENDER);
  if (senderProblem) {
    process.stderr.write(`NOTIFICATION_EMAIL_SENDER ${senderProblem}\n`);
    process.stderr.write('Nothing was attempted; Microsoft would have refused it for the wrong-looking reason.\n\n');
    process.exit(1);
  }

  if (!env.NOTIFICATION_EMAIL_SENDER || !env.ENTRA_TENANT_ID || !env.ENTRA_CLIENT_ID || !env.ENTRA_CLIENT_SECRET) {
    process.stderr.write('The Entra ID registration or the sender mailbox is not configured.\n');
    process.stderr.write('Mail sends through the same app registration as sign-in, so all three ENTRA_* values are needed.\n\n');
    process.exit(1);
  }

  const mailer = new MicrosoftGraphMailer({
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_CLIENT_ID,
    clientSecret: env.ENTRA_CLIENT_SECRET,
    sender: env.NOTIFICATION_EMAIL_SENDER,
    logger,
  });

  const health = await mailer.healthCheck();
  process.stdout.write(`[${health.ok ? '  ok  ' : ' FAIL '}] MAILBOX_REACHABLE          ${health.detail ?? ''}\n`);

  if (!health.ok) {
    process.stdout.write('\nThe three things this usually is:\n');
    process.stdout.write('  1. The Mail.Send APPLICATION permission was not granted, or admin consent\n');
    process.stdout.write('     was never given. Delegated Mail.Send is a different permission and will\n');
    process.stdout.write('     not work here — notices are raised by a worker with nobody signed in.\n');
    process.stdout.write(`  2. The mailbox ${env.NOTIFICATION_EMAIL_SENDER} does not exist. Create it as a\n`);
    process.stdout.write('     shared mailbox; a shared mailbox needs no licence.\n');
    process.stdout.write('  3. The client secret has expired. They do, and the failure looks like this.\n\n');
    process.exit(1);
  }

  const recipient = argument('to');
  if (!recipient) {
    process.stdout.write('\nCredentials and mailbox are good. Nothing was sent.\n');
    process.stdout.write('To send one real message:  pnpm verify:email --to you@yourfirm.ca\n\n');
    return;
  }

  const stamp = new Date().toISOString();
  const sent = await mailer.send({
    to: recipient,
    subject: `Element Engagements test message (${stamp})`,
    body: [
      'This is a test from the Element Engagements deployment.',
      '',
      'If you are reading it, staff notification e-mail is working: the next time a',
      'client signs an engagement letter, the preparer, reviewer and final approver',
      'will be told without having to open the application.',
      '',
      'Nothing was sent to any client. This application never e-mails clients.',
    ].join('\n'),
  });

  process.stdout.write(`[${sent.ok ? '  ok  ' : ' FAIL '}] TEST_MESSAGE_SENT          ${sent.detail ?? `to ${recipient}`}\n`);

  if (!sent.ok) {
    process.stdout.write('\nThe mailbox is readable but the message was refused. That is usually an\n');
    process.stdout.write('application access policy, or an RBAC role assignment, excluding this\n');
    process.stdout.write('mailbox from the app.\n\n');
    process.exit(1);
  }

  process.stdout.write('\nAccepted by Microsoft. Accepted is not delivered — check the inbox, and the\n');
  process.stdout.write('junk folder, before concluding it worked.\n\n');
}

// The database is not touched; it is opened only so a misconfigured deployment
// fails the same way here as everywhere else.
const prisma = new PrismaClient();
try {
  await main();
} finally {
  await prisma.$disconnect();
}
