import { describe, expect, it } from 'vitest';
import { karbonStatusTriggerSchema } from '../../packages/services/src/settings';

/**
 * What a Karbon status trigger is allowed to say.
 *
 * `engagementType` sat in this shape for a long time, declared and read by
 * nothing. It now decides **which legal document type gets created** when a
 * work item reaches a status — a T2 corporate letter or a T1 personal one — so
 * a value that is not one of the four must disable that trigger rather than
 * fall through to a default. A trigger that quietly creates the wrong kind of
 * engagement is worse than one that does nothing.
 */
describe('karbonStatusTriggerSchema', () => {
  it('accepts a complete trigger', () => {
    const parsed = karbonStatusTriggerSchema.parse({
      workType: 'Corporate year end',
      status: 'Ready for engagement letter',
      engagementType: 'T2',
    });

    expect(parsed).toEqual({
      workType: 'Corporate year end',
      status: 'Ready for engagement letter',
      engagementType: 'T2',
    });
  });

  it('treats a missing work type as "any work type"', () => {
    expect(karbonStatusTriggerSchema.parse({ status: 'Ready', engagementType: 'T1_SINGLE' }).workType).toBe('');
    expect(
      karbonStatusTriggerSchema.parse({ workType: null, status: 'Ready', engagementType: 'T1_SINGLE' }).workType,
    ).toBe('');
  });

  it('refuses an engagement type that is not one of the four', () => {
    expect(karbonStatusTriggerSchema.safeParse({ status: 'Ready', engagementType: 'T4' }).success).toBe(false);
    expect(karbonStatusTriggerSchema.safeParse({ status: 'Ready', engagementType: 't2' }).success).toBe(false);
    expect(karbonStatusTriggerSchema.safeParse({ status: 'Ready' }).success).toBe(false);
  });

  it('refuses a trigger with no status, which would match nothing or everything', () => {
    expect(karbonStatusTriggerSchema.safeParse({ status: '', engagementType: 'T2' }).success).toBe(false);
    expect(karbonStatusTriggerSchema.safeParse({ status: '   ', engagementType: 'T2' }).success).toBe(false);
  });

  it('trims, so a pasted status with a trailing space still matches', () => {
    expect(karbonStatusTriggerSchema.parse({ status: '  Ready  ', engagementType: 'T2' }).status).toBe('Ready');
  });
});
