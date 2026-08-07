import { describe, expect, it } from 'vitest';
import {
  describeBootstrapAddressProblem,
  describeSandboxMislabel,
  describeSenderProblem,
  isKnownProductionHost,
  looksLikeEmailAddress,
} from '@element/shared';

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

describe('the mailbox notices are sent from', () => {
  /**
   * What was actually deployed: `engagements@yourfirm.ca`. A well-formed
   * address, so every shape check said yes. Microsoft then refused it, and the
   * refusal reads as a missing Mail.Send consent — which sent the operator to
   * Entra to re-check a permission that was never the problem. The mailbox
   * simply does not exist, because the domain came from a set-up guide.
   */
  it('accepts a real firm address', () => {
    expect(describeSenderProblem('engagements@elementaccounting.com')).toBeNull();
    expect(describeSenderProblem('no-reply@dgpc.ca')).toBeNull();
  });

  it('catches a placeholder domain, which is well-formed and still wrong', () => {
    const problem = describeSenderProblem('engagements@yourfirm.ca');

    expect(problem).toMatch(/placeholder domain/i);
    // And names the real fix, rather than leaving Microsoft's answer to mislead.
    expect(problem).toMatch(/shared mailbox/i);
    expect(problem).toMatch(/needs no licence/i);
  });

  it('catches every placeholder domain a guide is likely to have used', () => {
    for (const address of [
      'a@yourfirm.com',
      'a@yourcompany.com',
      'a@example.com',
      'a@example.ca',
      'a@firm.ca',
      'a@contoso.com',
    ]) {
      expect(describeSenderProblem(address), address).toMatch(/placeholder domain/i);
    }
  });

  it('distinguishes not set from not an address from not real', () => {
    expect(describeSenderProblem('')).toMatch(/not set/i);
    expect(describeSenderProblem('engagements')).toMatch(/not an e-mail address/i);
    expect(describeSenderProblem('engagements@yourfirm.ca')).toMatch(/placeholder/i);
  });
});

describe('a connection that says sandbox but is not', () => {
  /**
   * Test Mode's guarantee is structural: a connection marked production is
   * replaced by an adapter that cannot reach the vendor. Marking a production
   * connection "Sandbox" turns that into a label.
   *
   * It is not a hypothetical misuse. Karbon publishes no sandbox host, so a
   * firm that wants the application to use Karbon at all while Test Mode is on
   * has exactly one route, and it is to tick the wrong box.
   */
  it('names Karbon production as production, whatever the label says', () => {
    const problem = describeSandboxMislabel({
      provider: 'KARBON',
      baseUrl: 'https://api.karbonhq.com/v3',
      isSandbox: true,
    });

    expect(problem).toMatch(/marked Sandbox but points at/i);
    expect(problem).toMatch(/could reach a real client record/i);
    // And it says what the honest setting costs, which is nothing: reads keep
    // working, so there is no reason left to mislabel it.
    expect(problem).toMatch(/prior-year documents still work/i);
  });

  it('says nothing when the label is honest', () => {
    expect(
      describeSandboxMislabel({ provider: 'KARBON', baseUrl: 'https://api.karbonhq.com/v3', isSandbox: false }),
    ).toBeNull();
  });

  it('says nothing about a host it has no grounds to judge', () => {
    // Adobe genuinely does offer separate accounts, so a shard host says
    // nothing about whether it is a sandbox. Guessing would train people to
    // ignore the warning.
    expect(
      describeSandboxMislabel({ provider: 'ADOBE_SIGN', baseUrl: 'https://api.na1.adobesign.com', isSandbox: true }),
    ).toBeNull();
    expect(
      describeSandboxMislabel({ provider: 'KARBON', baseUrl: 'https://karbon-proxy.internal.test', isSandbox: true }),
    ).toBeNull();
  });

  it('is not confused by a path, a port or casing on the base URL', () => {
    for (const baseUrl of [
      'https://API.KARBONHQ.COM/v3',
      'https://api.karbonhq.com',
      'https://api.karbonhq.com/v3/',
    ]) {
      expect(isKnownProductionHost('KARBON', baseUrl), baseUrl).toBe(true);
    }
  });

  it('treats an unparseable base URL as unknown rather than throwing', () => {
    expect(isKnownProductionHost('KARBON', 'not a url')).toBe(false);
    expect(isKnownProductionHost('KARBON', null)).toBe(false);
  });
});
