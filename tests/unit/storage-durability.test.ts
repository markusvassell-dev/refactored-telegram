import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectStorageDurability } from '@element/shared';

/**
 * Whether stored documents survive a redeploy.
 *
 * "Attach a volume" was a line in the deployment guide, which is exactly the
 * kind of instruction that gets skipped — and nothing anywhere reported that it
 * had been. Every generated draft, and every signed engagement letter not yet
 * filed into Karbon, was then destroyed on the next deploy, silently.
 */

const made: string[] = [];

afterAll(async () => {
  for (const directory of made) await rm(directory, { recursive: true, force: true });
});

describe('inspecting the document store', () => {
  it('reports an ordinary directory as ephemeral', async () => {
    // The test process runs on the container's own filesystem, which is
    // precisely the misconfiguration this exists to catch.
    const directory = await mkdtemp(join(tmpdir(), 'durability-'));
    made.push(directory);

    const report = await inspectStorageDurability(directory);

    expect(report.durability).toBe('EPHEMERAL');
    expect(report.directory).toBe(directory);
  });

  it('says what will be lost and what to do, not just that something is wrong', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durability-'));
    made.push(directory);

    const report = await inspectStorageDurability(directory);

    expect(report.detail).toMatch(/lost on the next deploy/i);
    expect(report.detail).toMatch(/attach a volume/i);
    // The consequence that actually matters is named, because a lost draft can
    // be regenerated and a lost signed letter cannot.
    expect(report.detail).toMatch(/signed document/i);
  });

  it('creates the directory rather than reporting a fresh deployment as broken', async () => {
    // A path that does not exist yet is the normal state of a first boot, not
    // a fault, and must not read as one.
    const parent = await mkdtemp(join(tmpdir(), 'durability-'));
    made.push(parent);
    const directory = join(parent, 'not', 'yet', 'created');

    const report = await inspectStorageDurability(directory);

    expect(report.durability).toBe('EPHEMERAL');
    expect(report.detail).not.toMatch(/could not determine/i);
  });

  it('reports not knowing as not knowing, and never throws', async () => {
    // A boot must not fail because a heuristic could not run. An unreadable
    // path is a reason to say so, not a reason to take the service down.
    const report = await inspectStorageDurability('/proc/1/mem/impossible');

    expect(report.durability).toBe('UNKNOWN');
    expect(report.detail).toMatch(/could not determine/i);
  });
});
