import { describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS,
  ROLES,
  adobeAgreementIdempotencyKey,
  assertCan,
  assertSeparationOfDuties,
  bulkRolloutIdempotencyKey,
  can,
  coverLetterIdempotencyKey,
  generationIdempotencyKey,
  karbonUploadIdempotencyKey,
  permissionsFor,
  sourceDocumentFingerprint,
  webhookEventIdempotencyKey,
} from '@element/shared';

describe('role permissions', () => {
  const preparer = { roles: ['PREPARER'] as const };
  const reviewer = { roles: ['REVIEWER'] as const };
  const partner = { roles: ['PARTNER_OR_FINAL_APPROVER'] as const };
  const administrator = { roles: ['ADMINISTRATOR'] as const };
  const readOnly = { roles: ['READ_ONLY'] as const };

  it('lets a read-only user view but never change anything', () => {
    expect(can(readOnly, 'engagement:view')).toBe(true);
    expect(can(readOnly, 'document:view')).toBe(true);

    for (const permission of ['generation:start', 'field:edit_structured', 'document:approve_final', 'signing:send'] as const) {
      expect(can(readOnly, permission), permission).toBe(false);
    }
  });

  it('lets a preparer generate but never send or approve', () => {
    expect(can(preparer, 'generation:start')).toBe(true);
    expect(can(preparer, 'review:submit')).toBe(true);
    expect(can(preparer, 'signing:send')).toBe(false);
    expect(can(preparer, 'document:approve_final')).toBe(false);
    expect(can(preparer, 'wording:approve')).toBe(false);
  });

  it('lets a reviewer edit and request changes but not approve wording exceptions', () => {
    expect(can(reviewer, 'review:request_changes')).toBe(true);
    expect(can(reviewer, 'cover_letter:edit')).toBe(true);
    expect(can(reviewer, 'wording:approve')).toBe(false);
    expect(can(reviewer, 'fee:approve_decrease')).toBe(false);
    expect(can(reviewer, 'signing:send')).toBe(false);
  });

  it('gives a partner the elevated approvals', () => {
    for (const permission of [
      'wording:approve',
      'fee:approve_decrease',
      'fee:approve_high_increase',
      'document:approve_final',
      'cover_letter:approve',
      'signing:send',
    ] as const) {
      expect(can(partner, permission), permission).toBe(true);
    }
  });

  it('does not let an administrator approve or send client-facing documents', () => {
    // Managing the system is not the same as approving legal documents.
    expect(can(administrator, 'template:manage')).toBe(true);
    expect(can(administrator, 'user:manage')).toBe(true);
    expect(can(administrator, 'job:retry')).toBe(true);

    expect(can(administrator, 'document:approve_final')).toBe(false);
    expect(can(administrator, 'signing:send')).toBe(false);
    expect(can(administrator, 'cover_letter:approve')).toBe(false);
    expect(can(administrator, 'wording:approve')).toBe(false);
  });

  it('combines permissions additively across roles', () => {
    const both = { roles: ['ADMINISTRATOR', 'PARTNER_OR_FINAL_APPROVER'] as const };
    expect(can(both, 'user:manage')).toBe(true);
    expect(can(both, 'signing:send')).toBe(true);
  });

  it('throws a helpful error when a permission is missing', () => {
    expect(() => assertCan(preparer, 'signing:send')).toThrow(/does not permit/i);
  });

  it('grants no permissions for an empty role list', () => {
    expect(permissionsFor([]).size).toBe(0);
  });

  it('defines permissions for every role', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role].length, role).toBeGreaterThan(0);
    }
  });
});

describe('separation of duties', () => {
  it('stops a user approving their own work', () => {
    expect(() =>
      assertSeparationOfDuties({ approverId: 'user-1', authorId: 'user-1', subject: 'wording change' }),
    ).toThrow(/cannot approve your own wording change/i);
  });

  it('allows a different person to approve', () => {
    expect(() =>
      assertSeparationOfDuties({ approverId: 'user-2', authorId: 'user-1', subject: 'document' }),
    ).not.toThrow();
  });

  it('allows approval when the author is unknown', () => {
    expect(() => assertSeparationOfDuties({ approverId: 'user-1', authorId: null, subject: 'document' })).not.toThrow();
  });
});

