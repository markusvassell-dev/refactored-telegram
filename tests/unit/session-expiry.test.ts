import { describe, expect, it } from 'vitest';

/**
 * How long a session lasts.
 *
 * Sessions used to end a fixed eight hours after sign-in, so a reviewer part
 * way through a long document could be signed out by the clock rather than by
 * inactivity. They now slide: acting extends them, up to an absolute cap.
 *
 * The rule is arithmetic, so it is tested as arithmetic. The cookie mechanics
 * around it — `cookies().set` being permitted only in a Server Action, a Route
 * Handler or middleware — are Next.js's, and exercised by the end-to-end run
 * rather than pretended at here.
 */

const IDLE_SECONDS = 4 * 60 * 60;
const ABSOLUTE_SECONDS = 12 * 60 * 60;
const REFRESH_AFTER_SECONDS = IDLE_SECONDS / 2;

/** Mirrors `extendSession` in apps/web/src/lib/session.ts. */
function nextExpiry(session: { issuedAt: number; expiresAt: number }, now: number): number | null {
  if (session.issuedAt + ABSOLUTE_SECONDS <= now) return null;
  if (session.expiresAt - now > REFRESH_AFTER_SECONDS) return null;
  return Math.min(now + IDLE_SECONDS, session.issuedAt + ABSOLUTE_SECONDS);
}

/** Mirrors the expiry checks in `readSession`. */
function isLive(session: { issuedAt: number; expiresAt: number }, now: number): boolean {
  if (session.expiresAt < now) return false;
  if (session.issuedAt + ABSOLUTE_SECONDS <= now) return false;
  return true;
}

describe('extending a session', () => {
  const signedInAt = 1_000_000;
  const fresh = { issuedAt: signedInAt, expiresAt: signedInAt + IDLE_SECONDS };

  it('leaves a session alone while it is more than half unused', () => {
    // Rewriting the cookie on every action would mean a Set-Cookie on every
    // mutation for no benefit.
    const oneHourIn = signedInAt + 60 * 60;
    expect(nextExpiry(fresh, oneHourIn)).toBeNull();
  });

  it('extends a session past its halfway mark', () => {
    const threeHoursIn = signedInAt + 3 * 60 * 60;
    expect(nextExpiry(fresh, threeHoursIn)).toBe(threeHoursIn + IDLE_SECONDS);
  });

  it('slides more than once, which is the whole point', () => {
    // An idle window close to the absolute cap would let the cap bind on the
    // first refresh, so the session would never slide again — one extension
    // wearing the name of many. This asserts the ratio actually works.
    let session = { issuedAt: signedInAt, expiresAt: signedInAt + IDLE_SECONDS };
    const extensions: number[] = [];

    for (let hour = 3; hour <= 10; hour += 1) {
      const now = signedInAt + hour * 60 * 60;
      const next = nextExpiry(session, now);
      if (next !== null) {
        extensions.push(hour);
        session = { ...session, expiresAt: next };
      }
    }

    expect(extensions.length).toBeGreaterThan(2);
  });

  it('never extends beyond the absolute cap', () => {
    // A session that slides forever is not a session.
    const elevenHoursIn = signedInAt + 11 * 60 * 60;
    const extended = { issuedAt: signedInAt, expiresAt: elevenHoursIn + 30 * 60 };

    const result = nextExpiry(extended, elevenHoursIn);
    expect(result).toBe(signedInAt + ABSOLUTE_SECONDS);
    // One more hour, not another four.
    expect(result! - elevenHoursIn).toBe(60 * 60);
  });

  it('refuses to extend a session already past the cap', () => {
    const thirteenHoursIn = signedInAt + 13 * 60 * 60;
    expect(nextExpiry(fresh, thirteenHoursIn)).toBeNull();
  });
});

describe('reading a session', () => {
  const signedInAt = 1_000_000;

  it('accepts one inside both windows', () => {
    expect(isLive({ issuedAt: signedInAt, expiresAt: signedInAt + IDLE_SECONDS }, signedInAt + 60)).toBe(true);
  });

  it('refuses one that has gone idle', () => {
    const session = { issuedAt: signedInAt, expiresAt: signedInAt + IDLE_SECONDS };
    expect(isLive(session, signedInAt + IDLE_SECONDS + 1)).toBe(false);
  });

  it('refuses one past the cap even if its own expiry says otherwise', () => {
    // The cap is checked on read as well as on refresh, so a cookie carrying a
    // later expiry than the cap allows is still refused rather than trusted.
    const session = { issuedAt: signedInAt, expiresAt: signedInAt + 100 * 60 * 60 };
    expect(isLive(session, signedInAt + ABSOLUTE_SECONDS + 1)).toBe(false);
  });
});
