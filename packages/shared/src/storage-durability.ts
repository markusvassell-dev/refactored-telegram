import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Whether anything on disk would be destroyed by a redeploy.
 *
 * On a container platform the filesystem is reclaimed when the container is
 * replaced, which happens on every deploy. A document store pointed at ordinary
 * container disk therefore loses everything in it, silently, on a schedule
 * nobody thinks of as a schedule.
 *
 * Working documents now live in Postgres rather than on that filesystem,
 * precisely because a volume could never solve this on a platform that runs the
 * web and the worker as separate services — Railway attaches a volume to one
 * service, so a volume on each is two separate disks and the files never meet.
 *
 * **So the question changed, and this used to ask the old one.** It reported on
 * whether a volume was mounted, which was the right question when documents were
 * files and is the wrong one now: no volume is the documented, recommended
 * configuration, and reporting it as a fault means a permanent warning nobody can
 * act on. What still has consequences is narrower — `DocumentStore.get` falls
 * back to the filesystem for references with no row, so files written *before*
 * storage moved into the database are the entire remaining exposure.
 *
 * The reading that matters is therefore both together: files present **and** a
 * disk that will not survive. Either alone is fine, and saying so is what makes
 * the warning worth reading when it does appear.
 *
 * Mounting is still a heuristic and still says so. A mounted volume is a
 * different filesystem from the root, so a differing device id means something is
 * mounted there. It cannot prove that thing is durable — a tmpfs would also
 * differ — but it reliably catches the case that actually happens, which is no
 * volume at all.
 */

export type StorageDurability = 'DURABLE' | 'EPHEMERAL' | 'UNKNOWN';

export interface StorageDurabilityReport {
  durability: StorageDurability;
  directory: string;
  /** Files still only on disk: leftovers from before storage moved into the database. */
  filesOnDisk: number;
  /** True when counting stopped at the cap, so `filesOnDisk` is a floor. */
  moreFiles: boolean;
  /**
   * Files exist **and** the disk does not survive a redeploy.
   *
   * The only bad reading, and the one every caller should gate on. `UNKNOWN` is
   * deliberately never at risk: an unreadable directory is a thing to say, not a
   * thing to raise an alarm about.
   */
  atRisk: boolean;
  /** Plain-language summary, safe to show an administrator. */
  detail: string;
}

/**
 * How many files are counted before the walk gives up.
 *
 * Bounded because the interesting case is also the large one: a directory the
 * process cannot write to is one where the purge has been silently failing, so
 * the tree may hold every file ever written there. Nothing here needs an exact
 * total — the decision is "any" versus "none", and a floor is enough to describe
 * it honestly.
 */
const FILE_COUNT_CAP = 200;

/** Files under `directory`, counted breadth-first and stopped at the cap. */
async function countFiles(directory: string): Promise<{ files: number; more: boolean }> {
  const queue = [directory];
  let files = 0;

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(join(current, entry.name));
        continue;
      }
      files += 1;
      if (files >= FILE_COUNT_CAP) return { files, more: true };
    }
  }

  return { files, more: false };
}

export async function inspectStorageDurability(directory: string): Promise<StorageDurabilityReport> {
  try {
    // Created if absent: a directory that does not exist yet is the normal
    // state of a fresh deployment, and its device id is what we need.
    await mkdir(directory, { recursive: true });

    const [here, root, counted] = await Promise.all([stat(directory), stat('/'), countFiles(directory)]);

    const durability: StorageDurability = here.dev === root.dev ? 'EPHEMERAL' : 'DURABLE';
    const atRisk = counted.files > 0 && durability === 'EPHEMERAL';
    const count = `${counted.more ? 'at least ' : ''}${counted.files} file${counted.files === 1 ? '' : 's'}`;

    if (counted.files === 0) {
      // The ordinary state, and it must read as ordinary. Whether a volume is
      // mounted is mentioned and then explicitly disclaimed, so nobody goes
      // looking for a setting to change.
      return {
        durability,
        directory,
        filesOnDisk: 0,
        moreFiles: false,
        atRisk: false,
        detail:
          `Nothing is stored in ${directory}. Every document is a database row and survives a redeploy, so ` +
          `whether this path is ${durability === 'DURABLE' ? 'on a mounted volume' : 'on container disk'} no longer decides anything.`,
      };
    }

    if (atRisk) {
      return {
        durability,
        directory,
        filesOnDisk: counted.files,
        moreFiles: counted.more,
        atRisk: true,
        detail:
          `${count} in ${directory} predate the move to database storage and sit on the container's own filesystem, ` +
          'not a mounted volume, so they are lost on the next deploy. Everything written since is a row rather than a ' +
          'file and is unaffected.',
      };
    }

    return {
      durability,
      directory,
      filesOnDisk: counted.files,
      moreFiles: counted.more,
      atRisk: false,
      detail:
        `${count} in ${directory} predate the move to database storage and are held on a mounted volume, ` +
        'so they survive a redeploy.',
    };
  } catch (error) {
    // Never a reason to fail a boot. Not knowing is reported as not knowing, and
    // is never treated as the bad reading — an unreadable directory that turns
    // into a red banner is the false alarm this rewrite exists to remove.
    return {
      durability: 'UNKNOWN',
      directory,
      filesOnDisk: 0,
      moreFiles: false,
      atRisk: false,
      detail: `Could not determine whether ${directory} is durable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
