/**
 * What to do when the queue cannot be reached.
 *
 * A queue that is unreachable is not a transient blip to retry at full speed.
 * On a first deployment the schema does not exist until the web service has
 * migrated, and polling every two seconds against a missing table writes the
 * same error hundreds of times — burying the one line that says what is wrong,
 * and costing real money in log ingestion for the privilege.
 */

/** Never wait longer than this between attempts; the queue may recover at any moment. */
export const MAXIMUM_BACKOFF_MS = 60_000;

/** While a failure persists, repeat it no more often than this. */
export const REPEAT_FAILURE_LOG_AFTER_MS = 5 * 60_000;

/**
 * Geometric, capped. The first failure waits the ordinary poll interval, so a
 * one-off blip costs nothing; a sustained outage settles at a minute.
 */
export function backoffDelay(pollIntervalMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures < 1) return pollIntervalMs;
  const exponent = Math.min(consecutiveFailures - 1, 31);
  return Math.min(pollIntervalMs * 2 ** exponent, MAXIMUM_BACKOFF_MS);
}

/**
 * Turns the database's own words into the operator's next action.
 *
 * `relation "background_job" does not exist` is accurate and tells a person
 * nothing about what to do. The two causes worth naming are the two that
 * actually happen on a first deployment.
 */
export function diagnosePollingFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('42P01') || message.includes('does not exist in the current database')) {
    return 'The schema is not there yet. The web service applies migrations; check its deploy log. This worker will keep waiting.';
  }

  if (message.includes("Can't reach database server") || message.includes('P1001')) {
    return 'The database is unreachable. Check that the database service is running and DATABASE_URL points at it.';
  }

  return null;
}
