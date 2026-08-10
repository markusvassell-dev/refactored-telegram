import { describe, expect, it } from 'vitest';
import { describeDatabaseProblem, formatDatabaseProblem } from '@element/shared';

/**
 * What a console script says when the database is not what it expected.
 *
 * This exists because `pnpm admin:grant` was run on the worker service, whose
 * `DATABASE_URL` pointed at a database the web service had never migrated. The
 * script printed the Prisma client's entire minified runtime — several screens
 * — and then, last, `The table 'public.user' does not exist in the current
 * database`. Accurate, invisible, and silent on what to do about it.
 */

/** Prisma throws with a `code`; the raw driver surfaces the SQLSTATE. */
function prismaError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('naming a database failure', () => {
  it('recognises a missing schema, whichever way it arrives', () => {
    const fromPrisma = describeDatabaseProblem(
      prismaError('P2021', "The table `public.user` does not exist in the current database."),
    );
    const fromPostgres = describeDatabaseProblem(new Error('relation "background_job" does not exist (42P01)'));

    for (const problem of [fromPrisma, fromPostgres]) {
      expect(problem?.summary).toMatch(/no schema/i);
    }
  });

  it('names the wrong-service cause first, because that is the one that happened', () => {
    // The worker deliberately never migrates: the web service owns the schema
    // so two services cannot race for the same advisory lock. So a worker shell
    // reporting no tables means it is pointed somewhere the web service is not.
    const problem = describeDatabaseProblem(prismaError('P2021', 'does not exist in the current database'));

    expect(problem?.remedies[0]).toMatch(/same Postgres|DATABASE_URL/i);
    expect(problem?.remedies.join(' ')).toMatch(/worker/i);
  });

  it('tells an unreachable database apart from an empty one, because the fix differs', () => {
    const problem = describeDatabaseProblem(prismaError('P1001', "Can't reach database server at `localhost:5432`"));

    expect(problem?.summary).toMatch(/unreachable/i);
    // The trap worth naming: a Railway variable reference that never expanded
    // is a literal string, and it looks like configuration that is present.
    expect(problem?.remedies.join(' ')).toMatch(/\$\{\{/);
  });

  it('recognises credentials that no longer work', () => {
    const problem = describeDatabaseProblem(prismaError('P1000', 'Authentication failed against database server'));
    expect(problem?.summary).toMatch(/refused these credentials/i);
  });

  it('says nothing about a failure it does not recognise, rather than guessing', () => {
    // A wrong explanation sends someone to check the one thing that is fine.
    expect(describeDatabaseProblem(new Error('Unique constraint failed on the fields: (`email`)'))).toBeNull();
    expect(describeDatabaseProblem('not an error at all')).toBeNull();
  });

  it('formats to something readable in a terminal', () => {
    const problem = describeDatabaseProblem(prismaError('P2021', 'does not exist in the current database'));
    const text = formatDatabaseProblem(problem!);

    expect(text.split('\n')[0]).toBe(problem!.summary);
    expect(text).toContain('  - ');
    // Short enough to read without scrolling back, which was the whole problem.
    expect(text.split('\n').length).toBeLessThan(12);
  });
});
