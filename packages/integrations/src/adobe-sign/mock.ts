import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { NotFoundError, PreconditionError, sha256Hex } from '@element/shared';
import type {
  AdobeSignProvider,
  AdobeWebhookEvent,
  AgreementState,
  AgreementStatus,
  CreateAgreementRequest,
  CreateAgreementResult,
  SignerStatus,
} from './types.js';

/**
 * In-memory Adobe Acrobat Sign adapter.
 *
 * This is a MOCK — clearly labelled, no network calls, no real client is ever
 * contacted. It reproduces the behaviours the workflow depends on so the tests
 * genuinely exercise them:
 *
 *   - the deterministic idempotency key deduplicates agreement creation;
 *   - parallel signers (both T1 taxpayers) produce PARTIALLY_SIGNED;
 *   - a later-ordered firm signer is not notified until earlier signers finish;
 *   - decline, cancel and expiry are all reachable;
 *   - webhook payloads are signed and verified the same way.
 */

export interface MockAdobeOptions {
  webhookSecret?: string;
  /** Force agreement creation to fail once, to exercise safe retry. */
  failNextCreate?: boolean;
}

interface StoredAgreement {
  agreementId: string;
  idempotencyKey: string;
  title: string;
  status: AgreementStatus;
  pdfHash: string;
  signers: {
    email: string;
    name: string;
    role: CreateAgreementRequest['signers'][number]['role'];
    order: number;
    status: SignerStatus;
    signedAt?: string | null;
    viewedAt?: string | null;
  }[];
  createdAt: string;
  completedAt?: string | null;
  declineReason?: string | null;
}

export class MockAdobeSignProvider implements AdobeSignProvider {
  readonly name = 'adobe-sign-mock';
  readonly isMock = true;

  private agreements = new Map<string, StoredAgreement>();
  private byIdempotencyKey = new Map<string, string>();
  private eventCounter = 0;
  private failNextCreate: boolean;

  constructor(private readonly options: MockAdobeOptions = {}) {
    this.failNextCreate = options.failNextCreate ?? false;
  }

