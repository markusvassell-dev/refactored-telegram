import { PrismaClient, type Role } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { describeDatabaseProblem, formatDatabaseProblem } from '@element/shared';

/**
 * Granting a role from the deployment's console.
 *
 * `BOOTSTRAP_ADMIN_EMAILS` is the intended way to create the first
 * administrator, and it works — provided the address in the variable is exactly
 * the one Microsoft Entra ID authenticated. When it is not, the result is a
 * dead end with no way out from inside the application: you are signed in, you
 * hold no roles, every screen that matters is read-only, and granting a role
 * requires an administrator who does not exist. The address you would need to
 * correct the variable with is not displayed anywhere either.
 *
 * This is the way out. It requires shell access to the deployment, which is
 * already the most privileged thing a person can have here, and every grant is
 * written to the audit trail as `ROLE_GRANTED` with `grantedBy: 'console'` so
 * it is distinguishable from one made by an administrator in the application.
 *
 * Usage:
 *   pnpm admin:users                                    # who exists, and what they hold
 *   pnpm admin:grant person@firm.ca ADMINISTRATOR       # grant
 *   pnpm admin:grant person@firm.ca ADMINISTRATOR --revoke
 *
 * An address from `admin:users`, never a placeholder in angle brackets — those
 * are shell redirection, and an example written that way is a command that
 * fails for anyone who pastes it.
 */

const ROLES: Role[] = ['ADMINISTRATOR', 'PARTNER_OR_FINAL_APPROVER', 'REVIEWER', 'PREPARER', 'READ_ONLY'];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const audit = createAuditLogger(prisma);

  try {
    const [email, role] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
    const revoking = process.argv.includes('--revoke');

    if (!email) {
      await listUsers(prisma);
      return;
    }

    if (!role || !ROLES.includes(role as Role)) {
      process.stderr.write(`\nName a role: ${ROLES.join(', ')}\n\n`);
      process.exit(1);
    }

    // Matched the way sign-in matches: an address from a directory is not
    // case-sensitive, and the stored one was lower-cased when the user record
    // was created.
    const normalised = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalised }, include: { userRoles: true } });

    if (!user) {
      process.stderr.write(`\nNo user has the address "${normalised}".\n`);
      process.stderr.write('A user record is created by signing in through Entra ID, so sign in first.\n');
      process.stderr.write('The addresses that do exist:\n\n');
      await listUsers(prisma);
      process.exit(1);
    }

    if (revoking) {
      const removed = await prisma.userRole.deleteMany({ where: { userId: user.id, role: role as Role } });
      if (removed.count === 0) {
        process.stdout.write(`\n${user.email} does not hold ${role}. Nothing changed.\n\n`);
        return;
      }

      await audit.record({
        eventType: 'ROLE_REVOKED',
        objectType: 'User',
        objectId: user.id,
        userId: user.id,
        beforeValue: { role },
        reason: 'Revoked from the deployment console.',
      });

      process.stdout.write(`\nRevoked ${role} from ${user.email}.\n`);
      process.stdout.write('They must sign out and back in for it to take effect everywhere.\n\n');
      return;
    }

    if (user.userRoles.some((existing) => existing.role === role)) {
      process.stdout.write(`\n${user.email} already holds ${role}. Nothing changed.\n\n`);
      return;
    }

    await prisma.userRole.create({ data: { userId: user.id, role: role as Role, grantedBy: 'console' } });

    await audit.record({
      eventType: 'ROLE_GRANTED',
      objectType: 'User',
      objectId: user.id,
      userId: user.id,
      afterValue: { role, grantedBy: 'console' },
      reason: 'Granted from the deployment console.',
    });

    process.stdout.write(`\nGranted ${role} to ${user.email}.\n`);
    process.stdout.write('Reload the application — the roles are read from the database on every request.\n\n');
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A database failure, said in one screen rather than fifty.
 *
 * Letting this throw printed the Prisma client's whole minified runtime before
 * the sentence that mattered, on a console where scrolling back is awkward. The
 * error that prompted this was a worker service pointed at a database the web
 * service had never migrated — which the raw message describes accurately and
 * unhelpfully.
 */
function reportFailure(error: unknown): never {
  const problem = describeDatabaseProblem(error);

  if (problem) {
    process.stderr.write(`\n${formatDatabaseProblem(problem)}\n`);
    process.exit(1);
  }

  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
}

async function listUsers(prisma: PrismaClient): Promise<void> {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    include: { userRoles: true },
    orderBy: { email: 'asc' },
  });

  if (users.length === 0) {
    process.stdout.write('\nNo users exist yet. Sign in through Entra ID once to create a record.\n\n');
    return;
  }

  process.stdout.write('\n');
  for (const user of users) {
    const roles = user.userRoles.map((row) => row.role).join(', ') || 'no roles';
    process.stdout.write(`  ${user.email.padEnd(40)} ${roles}\n`);
  }
  process.stdout.write(`\n${users.length} active user(s).\n`);

  // A real address from the list above, not `<email>`. Angle brackets are shell
  // redirection: an example written that way is not an example, it is a command
  // that fails with "syntax error near unexpected token" for anyone who pastes
  // it — and pasting it is exactly what an example invites.
  process.stdout.write(`Grant a role with:  pnpm admin:grant ${users[0]!.email} ADMINISTRATOR\n\n`);
}

await main().catch(reportFailure);
