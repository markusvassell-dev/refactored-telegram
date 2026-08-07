import { mkdir, stat } from 'node:fs/promises';

/**
 * Whether stored documents will survive a redeploy.
 *
 * On a container platform the filesystem is reclaimed when the container is
 * replaced, which happens on every deploy. A document store pointed at ordinary
 * container disk therefore loses everything in it, silently, on a schedule
 * nobody thinks of as a schedule.
 *
 * For a generated draft that is survivable — it can be regenerated. For the
 * signed engagement letter recorded against an engagement it is not: that file
 * is the evidence a client agreed to a fee, and until the Karbon filing job has
 * run it exists nowhere else. "Attach a volume" is a line in the deployment
 * guide, which is exactly the kind of instruction that gets skipped, and
 * nothing anywhere reported that it had been.
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
          'Everything stored there — generated drafts, and any signed document not yet filed into Karbon — is lost on the next deploy. ' +
          'Attach a volume at this path on both the web and worker services.',
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
