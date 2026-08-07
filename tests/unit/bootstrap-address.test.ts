import { describe, expect, it } from 'vitest';
import { describeBootstrapAddressProblem, looksLikeEmailAddress } from '@element/shared';

/**
 * The case that prompted this: `BOOTSTRAP_ADMIN_EMAILS` was set to the
 * instruction text `<your full markus@elementaccou….com address>` — literally
 * the placeholder from a set-up message, pasted into the variable. It parsed,
 * it lower-cased, it was stored as an "address", and it matched nobody. The
 * only symptom was a person signing in and holding no roles.
 */

describe('looksLikeEmailAddress', () => {
  it('accepts ordinary work addresses', () => {
    for (const address of [
      'markus@elementaccounting.com',
      'first.last@firm.ca',
      'a+tag@sub.domain.co.uk',
      "o'brien@firm.ca",
      'user_name@firm-name.ca',
    ]) {
      expect(looksLikeEmailAddress(address), address).toBe(true);
    }
  });

  it('rejects instruction text pasted in place of a value', () => {
    for (const value of [
      '<your full markus@elementaccou….com address>',
      'your full name@firm.ca address',
      'PASTE_YOUR_EMAIL',
      '<admin@firm.ca>',
    ]) {
      expect(looksLikeEmailAddress(value), value).toBe(false);
    }
  });

  it('rejects values that cannot address anyone', () => {
    for (const value of ['', '   ', 'markus', '@firm.ca', 'markus@', 'a@b@firm.ca', 'user@localhost', 'user@firm..ca']) {
      expect(looksLikeEmailAddress(value), value).toBe(false);
    }
  });

  it('is permissive rather than clever, because a false rejection locks somebody out', () => {
    // Not addresses this application would ever see, but rejecting a real
    // address here would leave its owner with no way into their own deployment.
    // Better to pass something odd than to refuse something valid.
    expect(looksLikeEmailAddress('very.unusual!#$%&*+-/=?^_`{|}~@firm.ca')).toBe(true);
  });
});

describe('describeBootstrapAddressProblem', () => {
  it('says nothing about an address that is the right shape', () => {
    expect(describeBootstrapAddressProblem('markus@elementaccounting.com')).toBeNull();
  });

  it('separates placeholder text from a typo, because the fix is different', () => {
    const placeholder = describeBootstrapAddressProblem('<your full markus@elementaccou….com address>');
    expect(placeholder).toMatch(/placeholder/i);
    // The way out is named, not just the diagnosis.
    expect(placeholder).toContain('admin:users');

    const typo = describeBootstrapAddressProblem('markus');
    expect(typo).toMatch(/not an e-mail address/i);
    expect(typo).not.toMatch(/placeholder/i);
  });

  it('never reports "nobody has signed in" for something that is not an address', () => {
    // The distinction the whole helper exists for: one sends you to check
    // sign-ins, the other sends you to correct the variable.
    expect(describeBootstrapAddressProblem('<paste it here>')).not.toBeNull();
  });
});
