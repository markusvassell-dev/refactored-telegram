import { IntegrationError, type Logger, createLogger } from '@element/shared';
import { KARBON_CAPABILITY_MATRIX } from './capabilities.js';
import { KARBON_DOCUMENTED_REQUESTS_PER_MINUTE, RateLimiter, retryAfterMs } from '../http/throttle.js';
import type {
  CapabilityReport,
  KarbonClient,
  KarbonCommentRequest,
  KarbonDocument,
  KarbonEntityType,
  KarbonFileList,
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
  /**
   * Karbon documents no more than 120 requests a minute per account per
   * application. Lower it when a firm runs other integrations against the same
   * account, since the budget is shared.
   */
  requestsPerMinute?: number;
  /** Shared across clients when one is supplied, which is what a bulk rollout needs. */
  rateLimiter?: RateLimiter;
  /**
   * The Karbon user every note is attributed to. Karbon requires an author and
   * rejects an address that is not a user on the tenant. Left unset, the first
   * user the tenant lists is used instead — see `authorEmail`.
   */
  noteAuthorEmail?: string;
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

/** Karbon's maximum page size for a list endpoint. */
const PAGE_SIZE = 100;

/**
 * A bound on how far a single search will page. Fifty pages is five thousand
 * work items — far more than a filtered search should ever reach, and low
 * enough that a runaway query fails instead of exhausting the account's request
 * budget.
 */
const MAX_SEARCH_PAGES = 50;

interface KarbonPage {
  value?: Record<string, unknown>[];
  '@odata.nextLink'?: string;
}

/**
 * The `$skip` for the next page, or null when this was the last one.
 *
 * Karbon's `@odata.nextLink` is an absolute URL. Only the offset is taken from
 * it: following a URL supplied in a response would let a vendor response point
 * this client at any host it liked.
 */
function nextSkip(page: KarbonPage | null): number | null {
  const link = page?.['@odata.nextLink'];
  if (typeof link !== 'string' || link.length === 0) return null;

  try {
    const skip = new URL(link).searchParams.get('$skip');
    const parsed = Number(skip);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export class KarbonRestClient implements KarbonProvider {
  readonly name = 'karbon';
  readonly isMock = false;

  private readonly config: Required<
    Omit<KarbonClientConfig, 'logger' | 'fetchImpl' | 'rateLimiter' | 'noteAuthorEmail'>
  > & {
    logger: Logger;
    fetchImpl: typeof fetch;
    noteAuthorEmail?: string;
  };

  private readonly limiter: RateLimiter;

  constructor(config: KarbonClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      bearerToken: config.bearerToken,
      accessKey: config.accessKey,
      timeoutMs: config.timeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 3,
      requestsPerMinute: config.requestsPerMinute ?? KARBON_DOCUMENTED_REQUESTS_PER_MINUTE,
      noteAuthorEmail: config.noteAuthorEmail,
      logger: config.logger ?? createLogger({ base: { integration: 'karbon' } }),
      fetchImpl: config.fetchImpl ?? fetch,
    };

    this.limiter =
      config.rateLimiter ?? new RateLimiter({ requestsPerMinute: this.config.requestsPerMinute });
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

    const method = options.method ?? 'GET';

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      // Every attempt spends a token, retries included: a retry is a request as
      // far as the account's budget is concerned.
      await this.limiter.acquire();

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

        // A read that found nothing is an answer. A *write* that 404s is not:
        // it means the operation does not exist on this tenant, which is the
        // most likely form of "tasks are unavailable here" — and returning null
        // reported that as a task successfully created.
        if (response.status === 404 && method === 'GET') return null as T;

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
            // Karbon answers 429 with how long to wait. Backing off on our own
            // shorter schedule spends the retry budget while the limit is still
            // in force, and the requests themselves prolong it.
            const requested = retryAfterMs(response.headers.get('retry-after'));
            await delay(Math.max(requested ?? 0, backoffMs(attempt)));
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

  /**
   * `$expand` is not optional here, it is the whole answer.
   *
   * A bare `GET /Organizations/{key}` returns the name, the keys and some
   * metadata — and nothing else. No contacts, no address, no telephone, no
   * e-mail. Those live on **Business Cards**, and contacts are a separate
   * expansion again; without asking for both, every imported client came back
   * with zero contacts and an empty address, which is exactly what the clients
   * screen showed for the whole firm.
   *
   * Nothing failed to produce that. The fields simply were not in a response
   * nobody had asked to include them in — the same shape of defect as the
   * document endpoints, and just as invisible.
   */
  private static readonly CLIENT_EXPAND = 'Contacts,BusinessCards';

  async getClient(entityKey: string): Promise<KarbonClient | null> {
    const organization = await this.request<Record<string, unknown> | null>({
      path: `/Organizations/${encodeURIComponent(entityKey)}`,
      query: { $expand: KarbonRestClient.CLIENT_EXPAND },
    });
    if (organization) return mapOrganization(organization);

    const contact = await this.request<Record<string, unknown> | null>({
      path: `/Contacts/${encodeURIComponent(entityKey)}`,
      query: { $expand: 'BusinessCards' },
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

    // Re-filtered client-side: a tenant whose API ignores an unsupported
    // $filter must not cause us to act on the wrong work item. That defence is
    // also why paging matters so much here — when the filter is ignored, the
    // matching work item may be on any page, and reading only the first means
    // quietly concluding a client has no prior-year letter.
    const matches = (item: KarbonWorkItem): boolean => {
      if (query.clientKey && item.clientKey !== query.clientKey) return false;
      if (query.workType && item.workType !== query.workType) return false;
      if (query.workStatus && item.workStatus !== query.workStatus) return false;
      if (query.title && !item.title.toLowerCase().includes(query.title.toLowerCase())) return false;
      if (query.year && !matchesYear(item, query.year)) return false;
      return true;
    };

    const wanted = query.limit ?? Number.POSITIVE_INFINITY;
    const found: KarbonWorkItem[] = [];
    let skip = 0;

    for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
      const response = await this.request<KarbonPage | null>({
        path: '/WorkItems',
        query: {
          $filter: filters.length > 0 ? filters.join(' and ') : undefined,
          $top: PAGE_SIZE,
          $skip: skip > 0 ? skip : undefined,
        },
      });

      const items = (response?.value ?? []).map(mapWorkItem);
      for (const item of items) {
        if (!matches(item)) continue;
        found.push(item);
        if (found.length >= wanted) return found;
      }

      // Karbon caps a page at 100 and hands back a nextLink carrying $skip.
      // The link is a vendor-supplied absolute URL; the $skip is read out of it
      // and re-issued against our own base URL rather than followed, so a
      // response can never redirect this client at another host.
      const next = nextSkip(response);
      if (next === null || items.length === 0) return found;
      skip = next;
    }

    // Never a silent truncation. Reading one page of a larger result and
    // treating it as the whole was the original defect; stopping quietly at
    // fifty pages would be the same defect with a bigger number.
    throw new IntegrationError(
      'Karbon',
      `A work item search exceeded ${MAX_SEARCH_PAGES} pages of ${PAGE_SIZE} without exhausting the result set.`,
      {
        retryable: false,
        context: { filters, pages: MAX_SEARCH_PAGES, matched: found.length },
      },
    );
  }

  /**
   * What the document endpoints actually said, rather than what the list came
   * back as.
   *
   * A 404 on a GET is treated as "found nothing", which is right for a missing
   * record and wrong here: it makes "this work item has no documents"
   * indistinguishable from "your API key cannot read documents" and from "that
   * collection does not exist on this tenant". A real run reported zero
   * documents across forty-seven work items and client records, which is
   * implausible for a working firm and impossible to diagnose from the list
   * alone.
   *
   * Diagnostic only — nothing in the workflow calls this. It exists so one
   * verification run can answer the question instead of leaving somebody to
   * guess at their Karbon permissions.
   */
  async describeDocumentAccess(scope: { workItemKey?: string; entityKey?: string }): Promise<string> {
    const entityTypes: KarbonEntityType[] = scope.workItemKey ? ['WorkItem'] : ['Organization', 'Contact'];
    const entityKey = scope.workItemKey ?? scope.entityKey ?? '';

    const findings: string[] = [];
    for (const entityType of entityTypes) {
      const path = `/FileList/${entityType}?EntityKey=${encodeURIComponent(entityKey)}`;
      try {
        const response = await this.request<KarbonFileList | null>({
          path: `/FileList/${entityType}`,
          query: { EntityKey: entityKey },
        });
        findings.push(
          response === null
            ? `${path} -> 404 (the endpoint answered "not found", which is not the same as an empty list)`
            : `${path} -> 200 with ${response.Attachments?.length ?? 0} file(s)`,
        );
      } catch (error) {
        findings.push(`${path} -> ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return findings.join('\n');
  }

  async listDocuments(scope: { workItemKey?: string; entityKey?: string }): Promise<KarbonDocument[]> {
    // `/WorkItems/{key}/Documents` does not exist. Karbon serves files through
    // `/FileList/{EntityType}?EntityKey=...`, and the endpoint we were asking
    // for answered 404 — which this client maps to "found nothing", so every
    // work item and client record reported zero documents. Confirmed against
    // Karbon's published OpenAPI specification, not inferred.
    const entityTypes: KarbonEntityType[] = scope.workItemKey ? ['WorkItem'] : ['Organization', 'Contact'];
    const entityKey = scope.workItemKey ?? scope.entityKey ?? '';

    for (const entityType of entityTypes) {
      const response = await this.request<KarbonFileList | null>({
        path: `/FileList/${entityType}`,
        query: { EntityKey: entityKey },
      });

      // A 404 here means the entity is not of this type. Only an actual list
      // means "these are the files", so an empty one from the right endpoint is
      // a real answer while a null is not.
      if (!response) continue;

      return (response.Attachments ?? []).map((raw): KarbonDocument => ({
        documentId: String(raw.FileContextKey ?? ''),
        fileName: String(raw.FileName ?? ''),
        workItemKey: scope.workItemKey ?? null,
        entityKey: scope.entityKey ?? null,
        byteSize: typeof raw.FileSize === 'number' ? raw.FileSize : null,
        mimeType: typeof raw.MimeType === 'string' ? raw.MimeType : null,
        uploadedAt: typeof raw.DateCreated === 'string' ? raw.DateCreated : null,
        uploadedBy: null,
        // Short-lived: the token carries its own expiry, so it is never stored.
        downloadUrl: typeof raw.DownloadUrl === 'string' ? raw.DownloadUrl : null,
      }));
    }

    return [];
  }

  async downloadDocument(
    documentId: string,
    scope?: { workItemKey?: string; entityKey?: string },
  ): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    // Karbon downloads through a signed token handed out with the file list —
    // `/Documents/{id}/Content` does not exist. Karbon documents the token as
    // valid for fifteen minutes, so it is fetched fresh rather than stored: a
    // persisted one would pass every test and then fail in production the first
    // time a document was opened a quarter of an hour after it was listed.
    const listing = scope ? await this.listDocuments(scope) : [];
    const match = listing.find((document) => document.documentId === documentId);

    if (!match?.downloadUrl) {
      throw new IntegrationError(
        'Karbon',
        `No download URL is available for file ${documentId}. Karbon issues one only with a current file listing, so the file must be listed for the entity that holds it.`,
        { retryable: false, context: { documentId, scope } },
      );
    }

    // The vendor returns an API path, sometimes with a differently-cased
    // prefix. Only the query is taken from it; the host is always ours.
    const token = new URL(match.downloadUrl, this.config.baseUrl).searchParams.get('token');
    const content = await this.request<Buffer>({
      path: '/Files',
      query: { token: token ?? undefined },
      binary: true,
      headers: { Accept: 'application/octet-stream' },
    });

    return {
      content,
      fileName: match.fileName || documentId,
      mimeType: match.mimeType ?? 'application/octet-stream',
    };
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

    // `POST /WorkItems/{key}/Documents` does not exist — it answered 404. Karbon
    // uploads through `POST /Files` as multipart, carrying the entity key as a
    // form field. Confirmed against Karbon's published OpenAPI specification.
    form.append('workitem_keys', request.workItemKey);

    const response = await this.request<Record<string, unknown> | null>({
      method: 'POST',
      path: '/Files',
      body: form,
      headers: { 'Idempotency-Key': request.idempotencyKey },
    });

    // Karbon answers an upload with `Id`; a file *listing* calls the same value
    // `FileContextKey`. Both are read so the identifier survives either shape.
    return {
      outcome: 'SUCCEEDED',
      objectId: response ? String(response.Id ?? response.FileContextKey ?? '') : null,
    };
  }

  /**
   * The users Karbon will accept as a note author.
   *
   * Karbon rejects `AuthorEmailAddress` for anyone who is not a user on the
   * tenant, and answers with a 400 that names no alternative. Whoever is
   * fixing that needs the list of addresses that would work, and asking them
   * to go and read it out of Karbon by hand is how a one-command answer turns
   * into a round trip.
   */
  async listUsers(limit = 25): Promise<{ name: string; email: string }[]> {
    const response = await this.request<{ value?: Record<string, unknown>[] } | null>({
      path: '/Users',
      query: { $top: limit },
    });

    return (response?.value ?? [])
      .map((raw) => ({
        name: typeof raw.Name === 'string' ? raw.Name : '',
        email: typeof raw.EmailAddress === 'string' ? raw.EmailAddress : '',
      }))
      .filter((user) => user.email.length > 0);
  }

  private discoveredAuthor: string | null = null;

  /**
   * The Karbon user a note is attributed to.
   *
   * Karbon requires `AuthorEmailAddress` on every note and refuses an address
   * that is not a user on the tenant, so this cannot be left out or invented.
   *
   * `noteAuthorEmail` is the answer the firm gives deliberately, and it is
   * preferred whenever it is set. Without it the first user the tenant returns
   * is discovered once and cached — which keeps notes flowing rather than
   * failing, but attributes them to whoever `/Users` happens to list first.
   * Karbon's user listing carries no active flag and no ordering guarantee, so
   * that may be a departed colleague. The Integrations screen says so, because
   * a note in a client's timeline signed by the wrong person is a thing the
   * firm should choose rather than discover.
   */
  private async authorEmail(): Promise<string> {
    if (this.config.noteAuthorEmail) return this.config.noteAuthorEmail;
    if (this.discoveredAuthor) return this.discoveredAuthor;

    const users = await this.request<{ value?: Record<string, unknown>[] } | null>({
      path: '/Users',
      query: { $top: 1 },
    });

    const email = users?.value?.[0]?.EmailAddress;
    if (typeof email !== 'string' || email.length === 0) {
      throw new IntegrationError(
        'Karbon',
        'Karbon requires every note to name an author, and no user could be read from the tenant to attribute one to. Set a note author address on the Karbon connection.',
        { retryable: false },
      );
    }

    this.discoveredAuthor = email;
    return email;
  }

  async addComment(request: KarbonCommentRequest): Promise<KarbonWriteResult> {
    const response = await this.request<Record<string, unknown> | null>({
      method: 'POST',
      path: '/Notes',
      // Karbon requires AuthorEmailAddress, Subject and Body, and links a note
      // through a Timelines array. The previous body carried none of the
      // required fields and invented RelatedEntityKey/RelatedEntityType, which
      // is why every note came back HTTP 400. Confirmed against Karbon's
      // published OpenAPI specification.
      body: {
        AuthorEmailAddress: await this.authorEmail(),
        Subject: 'Element Engagements',
        Body: request.body,
        Timelines: [{ EntityType: 'WorkItem', EntityKey: request.workItemKey }],
      },
      headers: { 'Idempotency-Key': request.idempotencyKey },
    });

    return { outcome: 'SUCCEEDED', objectId: response ? String(response.NoteKey ?? response.Id ?? '') : null };
  }

  /**
   * Karbon publishes no operation that creates a task.
   *
   * This used to `POST /WorkItems/{key}/Tasks` and treat the 404 as "the tenant
   * does not have the task feature", falling back to a note. The note is right;
   * the diagnosis was not. There is no such path on any tenant — Karbon's v3
   * surface has `GET /IntegrationTasks` and `PUT /IntegrationTasks/{key}`, both
   * of which read and update tasks Karbon created for a registered integration
   * partner, and neither of which creates one.
   *
   * So the 404 was not a signal about the tenant and there is nothing to retry.
   * This reports the fact and performs no request.
   *
   * It deliberately does not post the substitute note itself. The caller posts
   * one immediately afterwards carrying the same title and body, so a note here
   * would put two near-identical entries in a client's timeline for every
   * review — noise the firm would have to read past each time. The note is the
   * caller's job; saying "unsupported" is this method's.
   *
   * The authoritative task lives in this application's Review Queue regardless.
   */
  async createTask(request: KarbonTaskRequest): Promise<KarbonWriteResult> {
    this.config.logger.debug(
      'Karbon publishes no task-creation operation; the review note carries the assignment instead',
      { workItemKey: request.workItemKey },
    );

    return {
      outcome: 'SKIPPED_UNSUPPORTED',
      objectId: null,
      message:
        'Karbon has no API for creating a task. The review note carries the title and link, and the task itself is tracked in the Review Queue.',
    };
  }

  /**
   * Nothing to complete: no task was created, so no task key exists.
   *
   * `PUT /Tasks/{id}` does not exist either. `taskId` here can only ever be the
   * key of the note `createTask` posted, and completing a note is not a thing.
   */
  async completeTask(taskId: string): Promise<KarbonWriteResult> {
    return {
      outcome: 'SKIPPED_UNSUPPORTED',
      objectId: taskId,
      message:
        'Karbon has no API for completing a task. The review assignment was closed in the Review Queue, which is where it is tracked.',
    };
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
    // Karbon's field is AssigneeEmailAddress. Reading only `AssigneeEmail`
    // meant every work item came back with no assignee — not an error, just a
    // blank where a name should be, on every screen that shows one.
    assigneeEmail: text(raw.AssigneeEmailAddress) ?? text(raw.AssigneeEmail),
    dueDate: text(raw.DueDate),
    startDate: text(raw.StartDate),
    raw,
  };
}

/**
 * Karbon's contact fields, as `$expand=Contacts` actually returns them.
 *
 * `PreferredName` is the given name a letter should open with, `Salutation`
 * is the title. `PhoneNumber` is declared `oneOf`, so it may arrive as a bare
 * string or as an object — read defensively rather than stringifying an object
 * into `[object Object]` on a client's engagement letter.
 */
function mapContacts(raw: Record<string, unknown>): KarbonClient['contacts'] {
  const list = Array.isArray(raw.Contacts) ? (raw.Contacts as Record<string, unknown>[]) : [];
  return list.map((contact, index) => ({
    contactKey: String(contact.ContactKey ?? contact.Key ?? ''),
    fullName: String(contact.FullName ?? contact.Name ?? ''),
    firstName: text(contact.PreferredName) ?? text(contact.FirstName),
    email: text(contact.EmailAddress) ?? text(contact.Email),
    telephone: readPhone(contact.PhoneNumber) ?? readPhone(contact.Phone),
    title: text(contact.Salutation) ?? text(contact.RoleOrTitle) ?? text(contact.JobTitle),
    // Karbon marks no contact as primary on this expansion. Treating the first
    // as primary is a guess, and a guess about who receives an engagement
    // letter is one a person should confirm — so only a single contact is
    // assumed, and any ambiguity is left for the reviewer to resolve.
    isPrimary: contact.IsPrimary === true || (list.length === 1 && index === 0),
  }));
}

/** A phone number Karbon may send as a string or as a structured object. */
function readPhone(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return text(record.Number) ?? text(record.PhoneNumber) ?? null;
  }
  return null;
}

/**
 * The primary business card, where the address and contact details live.
 *
 * An Organization carries none of these itself, which is why every imported
 * client showed an empty address.
 */
function primaryBusinessCard(raw: Record<string, unknown>): Record<string, unknown> {
  const cards = Array.isArray(raw.BusinessCards) ? (raw.BusinessCards as Record<string, unknown>[]) : [];
  return cards.find((card) => card.IsPrimaryCard === true) ?? cards[0] ?? {};
}

/** The first address on a business card, which is where Karbon puts it. */
function cardAddress(card: Record<string, unknown>): Record<string, unknown> {
  const addresses = Array.isArray(card.Addresses) ? (card.Addresses as Record<string, unknown>[]) : [];
  return addresses[0] ?? {};
}

function mapOrganization(raw: Record<string, unknown>): KarbonClient {
  const card = primaryBusinessCard(raw);
  const address = cardAddress(card);

  return {
    entityKey: String(raw.OrganizationKey ?? raw.EntityKey ?? raw.Key ?? ''),
    entityType: 'Organization',
    legalName: String(raw.FullName ?? raw.Name ?? ''),
    displayName: text(raw.PreferredName),
    // Karbon has no business-number field on an Organization. `AccountingDetail`
    // is the nearest thing and `UserDefinedIdentifier` is what a firm actually
    // uses to carry its own identifier, so both are read — but neither is
    // guaranteed to be a CRA business number, so a wrong value must never reach
    // a T2 letter unreviewed. `describeClientDifferences` raises it as a
    // conflict for a person to confirm, which is the only safe treatment.
    businessNumber: readBusinessNumber(raw),
    addressLine1: text(address.AddressLine1) ?? text(address.Line1),
    addressLine2: text(address.AddressLine2) ?? text(address.Line2),
    city: text(address.City),
    province: text(address.StateProvinceCounty) ?? text(address.State),
    postalCode: text(address.ZipCode) ?? text(address.PostalCode),
    country: text(address.CountryCode) ?? text(address.Country),
    contacts: mapContacts(raw),
  };
}

/**
 * A business number, if the firm records one anywhere Karbon exposes.
 *
 * Karbon publishes no such field. `AccountingDetail` holds accounting-package
 * linkage and `UserDefinedIdentifier` is free text the firm controls, so a
 * value here is a candidate rather than a fact — and it is treated as one.
 */
function readBusinessNumber(raw: Record<string, unknown>): string | null {
  const detail = (raw.AccountingDetail ?? {}) as Record<string, unknown>;
  const candidate = text(detail.BusinessNumber) ?? text(detail.TaxNumber) ?? text(raw.UserDefinedIdentifier);
  if (!candidate) return null;

  // A business number is nine digits, optionally with an RC/RT program suffix.
  // The identifier field is free text and is frequently a client code or the
  // company name, so anything that is not number-shaped is not returned as one.
  return /\d{9}/.test(candidate.replace(/\s|-/g, '')) ? candidate : null;
}

function mapContactEntity(raw: Record<string, unknown>): KarbonClient {
  // Same as an Organization: a Contact carries no address of its own either.
  const card = primaryBusinessCard(raw);
  const address = cardAddress(card);
  const emails = Array.isArray(card.EmailAddresses) ? (card.EmailAddresses as unknown[]) : [];
  const phones = Array.isArray(card.PhoneNumbers) ? (card.PhoneNumbers as unknown[]) : [];

  return {
    entityKey: String(raw.ContactKey ?? raw.EntityKey ?? raw.Key ?? ''),
    entityType: 'Contact',
    legalName: String(raw.FullName ?? raw.Name ?? ''),
    displayName: text(raw.PreferredName),
    // An individual has no business number, which is a fact rather than a gap.
    businessNumber: null,
    addressLine1: text(address.AddressLine1) ?? text(address.Line1),
    addressLine2: text(address.AddressLine2) ?? text(address.Line2),
    city: text(address.City),
    province: text(address.StateProvinceCounty) ?? text(address.State),
    postalCode: text(address.ZipCode) ?? text(address.PostalCode),
    country: text(address.CountryCode) ?? text(address.Country),
    contacts: [
      {
        contactKey: String(raw.ContactKey ?? raw.Key ?? ''),
        fullName: String(raw.FullName ?? raw.Name ?? ''),
        firstName: text(raw.PreferredName) ?? text(raw.FirstName),
        email: text(raw.EmailAddress) ?? text(emails[0]),
        telephone: readPhone(raw.PhoneNumber) ?? readPhone(phones[0]),
        title: text(raw.Salutation) ?? text(card.RoleOrTitle),
        isPrimary: true,
      },
    ],
  };
}
