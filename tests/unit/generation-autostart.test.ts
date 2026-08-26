import { describe, expect, it, vi } from 'vitest';
import { maybeStartGeneration } from '@element/services';

/**
 * Generating the draft once preparation finishes.
 *
 * Preparation used to stop and wait for somebody to press Generate, under an
 * explicit rule that a person confirms before a letter exists. The rule was
 * changed deliberately so an unattended Karbon rollover leaves a finished
 * draft — and the thing that makes that safe is that the automatic path
 * consults exactly the gate the button consults. These assertions are about
 * that: not that it generates, but that it refuses for the same reasons.
 */

function deps(overrides: {
  status?: string;
  gateOk?: boolean;
  blockers?: string[];
  deduplicated?: boolean;
}) {
  const enqueue = vi.fn().mockResolvedValue({ jobId: 'job-1', deduplicated: overrides.deduplicated ?? false });

  return {
    enqueue,
    deps: {
      prisma: {
        engagement: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ clientId: 'client-1', engagementType: 'T2', taxYear: 2026 }),
        },
        documentVersion: { count: vi.fn().mockResolvedValue(0) },
      },
      queue: { enqueue },
      workflow: { currentStatus: vi.fn().mockResolvedValue(overrides.status ?? 'SOURCE_DOCUMENT_REVIEW_REQUIRED') },
      generation: {
        evaluateGate: vi.fn().mockResolvedValue({
          ok: overrides.gateOk ?? true,
          blockers: overrides.blockers ?? [],
          warnings: [],
        }),
      },
    } as never,
  };
}

describe('starting generation by itself', () => {
  it('enqueues the letter once the gate passes', async () => {
    const { deps: d, enqueue } = deps({ gateOk: true });

    const outcome = await maybeStartGeneration(d, 'engagement-1', 'corr-1');

    expect(outcome.started).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      jobType: 'GENERATE_ENGAGEMENT_LETTER',
      engagementId: 'engagement-1',
    });
  });

  it('refuses for the gate’s own reasons rather than generating anyway', async () => {
    // The whole safety of the automatic path. A fee awaiting approval or an
    // unconfirmed compilation answer must stop an unattended render exactly as
    // it stops a person, and the reason has to survive so the workspace can
    // show it.
    const { deps: d, enqueue } = deps({
      gateOk: false,
      blockers: ['A confirmed fee is required for: T2_PREPARATION.'],
    });

    const outcome = await maybeStartGeneration(d, 'engagement-1');

    expect(outcome.started).toBe(false);
    expect(outcome.reason).toMatch(/confirmed fee/i);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not render over an engagement that has moved on', async () => {
    // A person may have taken the engagement somewhere deliberate since
    // preparation ran. Re-rendering underneath them is not a repair.
    const { deps: d, enqueue } = deps({ status: 'IN_REVIEW' });

    const outcome = await maybeStartGeneration(d, 'engagement-1');

    expect(outcome.started).toBe(false);
    expect(outcome.reason).toMatch(/IN_REVIEW/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports a duplicate as not started, so nothing reads it as a second draft', async () => {
    const { deps: d } = deps({ deduplicated: true });

    const outcome = await maybeStartGeneration(d, 'engagement-1');

    expect(outcome.started).toBe(false);
    expect(outcome.reason).toMatch(/already being generated/i);
  });
});
