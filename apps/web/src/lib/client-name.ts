/**
 * A label for a client that is never empty.
 *
 * `legalName` is required by the schema but not guaranteed to hold anything.
 * The Karbon import writes whatever the detail read returned —
 * `String(raw.FullName ?? raw.Name ?? '')` in `mapOrganization` — so a response
 * that carries no name at all is stored as an empty string rather than
 * refused. The list endpoints fall back to the entity key in that case; the
 * detail mapper does not.
 *
 * An empty string is the one value that renders as nothing whatsoever. In a
 * table it looks like a broken row; in a `<select>` it is worse than that,
 * because an `<option>` with no text cannot be told apart from its neighbours
 * or picked deliberately. Clients sort by `legalName`, so blanks sort first and
 * a handful of them fill the top of every list they appear in.
 *
 * So a blank falls back to whatever else identifies the client, and says
 * plainly that the legal name is the part that is missing. Nothing here invents
 * a name: every fallback is a value already stored against that client, and the
 * suffix is there so this is read as a client to fix rather than a client
 * called something odd.
 */
export function clientLabel(client: {
  legalName: string;
  displayName?: string | null;
  karbonFullName?: string | null;
  karbonEntityKey?: string | null;
}): string {
  const legalName = client.legalName?.trim();
  if (legalName) return legalName;

  // Karbon's own unsplit name first: it is the closest thing to the name the
  // firm uses, and it is mirrored on every import rather than only filled once.
  const known =
    client.karbonFullName?.trim() || client.displayName?.trim() || client.karbonEntityKey?.trim() || '';

  return known ? `${known} — no legal name recorded` : 'No legal name recorded';
}

/** Whether this client is one of the blanks the label above is compensating for. */
export function hasNoLegalName(client: { legalName: string }): boolean {
  return !client.legalName?.trim();
}
