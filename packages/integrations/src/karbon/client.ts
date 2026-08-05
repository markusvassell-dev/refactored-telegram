import { IntegrationError, type Logger, createLogger } from '@element/shared';
import { KARBON_CAPABILITY_MATRIX } from './capabilities.js';
import type {
  CapabilityReport,
  KarbonClient,
  KarbonCommentRequest,
  KarbonDocument,
  KarbonProvider,
  KarbonTaskRequest,
  KarbonUploadRequest,
  KarbonWorkItem,
  KarbonWorkItemQuery,
  KarbonWriteResult,
} from './types.js';

/**
 * Karbon REST client.
 *
 * Implemented against Karbon's published v3 API shape. It has NOT been
 * exercised against a live Karbon tenant from this project — every capability
 * is reported as UNVERIFIED until someone runs the connectivity check on the
 * Integrations screen with real credentials.
 *
 * Authentication uses the documented pair of headers: a bearer access token
 * plus the application access key.
 */

export interface KarbonClientConfig {
  baseUrl: string;
  bearerToken: string;
  accessKey: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** When set the response is returned as raw bytes. */
  binary?: boolean;
  headers?: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class KarbonRestClient implements KarbonProvider {
  readonly name = 'karbon';
  readonly isMock = false;

  private readonly config: Required<Omit<KarbonClientConfig, 'logger' | 'fetchImpl'>> & {
    logger: Logger;
    fetchImpl: typeof fetch;
  };

  constructor(config: KarbonClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      bearerToken: config.bearerToken,
      accessKey: config.accessKey,
      timeoutMs: config.timeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 3,
      logger: config.logger ?? createLogger({ base: { integration: 'karbon' } }),
      fetchImpl: config.fetchImpl ?? fetch,
    };
  }

