import { describe, expect, it } from 'vitest';
import { ADOBE_OAUTH_SCOPES, adobeWebHostFor } from '@element/services';

/**
 * Sending an administrator to the right place to authorise this application.
 *
 * Adobe splits its hosts: tokens are exchanged on `api.<shard>.adobesign.com`,
 * but a human consents on `secure.<shard>.adobesign.com`. Sending someone to
 * the API host gives a blank page or a 404 rather than a consent screen — and
 * getting the shard wrong produces an authorisation against the wrong region,
 * which then fails in a way that reads exactly like a bad client secret.
 */

describe('finding the host a person authorises on', () => {
  it('turns each API host into its matching consent host', () => {
    expect(adobeWebHostFor('https://api.na1.adobesign.com')).toBe('https://secure.na1.adobesign.com');
    expect(adobeWebHostFor('https://api.na2.adobesign.com')).toBe('https://secure.na2.adobesign.com');
    expect(adobeWebHostFor('https://api.eu1.adobesign.com')).toBe('https://secure.eu1.adobesign.com');
    expect(adobeWebHostFor('https://api.jp1.adobesign.com')).toBe('https://secure.jp1.adobesign.com');
  });

  it('keeps the shard, because the wrong region fails like a bad credential', () => {
    // The failure this prevents is the expensive one: an authorisation issued
    // against na1 while the account lives on eu1 produces an unhelpful error
    // and hours spent re-checking a client secret that was always fine.
    expect(adobeWebHostFor('https://api.eu2.adobesign.com')).toContain('eu2');
    expect(adobeWebHostFor('https://api.eu2.adobesign.com')).not.toContain('na1');
  });

  it('ignores a path or a trailing slash on the stored base URL', () => {
    expect(adobeWebHostFor('https://api.na1.adobesign.com/')).toBe('https://secure.na1.adobesign.com');
    expect(adobeWebHostFor('https://api.na1.adobesign.com/api/rest/v6')).toBe('https://secure.na1.adobesign.com');
  });

  it('leaves a host that is not an api host alone rather than mangling it', () => {
    // A sandbox or a proxy may not follow the api./secure. convention. Rewriting
    // blindly would send somebody somewhere that does not exist.
    expect(adobeWebHostFor('https://secure.na1.adobesign.com')).toBe('https://secure.na1.adobesign.com');
    expect(adobeWebHostFor('https://adobe-proxy.internal.test')).toBe('https://adobe-proxy.internal.test');
  });
});

describe('the scopes this application asks for', () => {
  it('asks for exactly what it uses, and all of them scoped to itself', () => {
    // `:account` would additionally cover agreements people sent by hand from
    // Adobe's own UI. This never reads those, and asking would require a
    // separate account-administrator approval — a higher bar for no benefit.
    expect([...ADOBE_OAUTH_SCOPES]).toEqual([
      'agreement_read:self',
      'agreement_write:self',
      'agreement_send:self',
      'webhook_write:self',
    ]);

    // Asking for a scope nothing calls is the opposite of least privilege.
    // `user_read:self` was requested for a connection test that read
    // `/users/me` — a check that was green whenever the token could read a
    // user profile, which is not something this application ever does. The
    // test now reads agreements, and the scope has no caller left.
    expect([...ADOBE_OAUTH_SCOPES]).not.toContain('user_read:self');

    for (const scope of ADOBE_OAUTH_SCOPES) {
      expect(scope, scope).toMatch(/:self$/);
    }
  });
});
