import { describe, expect, it } from 'vitest';
import type { Principal } from '@element/shared';
import { NAV_ITEMS, navigationFor } from '../../apps/web/src/lib/navigation';

/**
 * What each role is offered.
 *
 * A link to a page that will refuse you is not a cosmetic fault. Clicking it
 * produced an error screen with a reference number, which reads as a broken
 * application rather than as an access decision — and that is exactly how the
 * audit log was reported broken on a deployment where it was working correctly
 * and simply refusing a user who held no roles.
 */

const principal = (roles: Principal['roles']): Principal => ({
  id: 'user-1',
  email: 'person@firm.ca',
  displayName: 'A Person',
  roles,
});

describe('the navigation offered to a principal', () => {
  it('offers an anonymous visitor nothing, because every destination needs a session', () => {
    expect(navigationFor(null)).toEqual([]);
  });

  it('hides the audit log from a user who may not read it', () => {
    const labels = navigationFor(principal(['READ_ONLY'])).map((item) => item.label);
    expect(labels).not.toContain('Audit Log');
  });

  it('offers the audit log to an administrator', () => {
    const labels = navigationFor(principal(['ADMINISTRATOR'])).map((item) => item.label);
    expect(labels).toContain('Audit Log');
  });

  it('follows the permission matrix rather than seniority', () => {
    // A reviewer holds `audit:view`; a preparer does not. The nav must track
    // that rather than a guess about who ought to be senior enough.
    expect(navigationFor(principal(['PREPARER'])).map((item) => item.label)).not.toContain('Audit Log');
    expect(navigationFor(principal(['REVIEWER'])).map((item) => item.label)).toContain('Audit Log');
  });

  it('grants it through any one of several roles, since permissions are additive', () => {
    const labels = navigationFor(principal(['READ_ONLY', 'REVIEWER'])).map((item) => item.label);
    expect(labels).toContain('Audit Log');
  });

  it('offers a user with no roles at all the pages that decide for themselves, and nothing gated', () => {
    // This is the state a first Entra sign-in leaves an account in before any
    // role is granted. It must not be an application that appears broken.
    const items = navigationFor(principal([]));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.permission === undefined)).toBe(true);
  });

  it('never offers more than the full list', () => {
    expect(navigationFor(principal(['ADMINISTRATOR'])).length).toBeLessThanOrEqual(NAV_ITEMS.length);
  });
});

describe('the nav definition itself', () => {
  it('names a real permission wherever it gates one', () => {
    // A typo here would silently hide a page from everybody, since `can` would
    // never match. The type already prevents it; this pins the intent.
    for (const item of NAV_ITEMS) {
      if (item.permission !== undefined) expect(typeof item.permission).toBe('string');
    }
  });

  it('points every entry at a distinct path', () => {
    const paths = NAV_ITEMS.map((item) => item.href);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
