import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  diagnosePollingFailure,
  MAXIMUM_BACKOFF_MS,
} from '../../apps/worker/src/polling-failure';

/**
 * What the worker does when the queue cannot be reached.
 *
 * On a first deployment the schema does not exist until the web service has
 * migrated. Polling every two seconds against a missing table wrote the same
 * error hundreds of times, which buries the one line that says what is wrong.
 */

const POLL = 2_000;

describe('backing off', () => {
  it('costs a one-off blip nothing, waiting the ordinary interval', () => {
    expect(backoffDelay(POLL, 1)).toBe(POLL);
  });

  it('doubles while the failure persists', () => {
    expect(backoffDelay(POLL, 2)).toBe(4_000);
    expect(backoffDelay(POLL, 3)).toBe(8_000);
    expect(backoffDelay(POLL, 4)).toBe(16_000);
  });

  it('settles at a minute rather than growing without bound', () => {
    expect(backoffDelay(POLL, 10)).toBe(MAXIMUM_BACKOFF_MS);
    expect(backoffDelay(POLL, 1_000)).toBe(MAXIMUM_BACKOFF_MS);
  });

  it('never returns something a sleep cannot use, however absurd the count', () => {
    // 2 ** 1000 is Infinity, and sleeping forever is how a worker stops being a
    // worker without anything reporting it.
    for (const failures of [0, 1, 500, 5_000, Number.MAX_SAFE_INTEGER]) {
      const delay = backoffDelay(POLL, failures);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(MAXIMUM_BACKOFF_MS);
    }
  });
});

describe('saying what to do about it', () => {
  it('turns a missing table into "the web service has not migrated yet"', () => {
    const error = new Error('Raw query failed. Code: `42P01`. Message: `relation "background_job" does not exist`');
    expect(diagnosePollingFailure(error)).toMatch(/schema is not there yet/i);
    expect(diagnosePollingFailure(error)).toMatch(/web service applies migrations/i);
  });

  it('recognises the Prisma wording for the same fault', () => {
    const error = new Error('The table `public.background_job` does not exist in the current database.');
    expect(diagnosePollingFailure(error)).toMatch(/schema is not there yet/i);
  });

  it('separates an unreachable database from a missing schema, because the fix differs', () => {
    const error = new Error("Can't reach database server at `postgres.railway.internal:5432`");
    expect(diagnosePollingFailure(error)).toMatch(/unreachable/i);
    expect(diagnosePollingFailure(error)).toMatch(/DATABASE_URL/);
  });

  it('says nothing rather than guessing at a failure it does not recognise', () => {
    expect(diagnosePollingFailure(new Error('something else entirely'))).toBeNull();
  });

  it('handles a thrown non-error without itself throwing', () => {
    expect(diagnosePollingFailure('42P01 somewhere in a string')).toMatch(/schema is not there yet/i);
    expect(diagnosePollingFailure(undefined)).toBeNull();
    expect(diagnosePollingFailure(null)).toBeNull();
  });
});
