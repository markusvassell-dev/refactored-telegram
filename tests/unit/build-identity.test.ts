import { describe, expect, it } from 'vitest';
import { describeBuild, readBuildIdentity } from '@element/shared';

/**
 * Knowing which build answered.
 *
 * This exists because a verification run against a live Karbon tenant reported
 * three failures that were already fixed and pushed. The container had not been
 * redeployed, and nothing in the output said so — so the failures were read as
 * facts about Karbon's API rather than facts about stale code.
 *
 * The one behaviour that matters: never claim a version it does not have.
 */

describe('reading the build a container is running', () => {
  it('reports the commit and branch the platform injected', () => {
    const identity = readBuildIdentity({
      RAILWAY_GIT_COMMIT_SHA: 'a35d3d937178a63bae057cc24681a31cc917da02',
      RAILWAY_GIT_BRANCH: 'claude/element-engagements-app-r29x46',
      RAILWAY_DEPLOYMENT_ID: 'dep-1',
    });

    expect(identity).toEqual({
      commit: 'a35d3d9',
      branch: 'claude/element-engagements-app-r29x46',
      deploymentId: 'dep-1',
    });
  });

  it('says unknown rather than inventing one when the platform supplies nothing', () => {
    // Locally, or on a platform that injects none of these. A health endpoint
    // that reported a plausible-looking version here would be worse than one
    // that reported nothing, because it would be believed.
    expect(readBuildIdentity({})).toEqual({
      commit: null,
      branch: null,
      deploymentId: null,
    });
    expect(describeBuild({})).toMatch(/unknown/i);
  });

  it('refuses a value that is not a commit identifier', () => {
    // A build argument left as a placeholder, or a branch name landing in the
    // wrong variable. Neither is a commit, and neither should be shown as one.
    for (const value of ['', '   ', 'HEAD', 'latest', '$RAILWAY_GIT_COMMIT_SHA', 'refs/heads/main']) {
      expect(readBuildIdentity({ RAILWAY_GIT_COMMIT_SHA: value }).commit).toBeNull();
    }
  });

  it('describes a build in one line a person can compare against git log', () => {
    expect(
      describeBuild({
        RAILWAY_GIT_COMMIT_SHA: 'A35D3D937178A63BAE057CC24681A31CC917DA02',
        RAILWAY_GIT_BRANCH: 'main',
      }),
    ).toBe('a35d3d9 (main)');
  });

  it('still names the commit when no branch was supplied', () => {
    expect(describeBuild({ RAILWAY_GIT_COMMIT_SHA: 'abc1234' })).toBe('abc1234');
  });
});
