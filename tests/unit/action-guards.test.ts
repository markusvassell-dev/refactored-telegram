import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every server action checks its token, and this is what says so.
 *
 * `markAllNotificationsRead` did not. The form was already sending a token —
 * `ActionForm` writes one into every form it renders — and the action simply
 * never read it, so the check was not bypassed, it was never written.
 *
 * The type system could not catch it and never will: `ActionForm` types its
 * action as `(formData: FormData) => …`, and TypeScript accepts a function of
 * no arguments wherever one of one argument is wanted. So the action compiled,
 * rendered, submitted and worked, and the only visible difference between it
 * and its fifty-three neighbours was one missing line.
 *
 * A test for that one action would have been worth almost nothing, because the
 * defect was never about notifications — it was about a convention with no
 * enforcement behind it. This asserts the convention over the whole file, so
 * the fifty-fifth action cannot arrive without one either.
 */

const ACTIONS = 'apps/web/src/app/actions.ts';

/**
 * Splits the file into one entry per exported action.
 *
 * Crude on purpose: a regex over `export async function` is enough here and
 * stays readable, where a parser would need maintaining for the sake of a file
 * whose shape has been stable since it was written.
 */
async function actions(): Promise<{ name: string; body: string }[]> {
  const source = await readFile(join(process.cwd(), ACTIONS), 'utf8');
  const pattern = /^export async function (\w+)/gm;

  const starts: { name: string; index: number }[] = [];
  for (const match of source.matchAll(pattern)) {
    starts.push({ name: match[1] as string, index: match.index });
  }

  return starts.map((start, position) => ({
    name: start.name,
    body: source.slice(start.index, starts[position + 1]?.index ?? source.length),
  }));
}

describe('the server actions', () => {
  it('are all found, so a rewrite of the file cannot silently empty this test', async () => {
    // Without this, a refactor that changed the declaration style would leave
    // every assertion below passing over an empty list.
    const found = await actions();
    expect(found.length).toBeGreaterThan(50);
  });

  it('every one of them verifies the CSRF token', async () => {
    const missing = (await actions())
      .filter((action) => !action.body.includes('assertCsrf('))
      .map((action) => action.name);

    expect(missing, `these actions mutate without checking the token: ${missing.join(', ')}`).toEqual([]);
  });

  it('every one of them establishes who is asking', async () => {
    // `requirePermission` is the usual answer; `requireUser` is the right one
    // where the record itself is scoped to the reader, as notifications are —
    // a notification id is not a capability, and the service scopes by user id.
    const missing = (await actions())
      .filter((action) => !/require(Permission|User)\(/.test(action.body))
      .map((action) => action.name);

    expect(missing, `these actions do not identify the actor: ${missing.join(', ')}`).toEqual([]);
  });

  it('takes the token from the form rather than from anywhere else', async () => {
    // The token is bound to the session and travels in the form body. Reading
    // it from a header or a query string would defeat the point of binding it,
    // so the one shape is the shape everywhere.
    for (const action of await actions()) {
      if (!action.body.includes('assertCsrf(')) continue;
      expect(action.body, `${action.name} reads the token from somewhere unexpected`).toMatch(
        /assertCsrf\(\s*formData\.get\('csrf'\)/,
      );
    }
  });
});
