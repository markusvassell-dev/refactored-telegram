import type { Prisma } from '@element/database';

/**
 * Looking a client up by any name it goes by.
 *
 * The firm's clients are largely numbered Alberta corporations, and Karbon
 * records them as `2409116 Alberta Ltd. (Lava Grill Seton)`. The import splits
 * that: the numbered company becomes the legal name because it is the entity
 * that signs, and the storefront name becomes the display name. Both halves are
 * real names for the same client and a person will search with either — usually
 * the one the legal name is not.
 *
 * So the search reads five fields, and the third is the one that makes it work
 * for a client the import could not correct:
 *
 *   - `legalName` and `displayName` — the two halves as this application holds
 *     them.
 *   - `karbonFullName` — Karbon's unsplit string. A client already here under
 *     the wrong name keeps that name, because the import never overwrites one;
 *     the only record that it is really 2409116 Alberta Ltd. is this column.
 *   - `businessNumber` and `karbonEntityKey` — "name or number" covers both, and
 *     an identifier someone has pasted from elsewhere should find its client
 *     rather than nothing.
 *
 * `contains` rather than a prefix or an equality: a person searching for a
 * client types the part they remember, which for a numbered company is the
 * digits and for a restaurant is one word of the sign over the door.
 */

/** Named for the unit test, so dropping a field from the search fails loudly. */
export const CLIENT_SEARCH_FIELDS = [
  'legalName',
  'displayName',
  'karbonFullName',
  'businessNumber',
  'karbonEntityKey',
] as const;

export function normaliseClientSearch(raw: string | undefined): string {
  return (raw ?? '').trim();
}

export function clientSearchWhere(raw: string | undefined): Prisma.ClientWhereInput {
  const query = normaliseClientSearch(raw);

  // An empty box is not a filter that matches nothing; it is no filter at all.
  if (query.length === 0) return {};

  return {
    OR: [
      { legalName: { contains: query, mode: 'insensitive' } },
      { displayName: { contains: query, mode: 'insensitive' } },
      { karbonFullName: { contains: query, mode: 'insensitive' } },
      { businessNumber: { contains: query, mode: 'insensitive' } },
      { karbonEntityKey: { contains: query, mode: 'insensitive' } },
    ],
  };
}
