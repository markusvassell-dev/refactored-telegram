/**
 * Which build is this?
 *
 * A verification run against a live tenant reported three failures that had
 * already been fixed and pushed. Nothing in its output said which code it was
 * running, so the failures read as facts about Karbon rather than as facts
 * about a container that had not been redeployed. Half an hour went into
 * re-diagnosing endpoints that were already correct on the branch.
 *
 * Railway injects these on every deploy from a connected repository. Nothing
 * here is a secret — a commit identifier and a branch name reveal nothing that
 * the deployment itself does not — and none of it is required: read locally, or
 * on a platform that sets none of them, this reports "unknown" rather than
 * inventing a version.
 */

export interface BuildIdentity {
  /** Short commit identifier, or null when the platform did not supply one. */
  commit: string | null;
  branch: string | null;
  deploymentId: string | null;
}

/** Commit identifiers are hexadecimal; anything else is not one. */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export function readBuildIdentity(source: Readonly<Record<string, string | undefined>> = process.env): BuildIdentity {
  const rawCommit = source.RAILWAY_GIT_COMMIT_SHA?.trim() ?? '';

  return {
    // Truncated to the seven characters a person actually compares. The full
    // value is in the platform's own deployment record either way.
    commit: COMMIT_PATTERN.test(rawCommit) ? rawCommit.slice(0, 7).toLowerCase() : null,
    branch: source.RAILWAY_GIT_BRANCH?.trim() || null,
    deploymentId: source.RAILWAY_DEPLOYMENT_ID?.trim() || null,
  };
}

/**
 * One line a person can compare against `git log` without interpreting it.
 *
 * When the platform supplies nothing this says so plainly. "unknown" is the
 * honest answer and it is also the useful one: it means whatever you are
 * looking at cannot be matched to a commit, which is itself worth knowing
 * before trusting the run.
 */
export function describeBuild(source: Readonly<Record<string, string | undefined>> = process.env): string {
  const { commit, branch } = readBuildIdentity(source);

  if (!commit) return 'unknown — this build reports no commit, so it cannot be matched against the repository';
  return branch ? `${commit} (${branch})` : commit;
}
