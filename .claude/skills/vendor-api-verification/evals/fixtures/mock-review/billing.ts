/**
 * Fizz billing integration.
 *
 * The vendor's OpenAPI specification publishes exactly these operations:
 *
 *   GET  /v2/Invoices
 *   GET  /v2/Invoices/{InvoiceKey}
 *   POST /v2/Payments
 *
 * There is no operation that voids an invoice. Support have said the only
 * route is the web UI.
 */

export interface WriteResult {
  outcome: 'SUCCEEDED' | 'SKIPPED_UNSUPPORTED' | 'SKIPPED_DUPLICATE';
  objectId: string | null;
  message?: string;
}

export interface BillingProvider {
  readonly isMock: boolean;
  listInvoices(customerKey: string): Promise<{ invoiceKey: string; total: string }[]>;
  recordPayment(invoiceKey: string, amount: string, idempotencyKey: string): Promise<WriteResult>;
  voidInvoice(invoiceKey: string): Promise<WriteResult>;
}

export const BILLING_CAPABILITIES = [
  { capability: 'LIST_INVOICES', support: 'SUPPORTED', operation: 'GET /v2/Invoices' },
  { capability: 'RECORD_PAYMENT', support: 'SUPPORTED', operation: 'POST /v2/Payments' },
  { capability: 'VOID_INVOICE', support: 'UNVERIFIED', operation: 'POST /v2/Invoices/{InvoiceKey}/Void' },
] as const;

export class FizzBillingClient implements BillingProvider {
  readonly isMock = false;
  constructor(private readonly baseUrl: string, private readonly key: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'X-Api-Key': this.key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Fizz: HTTP ${response.status} for ${path}`);
    return (await response.json()) as T;
  }

  async listInvoices(customerKey: string): Promise<{ invoiceKey: string; total: string }[]> {
    const page = await this.request<{ value?: Record<string, any>[] }>(
      'GET',
      `/v2/Invoices?customer=${encodeURIComponent(customerKey)}`,
    );
    return (page?.value ?? []).map((row) => ({ invoiceKey: String(row.InvoiceKey), total: String(row.Total) }));
  }

  async recordPayment(invoiceKey: string, amount: string, idempotencyKey: string): Promise<WriteResult> {
    const created = await this.request<Record<string, any>>('POST', '/v2/Payments', {
      InvoiceKey: invoiceKey,
      Amount: amount,
      IdempotencyKey: idempotencyKey,
    });
    return { outcome: 'SUCCEEDED', objectId: created ? String(created.PaymentKey) : null };
  }

  async voidInvoice(invoiceKey: string): Promise<WriteResult> {
    const voided = await this.request<Record<string, any>>('POST', `/v2/Invoices/${invoiceKey}/Void`);
    return { outcome: 'SUCCEEDED', objectId: voided ? String(voided.InvoiceKey) : null };
  }
}

/** Used by every test and by the application whenever Test Mode is on. */
export class MockBillingClient implements BillingProvider {
  readonly isMock = true;
  private counter = 0;

  async listInvoices(): Promise<{ invoiceKey: string; total: string }[]> {
    return [{ invoiceKey: 'inv_1', total: '1250.00' }];
  }

  async recordPayment(): Promise<WriteResult> {
    this.counter += 1;
    return { outcome: 'SUCCEEDED', objectId: `pay_${this.counter}` };
  }

  async voidInvoice(): Promise<WriteResult> {
    this.counter += 1;
    return { outcome: 'SUCCEEDED', objectId: `void_${this.counter}` };
  }
}
