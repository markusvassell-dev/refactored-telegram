import { describe, expect, it } from 'vitest';
import { evaluateExternalSignatureGate } from '@element/workflows';
import { ROLE_PERMISSIONS, can } from '@element/shared';

/**
 * What must be true before this application will record a signature it did not
 * collect.
 *
 * This is the one step in the workflow where a false record would be worth
 * making: it is the difference between a client having agreed to a fee and
 * somebody saying they did. The Adobe path has a vendor's audit trail behind
 * it. This path has a person's assertion and a file, so the preconditions
 * carry more weight here, not less.
 */

const VALID = {
  status: 'READY_TO_SEND' as const,
  hasApprovedPdf: true,
  hasInternalApprovalEvent: true,
  expectedSigners: [{ name: 'Dale Ziegeman', confirmed: true }],
  evidenceIsPdf: true,
  evidenceByteLength: 4096,
  signedOnIso: '2026-08-01',
  todayIso: '2026-08-07',
  hasOpenAdobeAgreement: false,
  reason: 'Signed in Acrobat because the Acrobat Sign licence is not bought yet.',
};

describe('recording a signature obtained elsewhere', () => {
  it('permits it when everything is in order', () => {
    const gate = evaluateExternalSignatureGate(VALID);
    expect(gate.blockers).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it('always warns that the signature was not collected here', () => {
    // Never silent, even on the happy path. Somebody reading the file later
    // must not have to infer it.
    expect(evaluateExternalSignatureGate(VALID).warnings.join(' ')).toMatch(/did not collect/i);
  });

  it('refuses anything that has not been through final approval', () => {
    // The bridge exists to skip Adobe, not to skip review.
    for (const status of ['DRAFT_READY', 'IN_REVIEW', 'APPROVED', 'CHANGES_REQUESTED'] as const) {
      const gate = evaluateExternalSignatureGate({ ...VALID, status });
      expect(gate.ok, status).toBe(false);
      expect(gate.blockers.join(' '), status).toMatch(/READY_TO_SEND/);
    }
  });

  it('refuses without an approved PDF or an internal approval', () => {
    expect(evaluateExternalSignatureGate({ ...VALID, hasApprovedPdf: false }).blockers.join(' ')).toMatch(
      /nothing that could have been signed/i,
    );
    expect(evaluateExternalSignatureGate({ ...VALID, hasInternalApprovalEvent: false }).blockers.join(' ')).toMatch(
      /internal approval/i,
    );
  });

  it('requires the signed document itself', () => {
    // An assertion with nothing behind it is not evidence.
    expect(evaluateExternalSignatureGate({ ...VALID, evidenceByteLength: 0 }).blockers.join(' ')).toMatch(
      /Attach the signed document/i,
    );
    expect(evaluateExternalSignatureGate({ ...VALID, evidenceIsPdf: false }).blockers.join(' ')).toMatch(/must be a PDF/i);
  });

  it('requires every named signer to be confirmed, not just one', () => {
    // The joint T1 case. One spouse signing is not the letter being signed,
    // and without this a half-signed letter reads as complete for ever after.
    const gate = evaluateExternalSignatureGate({
      ...VALID,
      expectedSigners: [
        { name: 'Dale Ziegeman', confirmed: true },
        { name: 'Robin Ziegeman', confirmed: false },
      ],
    });

    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toContain('Robin Ziegeman');
    expect(gate.blockers.join(' ')).not.toContain('Dale Ziegeman');
  });

  it('refuses when nobody is named as a signer at all', () => {
    expect(evaluateExternalSignatureGate({ ...VALID, expectedSigners: [] }).ok).toBe(false);
  });

  it('refuses while an Adobe agreement is still open', () => {
    // Two records of one signature that disagree about how it was obtained is
    // worse than either record alone.
    const gate = evaluateExternalSignatureGate({ ...VALID, hasOpenAdobeAgreement: true });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/already has an open Adobe Sign agreement/i);
  });

  it('requires a reason with something in it', () => {
    for (const reason of ['', '   ', 'n/a', 'because']) {
      expect(evaluateExternalSignatureGate({ ...VALID, reason }).ok, JSON.stringify(reason)).toBe(false);
    }
  });

  it('refuses a signature dated in the future', () => {
    const gate = evaluateExternalSignatureGate({ ...VALID, signedOnIso: '2026-08-08', todayIso: '2026-08-07' });
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/in the future/i);
  });

  it('accepts today, which is the commonest case', () => {
    expect(evaluateExternalSignatureGate({ ...VALID, signedOnIso: '2026-08-07', todayIso: '2026-08-07' }).ok).toBe(true);
  });

  it('warns but does not refuse a date long in the past', () => {
    // A letter genuinely can be signed in March and recorded in August. It is
    // worth a second look, not a refusal.
    const gate = evaluateExternalSignatureGate({ ...VALID, signedOnIso: '2026-03-01', todayIso: '2026-08-07' });
    expect(gate.ok).toBe(true);
    expect(gate.warnings.join(' ')).toMatch(/more than 90 days ago/i);
  });
});

describe('who may record a signature obtained elsewhere', () => {
  it('is only the people who could have authorised the send', () => {
    // Asserting a client signed is as consequential as authorising the send,
    // and here nobody else witnessed it.
    expect(can({ roles: ['PARTNER_OR_FINAL_APPROVER'] }, 'signing:record_external')).toBe(true);

    for (const role of ['READ_ONLY', 'PREPARER', 'REVIEWER'] as const) {
      expect(can({ roles: [role] }, 'signing:record_external'), role).toBe(false);
    }
  });

  it('is not granted by administering the system', () => {
    // Same rule the other client-facing approvals already follow: running the
    // application is not the same as binding a client to a fee.
    expect(ROLE_PERMISSIONS.ADMINISTRATOR).not.toContain('signing:record_external');
    expect(can({ roles: ['ADMINISTRATOR'] }, 'signing:record_external')).toBe(false);
  });
});
