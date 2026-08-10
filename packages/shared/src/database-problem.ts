/**
 * Turning a database error into the operator's next action.
 *
 * A console script that hits a missing schema used to print the Prisma client's
 * entire minified runtime — several screens of it — and then, at the very
 * bottom, `The table 'public.user' does not exist in the current database`.
 * The one line that mattered was the one nobody could see, and the accurate
 * message still does not say what to do about it.
 *
 * The two causes worth naming are the two that actually happen: the command was
 * run on a service pointed at a different database, and the schema has not been
 * applied yet. Both look identical from inside a script, so both are named.
 */

export interface DatabaseProblem {
  /** One line for a person who has just watched a command fail. */
  summary: string;
  /** What to do next, in order. */
  remedies: string[];
}

export function describeDatabaseProblem(error: unknown): DatabaseProblem | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;

  // P2021 is Prisma's "table does not exist"; 42P01 is Postgres's own.
  if (code === 'P2021' || message.includes('42P01') || message.includes('does not exist in the current database')) {
    return {
      summary: 'This database has no schema — the tables are not there.',
      remedies: [
        'Check which database this service is pointed at. Every service must share one: DATABASE_URL on the worker has to reference the same Postgres as the web service, not a second one.',
        'The web service owns migrations. If DATABASE_URL is right, look at its deploy log to see whether they applied.',
        'Run this command on the web service rather than the worker — the worker deliberately never migrates.',
      ],
    };
  }

  if (code === 'P1001' || message.includes("Can't reach database server") || message.includes('P1001')) {
    return {
      summary: 'The database is unreachable.',
      remedies: [
        'Check that the Postgres service is running.',
        'Check that DATABASE_URL points at it and that the reference resolved — an unexpanded ${{...}} is a literal string, not an address.',
      ],
    };
  }

  if (code === 'P1000' || message.includes('Authentication failed')) {
    return {
      summary: 'The database refused these credentials.',
      remedies: ['DATABASE_URL carries the password. If Postgres was recreated, the old URL will still look valid and no longer work.'],
    };
  }

  return null;
}

/** The same thing as text, for a script writing to stderr. */
export function formatDatabaseProblem(problem: DatabaseProblem): string {
  const lines = [problem.summary, ''];
  for (const remedy of problem.remedies) lines.push(`  - ${remedy}`);
  return `${lines.join('\n')}\n`;
}