  async createAgreement(request: CreateAgreementRequest): Promise<CreateAgreementResult> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('Simulated transient Adobe Sign failure');
    }

    // A retry with the same deterministic key returns the existing agreement.
    const existingId = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existingId) {
      const existing = this.agreements.get(existingId);
      return { agreementId: existingId, status: existing?.status ?? 'OUT_FOR_SIGNATURE', deduplicated: true };
    }

    // Adobe agreement ids are globally unique; the mock mirrors that so two
    // adapter instances in the same database cannot collide.
    const agreementId = `mock-agreement-${randomUUID()}`;
    const orders = [...new Set(request.signers.map((signer) => signer.order))].sort((a, b) => a - b);
    const firstOrder = orders[0];

    const stored: StoredAgreement = {
      agreementId,
      idempotencyKey: request.idempotencyKey,
      title: request.title,
      status: 'OUT_FOR_SIGNATURE',
      pdfHash: sha256Hex(Buffer.from(request.pdf)),
      signers: request.signers.map((signer) => ({
        email: signer.email,
        name: signer.name,
        role: signer.role,
        order: signer.order,
        // Only the first participant set is notified initially.
        status: signer.order === firstOrder ? 'OUT_FOR_SIGNATURE' : 'WAITING_FOR_OTHERS',
        signedAt: null,
        viewedAt: null,
      })),
      createdAt: new Date().toISOString(),
      completedAt: null,
      declineReason: null,
    };

    this.agreements.set(agreementId, stored);
    this.byIdempotencyKey.set(request.idempotencyKey, agreementId);

    return { agreementId, status: 'OUT_FOR_SIGNATURE', deduplicated: false };
  }

  async getAgreement(agreementId: string): Promise<AgreementState | null> {
    const stored = this.agreements.get(agreementId);
    if (!stored) return null;
    return {
      agreementId,
      status: stored.status,
      signers: stored.signers.map((signer) => ({
        email: signer.email,
        role: signer.role,
        status: signer.status,
        signedAt: signer.signedAt ?? null,
        viewedAt: signer.viewedAt ?? null,
      })),
      createdAt: stored.createdAt,
      completedAt: stored.completedAt ?? null,
      declineReason: stored.declineReason ?? null,
    };
  }

  async cancelAgreement(agreementId: string, reason: string): Promise<void> {
    const stored = this.require(agreementId);
    stored.status = 'CANCELLED';
    stored.declineReason = reason;
  }

  async downloadSignedPdf(agreementId: string): Promise<Buffer> {
    const stored = this.require(agreementId);
    if (stored.status !== 'SIGNED' && stored.status !== 'COMPLETED') {
      throw new PreconditionError('The agreement is not signed yet, so no signed PDF exists.');
    }
    // A minimal but structurally valid PDF so downstream hashing and the
    // "is this really a PDF" check behave as they would in production.
    return mockPdf(`SIGNED AGREEMENT ${agreementId} (${stored.title})`);
  }

  async downloadAuditReport(agreementId: string): Promise<Buffer> {
    const stored = this.require(agreementId);
    return mockPdf(`SIGNING CERTIFICATE ${agreementId} (${stored.title})`);
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): boolean {
    const secret = this.options.webhookSecret;
    if (!secret) return false;
    const provided = headers['x-adobe-signature'] ?? '';
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Deliberately identical to `AdobeSignRestClient.parseWebhook`.
   *
   * A mock that parses a shape the real client does not is a test that proves
   * nothing about production. If the real parser changes, this must change with
   * it — the point is that a test exercising this exercises that.
   */
  parseWebhook(rawBody: string): AdobeWebhookEvent | null {
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const agreement = payload.agreement as Record<string, unknown> | undefined;
      const participant = payload.participantUser as Record<string, unknown> | undefined;

      return {
        eventId: String(payload.webhookNotificationId ?? payload.eventId ?? ''),
        eventType: String(payload.event ?? ''),
        agreementId: agreement ? String(agreement.id ?? '') : null,
        participantEmail: participant ? String(participant.email ?? '') : null,
        occurredAt: String(payload.eventDate ?? new Date().toISOString()),
        raw: payload,
      };
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'Mock adapter — no agreements are sent to real signers.' };
  }

  // ---- Simulation helpers used by tests -----------------------------------

  private require(agreementId: string): StoredAgreement {
    const stored = this.agreements.get(agreementId);
    if (!stored) throw new NotFoundError(`Adobe Sign agreement ${agreementId}`);
    return stored;
  }

  /** Marks one signer as having signed and recomputes the agreement status. */
  simulateSign(agreementId: string, email: string): AgreementState {
    const stored = this.require(agreementId);
    const signer = stored.signers.find((candidate) => candidate.email === email);
    if (!signer) throw new NotFoundError(`Signer ${email} on agreement ${agreementId}`);

    signer.status = 'SIGNED';
    signer.signedAt = new Date().toISOString();

    // Release the next participant set once every earlier one has signed.
    const outstandingOrders = stored.signers
      .filter((candidate) => candidate.status !== 'SIGNED')
      .map((candidate) => candidate.order);
    const nextOrder = outstandingOrders.length > 0 ? Math.min(...outstandingOrders) : null;

    for (const candidate of stored.signers) {
      if (candidate.status === 'WAITING_FOR_OTHERS' && candidate.order === nextOrder) {
        candidate.status = 'OUT_FOR_SIGNATURE';
      }
    }

    const allSigned = stored.signers.every((candidate) => candidate.status === 'SIGNED');
    const anySigned = stored.signers.some((candidate) => candidate.status === 'SIGNED');
    stored.status = allSigned ? 'COMPLETED' : anySigned ? 'PARTIALLY_SIGNED' : 'OUT_FOR_SIGNATURE';
    if (allSigned) stored.completedAt = new Date().toISOString();

    return this.stateOf(stored);
  }

  simulateView(agreementId: string, email: string): void {
    const signer = this.require(agreementId).signers.find((candidate) => candidate.email === email);
    if (signer && signer.status === 'OUT_FOR_SIGNATURE') {
      signer.status = 'VIEWED';
      signer.viewedAt = new Date().toISOString();
    }
  }

  simulateDecline(agreementId: string, email: string, reason: string): void {
    const stored = this.require(agreementId);
    const signer = stored.signers.find((candidate) => candidate.email === email);
    if (signer) signer.status = 'DECLINED';
    stored.status = 'DECLINED';
    stored.declineReason = reason;
  }

  simulateExpiry(agreementId: string): void {
    const stored = this.require(agreementId);
    stored.status = 'EXPIRED';
    for (const signer of stored.signers) {
      if (signer.status !== 'SIGNED') signer.status = 'EXPIRED';
    }
  }

  /** Builds a signed webhook payload, as Adobe would deliver it. */
  buildWebhook(
    agreementId: string,
    eventType: string,
    participantEmail?: string,
    eventId?: string,
  ): { body: string; headers: Record<string, string> } {
    this.eventCounter += 1;

    // Adobe's real payload shape: the notification id is `webhookNotificationId`
    // and both the agreement and the participant are nested objects.
    //
    // This used to emit a flat `{ eventId, agreementId, participantEmail }`,
    // which only the mock's own parser understood. Every webhook test therefore
    // exercised the mock parsing the mock, and the parser that runs in
    // production had nothing pointed at it — a payload shape mismatch would have
    // surfaced as agreementId: null on the first real delivery, and an event
    // carrying no agreement id is discarded.
    const body = JSON.stringify({
      webhookNotificationId: eventId ?? `mock-event-${this.eventCounter}`,
      event: eventType,
      agreement: { id: agreementId },
      participantUser: participantEmail ? { email: participantEmail } : undefined,
      eventDate: new Date().toISOString(),
    });

    const signature = this.options.webhookSecret
      ? createHmac('sha256', this.options.webhookSecret).update(body, 'utf8').digest('base64')
      : '';

    return { body, headers: { 'x-adobe-signature': signature } };
  }

  private stateOf(stored: StoredAgreement): AgreementState {
    return {
      agreementId: stored.agreementId,
      status: stored.status,
      signers: stored.signers.map((signer) => ({
        email: signer.email,
        role: signer.role,
        status: signer.status,
        signedAt: signer.signedAt ?? null,
        viewedAt: signer.viewedAt ?? null,
      })),
      createdAt: stored.createdAt,
      completedAt: stored.completedAt ?? null,
      declineReason: stored.declineReason ?? null,
    };
  }

  async findByExternalId(idempotencyKey: string): Promise<string | null> {
    return this.byIdempotencyKey.get(idempotencyKey) ?? null;
  }

  agreementCount(): number {
    return this.agreements.size;
  }

  /**
   * SHA-256 of the PDF an agreement was created from.
   *
   * Exists so a test can prove *which* rendered copy was uploaded. The draft and
   * the signature copy are both valid PDFs of the same letter, so a test that
   * only checks an agreement was created passes equally well when the untagged
   * draft is sent — which is exactly the defect that shipped.
   */
  uploadedPdfHash(agreementId: string): string | null {
    return this.agreements.get(agreementId)?.pdfHash ?? null;
  }
}

