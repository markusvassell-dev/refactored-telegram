import { describe, expect, it } from 'vitest';
import { MockAdobeSignProvider } from '@element/integrations';

/**
 * The mock's payload shape must be the one the real client parses.
 *
 * These two parsers were different. The mock emitted a flat
 * `{ eventId, agreementId, participantEmail }`; the real client reads
 * `webhookNotificationId`, `agreement.id` and `participantUser.email`. So every
 * webhook test exercised the mock parsing the mock, and the parser that runs in
 * production had nothing pointed at it.
 *
 * The failure that would have caused is quiet rather than loud: a shape mismatch
 * yields `agreementId: null`, and `processWebhook` discards an event carrying no
 * agreement id as unhandled. Signed letters would simply have stopped arriving,
 * with the webhook returning 200 each time.
 */

describe('the mock webhook payload', () => {
  const adobe = new MockAdobeSignProvider({ webhookSecret: 'shape-test-secret' });

  it('uses Adobe’s nested field names, not flattened ones', () => {
    const webhook = adobe.buildWebhook('agreement-123', 'AGREEMENT_WORKFLOW_COMPLETED', 'signer@example.test', 'evt-1');
    const payload = JSON.parse(webhook.body) as Record<string, unknown>;

    expect(payload.webhookNotificationId).toBe('evt-1');
    expect(payload.agreement).toEqual({ id: 'agreement-123' });
    expect(payload.participantUser).toEqual({ email: 'signer@example.test' });

    // The flat shape must be gone, or the real parser reads null from it.
    expect(payload.agreementId).toBeUndefined();
    expect(payload.participantEmail).toBeUndefined();
  });

  it('round-trips through the parser to a usable agreement id', () => {
    const webhook = adobe.buildWebhook('agreement-456', 'AGREEMENT_WORKFLOW_COMPLETED', undefined, 'evt-2');
    const event = adobe.parseWebhook(webhook.body);

    // An event with a null agreement id is discarded as unhandled, which is how
    // a mismatch would present: 200 responses and nothing ever filed.
    expect(event?.agreementId).toBe('agreement-456');
    expect(event?.eventId).toBe('evt-2');
  });
});

describe('finding an agreement Adobe already holds', () => {
  it('answers with the agreement created under that key', async () => {
    const adobe = new MockAdobeSignProvider({ webhookSecret: 'shape-test-secret' });

    const created = await adobe.createAgreement({
      idempotencyKey: 'key-abc',
      title: 'Test',
      pdf: Buffer.from('%PDF-1.4'),
      fileName: 'test.pdf',
      signers: [{ role: 'FIRM_SIGNER', name: 'A Partner', email: 'partner@firm.test', order: 1 }],
      ccEmails: [],
      expiresInDays: 30,
      reminderEveryBusinessDays: 3,
      locale: 'en_US',
      allowDelegation: false,
      authenticationMethod: 'EMAIL',
      engagementType: 'T2',
    });

    // The last defence against a client receiving two copies of the same
    // engagement letter: it existed on the REST client, documented as preventing
    // duplicates, and was never on the interface and never called.
    expect(await adobe.findByExternalId('key-abc')).toBe(created.agreementId);
    expect(await adobe.findByExternalId('key-never-used')).toBeNull();
  });
});