  capabilities(): CapabilityReport[] {
    return [...KARBON_CAPABILITY_MATRIX];
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const url = new URL(`${this.config.baseUrl}${options.path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await this.config.fetchImpl(url, {
          method: options.method ?? 'GET',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.config.bearerToken}`,
            AccessKey: this.config.accessKey,
            Accept: 'application/json',
            ...(options.body !== undefined && !(options.body instanceof FormData)
              ? { 'Content-Type': 'application/json' }
              : {}),
            ...options.headers,
          },
          body:
            options.body === undefined
              ? undefined
              : options.body instanceof FormData
                ? options.body
                : JSON.stringify(options.body),
        });

        if (response.status === 404) return null as T;

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
            await delay(backoffMs(attempt));
            continue;
          }
          throw new IntegrationError('Karbon', `HTTP ${response.status} for ${options.path}`, {
            retryable: RETRYABLE_STATUS.has(response.status),
            context: { status: response.status, path: options.path, detail: detail.slice(0, 500) },
          });
        }

        if (options.binary) return Buffer.from(await response.arrayBuffer()) as T;
        if (response.status === 204) return null as T;

        const text = await response.text();
        return (text ? JSON.parse(text) : null) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof IntegrationError && !error.retryable) throw error;
        if (attempt >= this.config.maxRetries) break;
        await delay(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw new IntegrationError('Karbon', `Request to ${options.path} failed after ${this.config.maxRetries} attempts`, {
      retryable: true,
      cause: lastError,
    });
  }

  async getClient(entityKey: string): Promise<KarbonClient | null> {
    const organization = await this.request<Record<string, unknown> | null>({
      path: `/Organizations/${encodeURIComponent(entityKey)}`,
    });
    if (organization) return mapOrganization(organization);

    const contact = await this.request<Record<string, unknown> | null>({
      path: `/Contacts/${encodeURIComponent(entityKey)}`,
    });
    return contact ? mapContactEntity(contact) : null;
  }

  async getWorkItem(workItemKey: string): Promise<KarbonWorkItem | null> {
    const raw = await this.request<Record<string, unknown> | null>({
      path: `/WorkItems/${encodeURIComponent(workItemKey)}`,
    });
    return raw ? mapWorkItem(raw) : null;
  }

  async searchWorkItems(query: KarbonWorkItemQuery): Promise<KarbonWorkItem[]> {
    const filters: string[] = [];
    if (query.clientKey) filters.push(`ClientKey eq '${escapeODataLiteral(query.clientKey)}'`);
    if (query.workType) filters.push(`WorkType eq '${escapeODataLiteral(query.workType)}'`);
    if (query.workStatus) filters.push(`WorkStatus eq '${escapeODataLiteral(query.workStatus)}'`);

    const response = await this.request<{ value?: Record<string, unknown>[] } | null>({
      path: '/WorkItems',
      query: {
        $filter: filters.length > 0 ? filters.join(' and ') : undefined,
        $top: query.limit ?? 100,
      },
    });

    const items = (response?.value ?? []).map(mapWorkItem);

    // Re-filter client-side: a tenant whose API ignores an unsupported $filter
    // must not cause us to act on the wrong work item.
    return items.filter((item) => {
      if (query.clientKey && item.clientKey !== query.clientKey) return false;
      if (query.workType && item.workType !== query.workType) return false;
      if (query.workStatus && item.workStatus !== query.workStatus) return false;
      if (query.title && !item.title.toLowerCase().includes(query.title.toLowerCase())) return false;
      if (query.year && !matchesYear(item, query.year)) return false;
      return true;
    });
  }

  async listDocuments(scope: { workItemKey?: string; entityKey?: string }): Promise<KarbonDocument[]> {
    const path = scope.workItemKey
      ? `/WorkItems/${encodeURIComponent(scope.workItemKey)}/Documents`
      : `/Contacts/${encodeURIComponent(scope.entityKey ?? '')}/Documents`;

    const response = await this.request<{ value?: Record<string, unknown>[] } | null>({ path });
    return (response?.value ?? []).map((raw) => ({
      documentId: String(raw.DocumentId ?? raw.Id ?? ''),
      fileName: String(raw.FileName ?? raw.Name ?? ''),
      workItemKey: scope.workItemKey ?? null,
      entityKey: scope.entityKey ?? null,
      byteSize: typeof raw.Size === 'number' ? raw.Size : null,
      mimeType: typeof raw.ContentType === 'string' ? raw.ContentType : null,
      uploadedAt: typeof raw.UploadedDate === 'string' ? raw.UploadedDate : null,
      uploadedBy: typeof raw.UploadedBy === 'string' ? raw.UploadedBy : null,
    }));
  }

  async downloadDocument(documentId: string): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    const content = await this.request<Buffer>({
      path: `/Documents/${encodeURIComponent(documentId)}/Content`,
      binary: true,
      headers: { Accept: 'application/octet-stream' },
    });

    return { content, fileName: documentId, mimeType: 'application/octet-stream' };
  }

  async uploadDocument(request: KarbonUploadRequest): Promise<KarbonWriteResult> {
    // Never overwrite an approved, signed, or certificate document.
    if (request.neverOverwrite) {
      const existing = await this.listDocuments({ workItemKey: request.workItemKey });
      const collision = existing.find((document) => document.fileName === request.fileName);
      if (collision) {
        return {
          outcome: 'SKIPPED_DUPLICATE',
          objectId: collision.documentId,
          message: `A document named "${request.fileName}" already exists on this work item and was not replaced.`,
        };
      }
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from(request.content)], { type: request.mimeType }),
      request.fileName,
    );

    const response = await this.request<Record<string, unknown> | null>({
      method: 'POST',
      path: `/WorkItems/${encodeURIComponent(request.workItemKey)}/Documents`,
      body: form,
      headers: { 'Idempotency-Key': request.idempotencyKey },
    });

    return { outcome: 'SUCCEEDED', objectId: response ? String(response.DocumentId ?? response.Id ?? '') : null };
  }

  async addComment(request: KarbonCommentRequest): Promise<KarbonWriteResult> {
    const response = await this.request<Record<string, unknown> | null>({
      method: 'POST',
      path: '/Notes',
      body: {
        Subject: 'Element Engagements',
        Body: request.body,
        RelatedEntityKey: request.workItemKey,
        RelatedEntityType: 'WorkItem',
      },
      headers: { 'Idempotency-Key': request.idempotencyKey },
    });

    return { outcome: 'SUCCEEDED', objectId: response ? String(response.NoteKey ?? response.Id ?? '') : null };
  }

  async createTask(request: KarbonTaskRequest): Promise<KarbonWriteResult> {
    try {
      const response = await this.request<Record<string, unknown> | null>({
        method: 'POST',
        path: `/WorkItems/${encodeURIComponent(request.workItemKey)}/Tasks`,
        body: {
          Name: request.title,
          Description: request.description,
          AssigneeEmail: request.assigneeEmail,
          DueDate: request.dueDate,
        },
        headers: { 'Idempotency-Key': request.idempotencyKey },
      });
      return { outcome: 'SUCCEEDED', objectId: response ? String(response.TaskKey ?? response.Id ?? '') : null };
    } catch (error) {
      // Task APIs are not available on every tenant. Fall back to a note so the
      // reviewer is still notified, and say plainly that we did so.
      if (error instanceof IntegrationError && !error.retryable) {
        const fallback = await this.addComment({
          workItemKey: request.workItemKey,
          body: `${request.title}\n\n${request.description ?? ''}`,
          idempotencyKey: `${request.idempotencyKey}_note`,
          assigneeEmail: request.assigneeEmail,
        });
        return {
          outcome: 'SKIPPED_UNSUPPORTED',
          objectId: fallback.objectId,
          message: 'Karbon task creation is unavailable on this tenant; a note was posted instead.',
        };
      }
      throw error;
    }
  }

  async completeTask(taskId: string): Promise<KarbonWriteResult> {
    await this.request({ method: 'PUT', path: `/Tasks/${encodeURIComponent(taskId)}`, body: { IsCompleted: true } });
    return { outcome: 'SUCCEEDED', objectId: taskId };
  }

  async updateWorkItemStatus(workItemKey: string, status: string): Promise<KarbonWriteResult> {
    await this.request({
      method: 'PUT',
      path: `/WorkItems/${encodeURIComponent(workItemKey)}`,
      body: { WorkStatus: status },
    });
    return { outcome: 'SUCCEEDED', objectId: workItemKey };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.request({ path: '/WorkItems', query: { $top: 1 } });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}

