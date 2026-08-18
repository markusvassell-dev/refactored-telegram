import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectStorageDurability } from '@element/shared';

/**
 * Whether anything on disk would be destroyed by a redeploy.
 *
 * "Attach a volume" was a line in the deployment guide, which is exactly the
 * kind of instruction that gets skipped — and nothing anywhere reported that it
 * had been. Every generated draft, and every signed engagement letter not yet
 * filed into Karbon, was then destroyed on the next deploy, silently.
 *
 * Storage has since moved into Postgres, which changed the question. A missing
 * volume is now the documented configuration, so reporting it is a warning
 * nobody can act on — and one that appeared, in red, on a correctly configured
 * deployment. What still costs something is a file written *before* that move
 * and still only on disk.
 *
 * So the assertions below are all about the pairing: files present **and** a
 * disk that will not survive them. Either alone must be silent.
 */

const made: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'durability-'));
  made.push(directory);
  return directory;
}

afterAll(async () => {
  for (const directory of made) await rm(directory, { recursive: true, force: true });
});

describe('inspecting the document store', () => {
  it('reports an ordinary directory as ephemeral', async () => {
    // The test process runs on the container's own filesystem, which is
    // precisely the misconfiguration this exists to catch.
    const directory = await temporaryDirectory();

    const report = await inspectStorageDurability(directory);

    expect(report.durability).toBe('EPHEMERAL');
    expect(report.directory).toBe(directory);
  });

  it('says nothing is at risk when nothing is on disk', async () => {
    // The ordinary state of this deployment, and the one that used to raise a
    // red banner. Documents are rows; an empty directory on container disk is
    // not a fault and must not read as one.
    const directory = await temporaryDirectory();

    const report = await inspectStorageDurability(directory);

    expect(report.filesOnDisk).toBe(0);
    expect(report.atRisk).toBe(false);
    expect(report.detail).toMatch(/nothing is stored/i);
    expect(report.detail).toMatch(/database row/i);
    expect(report.detail).not.toMatch(/lost on the next deploy/i);
  });

  it('is at risk once a file is on a disk that will not survive', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'prior-year-letter.pdf'), 'not really a pdf');

    const report = await inspectStorageDurability(directory);

    expect(report.atRisk).toBe(true);
    expect(report.filesOnDisk).toBe(1);
    expect(report.detail).toMatch(/1 file /i);
    expect(report.detail).toMatch(/lost on the next deploy/i);
    // And still says what is not affected, so the reader can size it.
    expect(report.detail).toMatch(/unaffected/i);
  });

  it('counts files in nested directories', async () => {
    // The store groups files by scope, so everything real is a subdirectory
    // deep. A walk that only read the top level would report every populated
    // store as empty.
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'engagement-1', 'drafts'), { recursive: true });
    await writeFile(join(directory, 'engagement-1', 'drafts', 'a.docx'), 'a');
    await writeFile(join(directory, 'engagement-1', 'drafts', 'b.docx'), 'b');

    const report = await inspectStorageDurability(directory);

    expect(report.filesOnDisk).toBe(2);
    expect(report.atRisk).toBe(true);
  });

  it('stops counting at the cap and says the number is a floor', async () => {
    // The directory that cannot be written to is also the one where the purge
    // has been silently failing, so the populated case can be very large. An
    // unbounded walk on every boot is how a diagnostic becomes an outage.
    const directory = await temporaryDirectory();
    await Promise.all(
      Array.from({ length: 250 }, (_, index) => writeFile(join(directory, `file-${index}`), 'x')),
    );

    const report = await inspectStorageDurability(directory);

    expect(report.moreFiles).toBe(true);
    expect(report.filesOnDisk).toBeLessThan(250);
    expect(report.detail).toMatch(/at least/i);
  });

  it('creates the directory rather than reporting a fresh deployment as broken', async () => {
    // A path that does not exist yet is the normal state of a first boot, not
    // a fault, and must not read as one.
    const parent = await temporaryDirectory();
    const directory = join(parent, 'not', 'yet', 'created');

    const report = await inspectStorageDurability(directory);

    expect(report.durability).toBe('EPHEMERAL');
    expect(report.atRisk).toBe(false);
    expect(report.detail).not.toMatch(/could not determine/i);
  });

  it('reports not knowing as not knowing, never throws, and never alarms', async () => {
    // A boot must not fail because a heuristic could not run. An unreadable
    // path is a reason to say so, not a reason to take the service down — and
    // not a reason to tell an administrator their documents are about to go.
    const report = await inspectStorageDurability('/proc/1/mem/impossible');

    expect(report.durability).toBe('UNKNOWN');
    expect(report.atRisk).toBe(false);
    expect(report.detail).toMatch(/could not determine/i);
  });
});
