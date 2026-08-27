/**
 * Checking the client details a person types by hand.
 *
 * These fields print on a document a client signs. Until now the only writer to
 * a client record was the Karbon import, which fills blanks only, so every
 * stored value came from somewhere with its own idea of correctness. A form
 * changes that: a business number is nine characters of free text away from
 * being wrong, and a wrong one on a T2 engagement letter is worse than a blank
 * one — blank is visibly missing, wrong sails through review.
 *
 * So each field that has a knowable shape is checked against it, and refused
 * rather than stored when it does not fit.
 *
 * Deliberately shaped as `describe…Problem` returning a sentence or null,
 * matching `address.ts`. The string reaches a person and says what to do, not
 * what failed.
 */

/**
 * A CRA business number: nine digits, optionally with a two-letter programme
 * identifier and a four-digit reference (`123456789 RC0001`).
 *
 * This is the same test the Karbon reader applies, and it lives here so the two
 * cannot drift. `readBusinessNumber` imports it. That matters more than it
 * looks: Karbon publishes no business-number field, so the reader is guessing
 * from `UserDefinedIdentifier` — free text that is frequently a client code —
 * and the shape check is the only thing standing between a client code and a
 * tax engagement letter. A form that accepted a shape the reader rejects would
 * mean the same value was valid typed and invalid imported.
 */
export function looksLikeBusinessNumber(value: string): boolean {
  return /\d{9}/.test(value.replace(/\s|-/g, ''));
}

/** Blank input clears a field. See `normaliseOptional` below for why null. */
export function describeBusinessNumberProblem(value: string): string | null {
  if (looksLikeBusinessNumber(value)) return null;

  return `“${value}” is not a business number. A CRA business number is nine digits, sometimes followed by a programme identifier such as RC0001. If this is the firm’s own client code, it does not belong here — it would print on the engagement letter as the client’s business number.`;
}

/**
 * A CRA trust account number: `T` followed by eight digits.
 *
 * Worth checking rather than storing as typed, because this is the only route
 * by which the value can reach a T3 letter at all. Karbon has no trust account
 * field and no other code in this application writes one, so there is no second
 * source to disagree with a mistake — whatever is typed here is what prints.
 */
export function looksLikeTrustAccountNumber(value: string): boolean {
  return /^T\d{8}$/i.test(value.replace(/\s|-/g, ''));
}

export function describeTrustAccountNumberProblem(value: string): string | null {
  if (looksLikeTrustAccountNumber(value)) return null;

  return `“${value}” is not a trust account number. CRA issues these as the letter T followed by eight digits, for example T12345678. Nothing else in this application can supply this value, so it prints exactly as entered.`;
}

/** Uppercased, spaces and hyphens removed. `t 1234-5678` becomes `T12345678`. */
export function normaliseTrustAccountNumber(value: string): string {
  return value.replace(/\s|-/g, '').toUpperCase();
}

/**
 * A Canadian postal code, in the letters Canada Post actually uses.
 *
 * D, F, I, O, Q and U never appear anywhere; W and Z never appear first. Those
 * exclusions are the point of checking at all — `A1A 1A1` shaped values are easy
 * to typo into something that still looks like a postal code.
 */
const CANADIAN_POSTAL_CODE = /^[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ]\d[ABCEGHJKLMNPRSTVWXYZ]\d$/;

function isCanada(country: string | null | undefined): boolean {
  const trimmed = (country ?? '').trim().toLowerCase();
  // Blank counts as Canada: the column defaults to it, so an unset country on a
  // firm whose clients are Canadian means Canada rather than "unknown".
  return trimmed.length === 0 || trimmed === 'canada' || trimmed === 'ca' || trimmed === 'can';
}

export function describePostalCodeProblem(value: string, country: string | null | undefined): string | null {
  // Only Canada is checked. A validator that refused a British or American
  // postcode would be worse than none — it would make a correct address
  // unenterable, which is the failure people work around by typing something
  // false into the field.
  if (!isCanada(country)) return null;

  if (CANADIAN_POSTAL_CODE.test(value.replace(/\s|-/g, '').toUpperCase())) return null;

  return `“${value}” is not a Canadian postal code. These are six characters in the form A1A 1A1, and the letters D, F, I, O, Q and U are never used. If this client is not in Canada, set the country first.`;
}

/** `h3z2y7` becomes `H3Z 2Y7`. Left alone outside Canada. */
export function normalisePostalCode(value: string, country: string | null | undefined): string {
  if (!isCanada(country)) return value.trim();

  const bare = value.replace(/\s|-/g, '').toUpperCase();
  return bare.length === 6 ? `${bare.slice(0, 3)} ${bare.slice(3)}` : bare;
}

/**
 * A trimmed value, or null when the person left the box empty.
 *
 * Null rather than `''` is load-bearing, not tidiness. The Karbon import's
 * backfill decides whether it may fill a column by asking whether the stored
 * value is a non-empty string (`hasMine` in `client-import-service.ts`). An
 * empty string is therefore a blank it will fill on the next run, and a value
 * it must never touch is anything else. Storing `''` would put the column in
 * neither state clearly, and the behaviour would depend on which check ran.
 *
 * So clearing a field here is an invitation for Karbon to supply it again,
 * which is the honest meaning of an empty box and is what the form says.
 */
export function normaliseOptional(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The one field an engagement letter cannot be rendered without. */
export function describeLegalNameProblem(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return 'A legal name is required. It is the entity that signs the engagement letter, and a letter cannot be produced without one.';
  }

  if (trimmed.length > 300) {
    return 'That legal name is longer than 300 characters, which is longer than any registered entity name. Check it has not been pasted twice.';
  }

  return null;
}