// ---------------------------------------------------------------------------

function backoffMs(attempt: number): number {
  const base = 2 ** attempt * 250;
  return base + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function matchesYear(item: KarbonWorkItem, year: number): boolean {
  const haystack = `${item.title} ${item.dueDate ?? ''} ${item.startDate ?? ''}`;
  return haystack.includes(String(year));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function mapWorkItem(raw: Record<string, unknown>): KarbonWorkItem {
  return {
    workItemKey: String(raw.WorkItemKey ?? raw.Key ?? ''),
    title: String(raw.Title ?? raw.Name ?? ''),
    clientKey: text(raw.ClientKey),
    clientName: text(raw.ClientName),
    workType: text(raw.WorkType),
    workStatus: text(raw.WorkStatus),
    assigneeEmail: text(raw.AssigneeEmail),
    dueDate: text(raw.DueDate),
    startDate: text(raw.StartDate),
    raw,
  };
}

function mapContacts(raw: Record<string, unknown>): KarbonClient['contacts'] {
  const list = Array.isArray(raw.Contacts) ? (raw.Contacts as Record<string, unknown>[]) : [];
  return list.map((contact) => ({
    contactKey: String(contact.ContactKey ?? contact.Key ?? ''),
    fullName: String(contact.FullName ?? contact.Name ?? ''),
    firstName: text(contact.FirstName),
    email: text(contact.EmailAddress) ?? text(contact.Email),
    telephone: text(contact.PhoneNumber) ?? text(contact.Phone),
    title: text(contact.JobTitle) ?? text(contact.Title),
    isPrimary: contact.IsPrimary === true,
  }));
}

function mapOrganization(raw: Record<string, unknown>): KarbonClient {
  const address = (raw.AddressLines ?? raw.Address ?? {}) as Record<string, unknown>;
  return {
    entityKey: String(raw.EntityKey ?? raw.OrganizationKey ?? raw.Key ?? ''),
    entityType: 'Organization',
    legalName: String(raw.FullName ?? raw.Name ?? ''),
    displayName: text(raw.PreferredName),
    businessNumber: text(raw.BusinessNumber) ?? text(raw.TaxNumber),
    addressLine1: text(address.AddressLine1),
    addressLine2: text(address.AddressLine2),
    city: text(address.City),
    province: text(address.StateProvinceCounty) ?? text(address.State),
    postalCode: text(address.ZipCode) ?? text(address.PostalCode),
    country: text(address.CountryCode) ?? text(address.Country),
    contacts: mapContacts(raw),
  };
}

function mapContactEntity(raw: Record<string, unknown>): KarbonClient {
  const address = (raw.AddressLines ?? raw.Address ?? {}) as Record<string, unknown>;
  return {
    entityKey: String(raw.EntityKey ?? raw.ContactKey ?? raw.Key ?? ''),
    entityType: 'Contact',
    legalName: String(raw.FullName ?? raw.Name ?? ''),
    displayName: text(raw.PreferredName),
    businessNumber: null,
    addressLine1: text(address.AddressLine1),
    addressLine2: text(address.AddressLine2),
    city: text(address.City),
    province: text(address.StateProvinceCounty) ?? text(address.State),
    postalCode: text(address.ZipCode) ?? text(address.PostalCode),
    country: text(address.CountryCode) ?? text(address.Country),
    contacts: [
      {
        contactKey: String(raw.ContactKey ?? raw.Key ?? ''),
        fullName: String(raw.FullName ?? raw.Name ?? ''),
        firstName: text(raw.FirstName),
        email: text(raw.EmailAddress) ?? text(raw.Email),
        telephone: text(raw.PhoneNumber),
        title: text(raw.JobTitle),
        isPrimary: true,
      },
    ],
  };
}
