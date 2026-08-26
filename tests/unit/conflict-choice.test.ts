import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which candidate a reviewer chose, and where that value came from.
 *
 * The conflict form used to submit the value and its source as two separate
 * fields, with the source emitted as a hidden input *inside* the candidate
 * loop. Every candidate's source was therefore submitted, and the server read
 * the first one whichever radio was selected — so choosing the second value
 * resolved to the right value under the wrong source. Nothing threw. The
 * provenance line on the field and the `CONFLICT_RESOLVED` audit entry simply
 * reported the wrong origin for a value a person had deliberately chosen.
 *
 * These are source-text assertions rather than a rendered test because the
 * defect lived in the *shape of the form*, not in behaviour any unit could
 * observe: both fields were present and both parsed.
 */

const root = join(import.meta.dirname, '..', '..');
const workspace = readFileSync(join(root, 'apps/web/src/app/engagements/[id]/workspace.tsx'), 'utf8');
const actions = readFileSync(join(root, 'apps/web/src/app/actions.ts'), 'utf8');

describe('resolving a field conflict', () => {
  it('carries the source on the radio the browser submits, not beside it', () => {
    expect(workspace).toContain('name="chosen"');
    expect(workspace).toMatch(/value=\{`\$\{candidate\.source\}::\$\{candidate\.value\}`\}/);
  });

  it('no longer emits a per-candidate hidden source field', () => {
    // The exact shape of the defect: one hidden input per candidate, all
    // submitted, first one wins.
    expect(workspace).not.toContain('name="chosenSource"');
    expect(workspace).not.toContain('name="chosenValue"');
  });

  it('splits the source from the value server-side', () => {
    expect(actions).toContain("formData.get('chosen')");
    expect(actions).not.toContain("formData.get('chosenSource')");
  });
});
