/**
 * Whether a configured value is even shaped like an e-mail address.
 *
 * This exists for the same reason the Entra shape checks do. A placeholder is a
 * perfectly good non-empty string, so `BOOTSTRAP_ADMIN_EMAILS` set to
 * `<your full name@firm.ca address>` parses, splits, lower-cases and is stored
 * as an "address" like any other. It then quietly matches nobody, and the only
 * symptom is a person signing in and finding they hold no roles — with nothing
 * anywhere connecting that to the variable.
 *
 * "Nobody has signed in with this address" and "that is not an address" are
 * different problems with different fixes, and telling them apart is the whole
 * point. The first is a typo or a different UPN; the second is instructions
 * pasted in place of a value.
 *
 * Deliberately permissive about what an address may contain — real ones are
 * stranger than most validators allow, and rejecting a valid address here would
 * lock somebody out of their own deployment. It only catches values that cannot
 * be addresses at all.
 */

/** Characters that never appear in an address but do appear in instructions. */
const IMPOSSIBLE = /[\s<>(),;:"[\]\\…]/;

export function looksLikeEmailAddress(value: string | undefined | null): boolean {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (IMPOSSIBLE.test(trimmed)) return false;

  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (local.length > 64) return false;

  // A domain needs a dot and a plausible tail. `user@localhost` is a valid
  // address in the abstract and never the one a firm means here.
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain) && !domain.includes('..');
}

/**
 * Names what is wrong with a `BOOTSTRAP_ADMIN_EMAILS` entry, or returns null
 * when it is at least the right shape. The wording reaches an operator, so it
 * says what to do rather than what failed.
 */
export function describeBootstrapAddressProblem(value: string): string | null {
  const trimmed = value.trim();

  if (looksLikeEmailAddress(trimmed)) return null;

  // Worth separating: the fix for a placeholder is to go and find the real
  // value, which is a different errand from correcting a typo.
  if (trimmed.includes('<') || trimmed.includes('…') || trimmed.includes('...') || /PASTE_YOUR/i.test(trimmed)) {
    return 'is placeholder text, not an address. Run `pnpm admin:users` — it prints the addresses that have actually signed in — and set the variable to one of them, or clear it.';
  }

  return 'is not an e-mail address, so it can never match anyone. It must be the address Entra ID authenticates, which is usually the work e-mail address.';
}