describe('idempotency keys', () => {
  const generationInput = {
    clientId: 'client-1',
    engagementType: 'T2' as const,
    taxYear: 2026,
    documentType: 'T2_ENGAGEMENT_LETTER' as const,
  };

  it('is deterministic for the same logical operation', () => {
    expect(generationIdempotencyKey(generationInput)).toBe(generationIdempotencyKey(generationInput));
  });

  it('differs when any input differs', () => {
    const base = generationIdempotencyKey(generationInput);
    expect(generationIdempotencyKey({ ...generationInput, taxYear: 2027 })).not.toBe(base);
    expect(generationIdempotencyKey({ ...generationInput, clientId: 'client-2' })).not.toBe(base);
    expect(generationIdempotencyKey({ ...generationInput, attempt: 2 })).not.toBe(base);
  });

  it('binds an Adobe agreement to the exact approved version and attempt', () => {
    const input = {
      clientId: 'client-1',
      engagementType: 'T2' as const,
      taxYear: 2026,
      approvedDocumentVersionId: 'version-1',
      signingAttempt: 1,
    };

    // A transport retry produces the same key, so no duplicate agreement.
    expect(adobeAgreementIdempotencyKey(input)).toBe(adobeAgreementIdempotencyKey(input));

    // A genuinely new attempt or a new approved version produces a new key.
    expect(adobeAgreementIdempotencyKey({ ...input, signingAttempt: 2 })).not.toBe(adobeAgreementIdempotencyKey(input));
    expect(adobeAgreementIdempotencyKey({ ...input, approvedDocumentVersionId: 'version-2' })).not.toBe(
      adobeAgreementIdempotencyKey(input),
    );
  });

  it('separates uploads by file role', () => {
    const base = { targetKey: 'WI-1', documentVersionId: 'v1' };
    expect(karbonUploadIdempotencyKey({ ...base, fileRole: 'SIGNED_PDF' })).not.toBe(
      karbonUploadIdempotencyKey({ ...base, fileRole: 'SIGNING_CERTIFICATE' }),
    );
  });

  it('de-duplicates webhook events by provider event id', () => {
    expect(webhookEventIdempotencyKey('adobe', 'evt-1')).toBe(webhookEventIdempotencyKey('adobe', 'evt-1'));
    expect(webhookEventIdempotencyKey('adobe', 'evt-1')).not.toBe(webhookEventIdempotencyKey('karbon', 'evt-1'));
  });

  it('gives each taxpayer their own cover-letter key', () => {
    const base = {
      engagementId: 'e1',
      documentType: 'T1_COVER_LETTER' as const,
      sourceDocumentFingerprint: 'abc',
    };
    expect(coverLetterIdempotencyKey({ ...base, participantId: 'p1' })).not.toBe(
      coverLetterIdempotencyKey({ ...base, participantId: 'p2' }),
    );
  });

  it('changes the bulk key per batch so a new rollout is not deduplicated', () => {
    const base = { clientId: 'c1', taxYear: 2026, documentType: 'T2_ENGAGEMENT_LETTER' as const };
    expect(bulkRolloutIdempotencyKey({ ...base, batchId: 'b1' })).not.toBe(
      bulkRolloutIdempotencyKey({ ...base, batchId: 'b2' }),
    );
  });

  it('separates two years of the same client, which a batch could otherwise collide', () => {
    const base = { batchId: 'b1', clientId: 'c1', documentType: 'T2_ENGAGEMENT_LETTER' as const };
    expect(bulkRolloutIdempotencyKey({ ...base, taxYear: 2025 })).not.toBe(
      bulkRolloutIdempotencyKey({ ...base, taxYear: 2026 }),
    );
  });
});

describe('source document fingerprint', () => {
  it('is stable regardless of ordering', () => {
    const a = sourceDocumentFingerprint([
      { id: '2', fileHash: 'bbb' },
      { id: '1', fileHash: 'aaa' },
    ]);
    const b = sourceDocumentFingerprint([
      { id: '1', fileHash: 'aaa' },
      { id: '2', fileHash: 'bbb' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when any document changes', () => {
    const before = sourceDocumentFingerprint([{ id: '1', fileHash: 'aaa' }]);
    expect(sourceDocumentFingerprint([{ id: '1', fileHash: 'ccc' }])).not.toBe(before);
    expect(sourceDocumentFingerprint([{ id: '1', fileHash: 'aaa' }, { id: '2', fileHash: 'bbb' }])).not.toBe(before);
  });
});
