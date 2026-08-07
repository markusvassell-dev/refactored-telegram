import { mkdir, stat } from 'node:fs/promises';

/**
 * Whether stored documents will survive a redeploy.
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
 * What remains is a migration concern: anything written before that change is
 * still only on disk, and is still lost on the next deploy if no volume holds
 * it. Reported rather than left to be discovered.
 *
 * The check is a heuristic and says so. A mounted volume is a different
 * filesystem from the root, so a differing device id means something is mounted
 * there. It cannot prove that thing is durable — a tmpfs would also differ —
 * but it reliably catches the case that actually happens, which is no volume at
 * all.
 */

export type StorageDurability = 'DURABLE' | 'EPHEMERAL' | 'UNKNOWN';

export interface StorageDurabilityReport {
  durability: StorageDurability;
  directory: string;
  /** Plain-language summary, safe to show an administrator. */
  detail: string;
}

export async function inspectStorageDurability(directory: string): Promise<StorageDurabilityReport> {
  try {
    // Created if absent: a directory that does not exist yet is the normal
    // state of a fresh deployment, and its device id is what we need.
    await mkdir(directory, { recursive: true });

    const [here, root] = await Promise.all([stat(directory), stat('/')]);

    if (here.dev === root.dev) {
      return {
        durability: 'EPHEMERAL',
        directory,
        detail:
          `${directory} is on the container's own filesystem, not a mounted volume. ` +
          'Documents written since this deployment moved storage into the database are unaffected — they are rows, not files. ' +
          'Anything written before that, and still only on disk, is lost on the next deploy.',
      };
    }

    return {
      durability: 'DURABLE',
      directory,
      detail: `${directory} is on a mounted volume, so stored documents survive a redeploy.`,
    };
  } catch (error) {
    // Never a reason to fail a boot. Not knowing is reported as not knowing.
    return {
      durability: 'UNKNOWN',
      directory,
      detail: `Could not determine whether ${directory} is durable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
