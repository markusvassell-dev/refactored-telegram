/**
 * Staying inside Karbon's documented request rate.
 *
 * Karbon asks for no more than 120 requests a minute per account per
 * application, and answers 429 with a `Retry-After` when that is exceeded. The
 * limit is easy to miss in ordinary use and impossible to miss during an annual
 * rollout: several hundred engagements, several calls each, drained by however
 * many workers are running.
 *
 * Exceeding it is not a slow request — it is a throttled account, shared with
 * whatever else the firm has connected to Karbon.
 *
 * A token bucket rather than a fixed window: a burst is fine as long as the
 * average holds, which is what "no more than 120 a minute" means and what a
 * per-second cap would needlessly forbid.
 */

export interface ThrottleOptions {
  /** Karbon's documented guidance. */
  requestsPerMinute?: number;
  /** Injected in tests so a limiter can be exercised without real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const KARBON_DOCUMENTED_REQUESTS_PER_MINUTE = 120;

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefill: number;
  /** Serialises waiters, so ten callers do not all wake on the same token. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ThrottleOptions = {}) {
    const perMinute = options.requestsPerMinute ?? KARBON_DOCUMENTED_REQUESTS_PER_MINUTE;
    if (perMinute <= 0) throw new Error('requestsPerMinute must be positive.');

    this.capacity = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = perMinute;
    this.lastRefill = this.now();
  }

  /** Resolves when it is this caller's turn to make a request. */
  async acquire(): Promise<void> {
    const turn = this.queue.then(() => this.take());
    // Failures must not poison the queue for everyone behind this caller.
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async take(): Promise<void> {
    this.refill();

    if (this.tokens < 1) {
      const deficit = 1 - this.tokens;
      await this.sleep(Math.ceil(deficit / this.refillPerMs));
      this.refill();
    }

    this.tokens -= 1;
  }

  private refill(): void {
    const moment = this.now();
    const elapsed = moment - this.lastRefill;
    if (elapsed <= 0) return;

    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = moment;
  }

  /** Test and diagnostic accessor. */
  get available(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * How long a `Retry-After` header asks us to wait, in milliseconds.
 *
 * The header is either delta-seconds or an HTTP-date (RFC 9110). Ignoring it
 * and backing off on our own schedule is how a throttled client keeps making
 * the throttling worse: Karbon has said exactly how long to wait, and a shorter
 * guess spends the retry budget without the limit having cleared.
 *
 * Returns null when the header is absent or unintelligible, so the caller falls
 * back to its own backoff rather than treating nonsense as "retry immediately".
 */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  if (header === null || header === undefined) return null;

  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  // delta-seconds. Integer only: "2.5" is not a valid Retry-After.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  // `Date.parse` is lenient to the point of being unsafe here: it reads "2.5"
  // as a date, in the past, which this function would then report as "retry
  // immediately" — the single worst answer to give a throttled client. An
  // HTTP-date always carries a month name, so require letters before trusting
  // it, and let anything else fall through to the caller's own backoff.
  if (!/[A-Za-z]/.test(trimmed)) return null;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  // A date already in the past means wait no longer.
  return Math.max(0, asDate - now);
}
