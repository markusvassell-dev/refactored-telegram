import { describe, expect, it } from 'vitest';
import { AdobeSignRestClient, RateLimiter } from '@element/integrations';
import { resolveSignerIndices } from '@element/documents';

describe('the tags and the sets describe the same people', () => {
  it('matches signerN in the document to the Nth participant set in the request', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth/v2/refresh')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      sent.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.includes('transientDocuments')) {
        return new Response(JSON.stringify({ transientDocumentId: 'T' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'AGR' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na3.adobesign.com', clientId: 'c', clientSecret: 's', refreshToken: 'r',
      fetchImpl: impl, rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    const participants = [
      { role: 'TAXPAYER_2', email: 'two@x.test', name: 'Two', signingOrder: 2 },
      { role: 'FIRM_SIGNER', email: 'firm@x.test', name: 'Firm', signingOrder: 1 },
      { role: 'TAXPAYER_1', email: 'one@x.test', name: 'One', signingOrder: 2 },
    ];

    await client.createAgreement({
      pdf: Buffer.from('%PDF-1.4'), fileName: 'l.pdf', title: 'T', message: 'm', locale: 'en_CA',
      ccEmails: [], idempotencyKey: 'k', expiresInDays: 30, reminderEveryBusinessDays: 3,
      allowDelegation: false, authenticationMethod: 'EMAIL', engagementType: 'T1_JOINT',
      signers: participants.map((p) => ({ email: p.email, name: p.name, order: p.signingOrder, role: p.role as never })),
    });

    const body = sent.find((c) => c.url.endsWith('/agreements'))?.body as
      { participantSetsInfo: { memberInfos: { email: string }[] }[] };
    const emailByPosition = body.participantSetsInfo.map((s) => s.memberInfos[0]?.email);

    const indices = resolveSignerIndices(participants);
    for (const p of participants) {
      const index = indices.get(p.role) as number;
      expect(emailByPosition[index - 1]).toBe(p.email);
    }
  });
});