function mockPdf(title: string): Buffer {
  const content = `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n% ${title}\n`;
  return Buffer.from(`%PDF-1.4\n${content}trailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');
}

/** Refuses every send. Used when Test Mode is on with no sandbox configured. */
export class BlockedAdobeSignProvider implements AdobeSignProvider {
  readonly name = 'adobe-sign-blocked';
  readonly isMock = true;

  constructor(private readonly reason: string) {}

  async createAgreement(): Promise<CreateAgreementResult> {
    throw new PreconditionError(this.reason);
  }
  async findByExternalId(): Promise<string | null> {
    // Not "no agreement exists" — this adapter cannot look. Answering null would
    // tell the caller it is safe to create one.
    throw new PreconditionError(this.reason);
  }
  async getAgreement(): Promise<AgreementState | null> {
    return null;
  }
  async cancelAgreement(): Promise<void> {
    throw new PreconditionError(this.reason);
  }
  async downloadSignedPdf(): Promise<Buffer> {
    throw new PreconditionError(this.reason);
  }
  async downloadAuditReport(): Promise<Buffer> {
    throw new PreconditionError(this.reason);
  }
  verifyWebhook(): boolean {
    return false;
  }
  parseWebhook(): AdobeWebhookEvent | null {
    return null;
  }
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: this.reason };
  }
}
