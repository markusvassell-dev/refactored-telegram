import { describe, expect, it } from 'vitest';
import {
  CLIENT_SEARCH_FIELDS,
  clientSearchWhere,
  normaliseClientSearch,
} from '../../apps/web/src/lib/client-search';

/**
 * Which fields a client search reads.
 *
 * The firm's clients are numbered corporations, so a client has two real names:
 * `2409116 Alberta Ltd.`, which prints on the letter, and `Lava Grill Seton`,
 * which is what anybody would type. Karbon holds them joined in one string and
 * the import splits them — so a search that reads any one of those three places
 * fails on some client, and the failure is silent: an empty result reads as "we
 * do not act for them" rather than "we looked in the wrong column".
 *
 * These assertions are deliberately about the shape of the query rather than
 * the rows it returns. The behaviour against real data is covered by
 * `tests/integration/client-lookup.test.ts`; what is easy to break here — and
 * impossible to notice — is somebody quietly dropping a field.
 */

function fieldsOf(where: ReturnType<typeof clientSearchWhere>): string[] {
  return (where.OR ?? []).flatMap((clause) => Object.keys(clause as Record<string, unknown>));
}

describe('the client search predicate', () => {
  it('reads every name and number a client goes by', () => {
    const where = clientSearchWhere('lava');

    expect(fieldsOf(where).sort()).toEqual([...CLIENT_SEARCH_FIELDS].sort());
  });

  it('includes the unsplit name Karbon holds', () => {
    // The field that answers the case the import cannot fix. A client already
    // stored under its storefront name keeps that name, because the import will
    // not overwrite one — so `karbonFullName` is the only column that knows the
    // legal entity is 2409116 Alberta Ltd.
    expect(fieldsOf(clientSearchWhere('2409116'))).toContain('karbonFullName');
  });

  it('matches partially and without regard to case', () => {
    const where = clientSearchWhere('LaVa');

    for (const clause of where.OR ?? []) {
      const [condition] = Object.values(clause as Record<string, unknown>);
      expect(condition).toEqual({ contains: 'LaVa', mode: 'insensitive' });
    }
  });

  it('treats an empty box as no filter rather than a filter matching nothing', () => {
    // The difference between showing the client list and showing an empty page
    // that looks like the firm has no clients.
    expect(clientSearchWhere(undefined)).toEqual({});
    expect(clientSearchWhere('')).toEqual({});
    expect(clientSearchWhere('   ')).toEqual({});
  });

  it('ignores the whitespace around what was typed', () => {
    expect(normaliseClientSearch('  Lava Grill  ')).toBe('Lava Grill');
    expect(fieldsOf(clientSearchWhere('  lava  ')).length).toBeGreaterThan(0);

    const [first] = clientSearchWhere('  lava  ').OR ?? [];
    expect(Object.values(first as Record<string, unknown>)[0]).toEqual({
      contains: 'lava',
      mode: 'insensitive',
    });
  });
});
