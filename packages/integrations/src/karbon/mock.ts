import { IntegrationError, NotFoundError } from '@element/shared';
import { KARBON_CAPABILITY_MATRIX } from './capabilities.js';
import { uploadTargetField } from './client.js';
import type {
  CapabilityReport,
  KarbonClient,
  KarbonClientList,
  KarbonClientSummary,
  KarbonCommentRequest,
  KarbonDocument,
  KarbonDocumentLibrary,
  KarbonEntityType,
  KarbonLibraryScope,
  KarbonProvider,
  KarbonTaskRequest,
  KarbonUploadRequest,
  KarbonWorkItem,
  KarbonWorkItemQuery,
  KarbonWriteResult,
  KarbonBatchDownload,
} from './types.js';

/**
 * In-memory Karbon adapter.
 *
 * This is a MOCK. It is clearly labelled as such (`isMock === true`), the UI
 * shows it as a mock, and it performs no network calls. It is used by Test
 * Mode and by the automated tests so the workflow can be exercised end to end
 * without touching a real Karbon tenant.
 *
 * It enforces the same guarantees as the real client — idempotent writes and
 * never overwriting a protected document — so that a test genuinely exercises
 * those rules.
 */

export interface MockKarbonSeed {
  clients?: KarbonClient[];
  workItems?: KarbonWorkItem[];
  documents?: (KarbonDocument & { content?: Buffer })[];
}

export interface MockCall {
  operation: string;
  payload: unknown;
  at: Date;
}

export class MockKarbonProvider implements KarbonProvider {
  readonly name = 'karbon-mock';
  readonly isMock = true;

  private clients = new Map<string, KarbonClient>();
  private workItems = new Map<string, KarbonWorkItem>();
  private documents = new Map<string, KarbonDocument & { content: Buffer }>();
  private idempotencyLog = new Map<string, KarbonWriteResult>();

  /** Every write attempted, for assertions and for the Karbon Activity tab. */
  readonly calls: MockCall[] = [];

  constructor(seed: MockKarbonSeed = {}) {
    for (const client of seed.clients ?? []) this.clients.set(client.entityKey, client);
    for (const item of seed.workItems ?? []) this.workItems.set(item.workItemKey, item);
    // The file key is the document's identity, here as in Karbon. So a file
    // that is filed against both a work item and the client is *one* entry
    // carrying both keys — seeding it twice under the same id silently keeps
    // only the last, which reads like two scopes and behaves like one.
    for (const document of seed.documents ?? []) {
      this.documents.set(document.documentId, {
        ...document,
        content: document.content ?? Buffer.from(`Mock content for ${document.fileName}`),
      });
    }
  }

  capabilities(): CapabilityReport[] {
    return [...KARBON_CAPABILITY_MATRIX];
  }

  private record(operation: string, payload: unknown): void {
    this.calls.push({ operation, payload, at: new Date() });
  }

  async getClient(entityKey: string): Promise<KarbonClient | null> {
    this.record('getClient', { entityKey });
    return this.clients.get(entityKey) ?? null;
  }

  async getWorkItem(workItemKey: string): Promise<KarbonWorkItem | null> {
    this.record('getWorkItem', { workItemKey });
    return this.workItems.get(workItemKey) ?? null;
  }

  /**
   * Every seeded client, whether or not it has a work item.
   *
   * That distinction is the entire point of the method, so a mock that ignored
   * it would hide the defect it exists to fix.
   */
  async listClients(options: { limit?: number } = {}): Promise<KarbonClientList> {
    this.record('listClients', options);
    const all: KarbonClientSummary[] = [...this.clients.values()].map((client) => ({
      entityKey: client.entityKey,
      entityType: client.entityType,
      fullName: client.legalName,
      // Not every tenant labels a client "Client" — the live one also uses
      // "Inactive" — so the seed carries whatever it was given rather than
      // asserting a vocabulary the mock has no way to know.
      contactType: client.contactType ?? 'Client',
    }));

    if (options.limit === undefined) return { clients: all, more: false };
    return { clients: all.slice(0, options.limit), more: all.length > options.limit };
  }

  async searchWorkItems(query: KarbonWorkItemQuery): Promise<KarbonWorkItem[]> {
    this.record('searchWorkItems', query);
    return [...this.workItems.values()]
      .filter((item) => {
        if (query.clientKey && item.clientKey !== query.clientKey) return false;
        if (query.workType && item.workType !== query.workType) return false;
        if (query.workStatus && item.workStatus !== query.workStatus) return false;
        if (query.title && !item.title.toLowerCase().includes(query.title.toLowerCase())) return false;
        if (query.year && !`${item.title} ${item.dueDate ?? ''}`.includes(String(query.year))) return false;
        return true;
      })
      .slice(0, query.limit ?? 100);
  }

  async listDocuments(scope: { workItemKey?: string; entityKey?: string }): Promise<KarbonDocument[]> {
    this.record('listDocuments', scope);
    return [...this.documents.values()].filter((document) => {
      if (scope.workItemKey) return document.workItemKey === scope.workItemKey;
      if (scope.entityKey) return document.entityKey === scope.entityKey;
      return true;
    });
  }

  /**
   * Assembled from the same three scopes the real client reads, deliberately.
   *
   * The shortcut here would be to return every seeded document at once. It
   * would also make the mock more capable than Karbon, which has no operation
   * that does that — and it would hide the aggregation, which is the only part
   * of this with anything to get wrong.
   */
  async listClientLibrary(
    entityKey: string,
    options: { maxWorkItems?: number } = {},
  ): Promise<KarbonDocumentLibrary> {
    this.record('listClientLibrary', { entityKey });

    const scopes: KarbonLibraryScope[] = [];
    const byFileKey = new Map<string, KarbonDocument>();

    const collect = async (
      entityType: KarbonEntityType,
      key: string,
      label: string,
      scope: { workItemKey?: string; entityKey?: string },
    ): Promise<void> => {
      const documents = await this.listDocuments(scope);
      scopes.push({ entityType, entityKey: key, label, documentCount: documents.length });
      for (const document of documents) {
        if (!document.documentId || byFileKey.has(document.documentId)) continue;
        byFileKey.set(document.documentId, { ...document, sourceLabel: label, sourceEntityType: entityType });
      }
    };

    const client = this.clients.get(entityKey) ?? null;
    await collect('Organization', entityKey, client?.legalName ?? entityKey, { entityKey });

    for (const contact of client?.contacts ?? []) {
      if (!contact.contactKey) continue;
      await collect('Contact', contact.contactKey, contact.fullName || 'Contact', {
        entityKey: contact.contactKey,
      });
    }

    const workItems = await this.searchWorkItems({ clientKey: entityKey, limit: options.maxWorkItems ?? 500 });
    for (const item of workItems) {
      await collect('WorkItem', item.workItemKey, item.title || item.workItemKey, {
        workItemKey: item.workItemKey,
      });
    }

    return {
      entityKey,
      documents: [...byFileKey.values()],
      scopes,
      failures: [],
      complete: true,
    };
  }

  /**
   * Refuses without a scope, because the real client does.
   *
   * This mock used to ignore the scope argument, and that permissiveness cost
   * more than any missing feature would have. Karbon issues a download token
   * only alongside a file listing, so `KarbonRestClient.downloadDocument`
   * re-lists the entity to get a fresh one and throws when it has no entity to
   * list. The worker's extraction called it with no scope at all — and every
   * test passed, because the double did not care.
   *
   * The result was that the *confident* path, the one where the search had
   * correctly identified last year's letter, was the only one that failed
   * against a real tenant. A test double looser than the thing it stands in for
   * does not merely fail to catch a defect; it actively certifies it.
   */
  async downloadDocument(
    documentId: string,
    scope?: { workItemKey?: string; entityKey?: string },
  ): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    this.record('downloadDocument', { documentId, scope });

    if (!scope?.workItemKey && !scope?.entityKey) {
      throw new IntegrationError(
        'Karbon',
        `No download URL is available for file ${documentId}. Karbon issues one only with a current file listing, so the file must be listed for the entity that holds it.`,
        { retryable: false, context: { documentId, scope } },
      );
    }

    const document = this.documents.get(documentId);
    if (!document) throw new NotFoundError(`Karbon document ${documentId}`);
    return {
      content: document.content,
      fileName: document.fileName,
      mimeType: document.mimeType ?? 'application/octet-stream',
    };
  }

  /**
   * The batch, held to the same standard as the single download above.
   *
   * It refuses without a scope for the same reason, and it *lists* — once —
   * rather than serving from the map directly, because one listing for the
   * whole batch is the entire point of the operation. A double that skipped the
   * listing would let a caller regress to one listing per file with every test
   * still green: the same mistake the comment above describes, in the other
   * direction.
   */
  async downloadDocuments(
    scope: { workItemKey?: string; entityKey?: string },
    documentIds: readonly string[],
  ): Promise<KarbonBatchDownload> {
    this.record('downloadDocuments', { scope, count: documentIds.length });

    // Nothing asked for is nothing requested, matching the real client. A double
    // that listed anyway would hide a caller making an empty round trip per
    // scope on a client whose library it had already filtered to nothing.
    if (documentIds.length === 0) return { files: [], failures: [] };

    if (!scope.workItemKey && !scope.entityKey) {
      return {
        files: [],
        failures: documentIds.map((documentId) => ({
          documentId,
          reason:
            'Karbon issues a download link only with a current file listing, so the file must be listed for the entity that holds it.',
        })),
      };
    }

    const listing = await this.listDocuments(scope);
    const available = new Set(listing.map((document) => document.documentId));

    const files: KarbonBatchDownload['files'] = [];
    const failures: KarbonBatchDownload['failures'] = [];

    for (const documentId of documentIds) {
      const stored = available.has(documentId) ? this.documents.get(documentId) : undefined;

      if (!stored) {
        failures.push({
          documentId,
          reason: 'This file was not in the listing for the scope it was expected under.',
        });
        continue;
      }

      files.push({
        documentId,
        content: stored.content,
        fileName: stored.fileName,
        mimeType: stored.mimeType ?? 'application/octet-stream',
      });
    }

    return { files, failures };
  }

  async uploadDocument(request: KarbonUploadRequest): Promise<KarbonWriteResult> {
    // Refuses exactly what the real client refuses — an entity target whose
    // kind is unknown — by running the same mapping. A mock that accepted it
    // would let a delivery path pass every test and fail on its first real
    // run, which is precisely how the download-scope defect survived.
    const field = uploadTargetField(request.target);

    this.record('uploadDocument', {
      // Recorded so a test can assert *where* a file went, not merely that one
      // did: `workitem_keys`, `organization_keys` or `contact_keys`.
      targetField: field.name,
      targetKey: field.key,
      fileName: request.fileName,
      idempotencyKey: request.idempotencyKey,
    });

    const replayed = this.idempotencyLog.get(request.idempotencyKey);
    if (replayed) return { ...replayed, outcome: 'SKIPPED_DUPLICATE' };

    const workItemKey = 'workItemKey' in request.target ? request.target.workItemKey : null;
    const entityKey = 'entityKey' in request.target ? request.target.entityKey : null;

    if (request.neverOverwrite) {
      const collision = [...this.documents.values()].find(
        (document) =>
          (workItemKey !== null ? document.workItemKey === workItemKey : document.entityKey === entityKey) &&
          document.fileName === request.fileName,
      );
      if (collision) {
        const result: KarbonWriteResult = {
          outcome: 'SKIPPED_DUPLICATE',
          objectId: collision.documentId,
          message: `A document named "${request.fileName}" already exists and was not replaced.`,
        };
        this.idempotencyLog.set(request.idempotencyKey, result);
        return result;
      }
    }

    const documentId = `doc_${this.documents.size + 1}_${request.idempotencyKey.slice(-8)}`;
    this.documents.set(documentId, {
      documentId,
      fileName: request.fileName,
      workItemKey,
      entityKey,
      byteSize: request.content.byteLength,
      mimeType: request.mimeType,
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'element-engagements',
      content: Buffer.from(request.content),
    });

    const result: KarbonWriteResult = { outcome: 'SUCCEEDED', objectId: documentId };
    this.idempotencyLog.set(request.idempotencyKey, result);
    return result;
  }

  async addComment(request: KarbonCommentRequest): Promise<KarbonWriteResult> {
    this.record('addComment', { workItemKey: request.workItemKey, body: request.body });

    const replayed = this.idempotencyLog.get(request.idempotencyKey);
    if (replayed) return { ...replayed, outcome: 'SKIPPED_DUPLICATE' };

    const result: KarbonWriteResult = { outcome: 'SUCCEEDED', objectId: `note_${this.calls.length}` };
    this.idempotencyLog.set(request.idempotencyKey, result);
    return result;
  }

  /**
   * Karbon publishes no task-creation operation, so neither does this mock.
   *
   * It used to answer `SUCCEEDED` with a `task_1` identifier. A mock more
   * capable than the vendor is worse than no mock at all: every run in Test
   * Mode showed a review task created in Karbon, and every run in production
   * showed it unsupported, so the difference only ever appeared where it was
   * most expensive to find. The mock's job is to stand in for Karbon, not to be
   * a better version of it.
   */
  async createTask(request: KarbonTaskRequest): Promise<KarbonWriteResult> {
    this.record('createTask', { workItemKey: request.workItemKey, title: request.title });

    return {
      outcome: 'SKIPPED_UNSUPPORTED',
      objectId: null,
      message:
        'Karbon has no API for creating a task. The review note carries the title and link, and the task itself is tracked in the Review Queue.',
    };
  }

  async completeTask(taskId: string): Promise<KarbonWriteResult> {
    this.record('completeTask', { taskId });

    return {
      outcome: 'SKIPPED_UNSUPPORTED',
      objectId: taskId,
      message:
        'Karbon has no API for completing a task. The review assignment was closed in the Review Queue, which is where it is tracked.',
    };
  }

  async updateWorkItemStatus(workItemKey: string, status: string): Promise<KarbonWriteResult> {
    this.record('updateWorkItemStatus', { workItemKey, status });
    const item = this.workItems.get(workItemKey);
    if (item) this.workItems.set(workItemKey, { ...item, workStatus: status });
    return { outcome: 'SUCCEEDED', objectId: workItemKey };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'Mock adapter — no network calls are made.' };
  }

  /** No tenant to interrogate, so the mock says only what it knows. */
  async describeUnresolvedClient(entityKey: string): Promise<string> {
    return `the mock adapter holds no client with the key ${entityKey}`;
  }

  // ---- Test helpers -------------------------------------------------------

  callsFor(operation: string): MockCall[] {
    return this.calls.filter((call) => call.operation === operation);
  }

  documentCount(): number {
    return this.documents.size;
  }

  addDocument(document: KarbonDocument & { content?: Buffer }): void {
    this.documents.set(document.documentId, {
      ...document,
      content: document.content ?? Buffer.from(`Mock content for ${document.fileName}`),
    });
  }
}

/**
 * Provider that refuses every write. Used when Test Mode is on and no sandbox
 * connection is configured, so a production write is impossible by construction
 * rather than by convention.
 */
export class BlockedKarbonProvider implements KarbonProvider {
  readonly name = 'karbon-blocked';
  readonly isMock = true;

  constructor(private readonly reason: string) {}

  capabilities(): CapabilityReport[] {
    return [...KARBON_CAPABILITY_MATRIX];
  }

  private blocked(): KarbonWriteResult {
    return { outcome: 'SKIPPED_TEST_MODE', message: this.reason };
  }

  async getClient(): Promise<KarbonClient | null> {
    return null;
  }
  async getWorkItem(): Promise<KarbonWorkItem | null> {
    return null;
  }
  async searchWorkItems(): Promise<KarbonWorkItem[]> {
    return [];
  }
  /**
   * Empty, and that emptiness is a refusal rather than an answer.
   *
   * The import refuses to run against a blocked or mock provider at all, so
   * nothing here can be mistaken for "this firm has no clients".
   */
  async listClients(): Promise<KarbonClientList> {
    return { clients: [], more: false };
  }
  async listDocuments(): Promise<KarbonDocument[]> {
    return [];
  }
  /**
   * Empty *and* incomplete.
   *
   * A blocked provider returning `complete: true` would be claiming this client
   * genuinely has no documents in Karbon, which is a statement about the firm's
   * data made by an adapter that never looked. The failure entry is what stops
   * "we are not allowed to read" from reading as "there is nothing there".
   */
  async listClientLibrary(entityKey: string): Promise<KarbonDocumentLibrary> {
    return {
      entityKey,
      documents: [],
      scopes: [],
      failures: [{ entityType: 'Organization', entityKey, label: 'Karbon', reason: this.reason }],
      complete: false,
    };
  }
  async downloadDocument(): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    throw new NotFoundError('Karbon document (test mode blocks reads from production)');
  }
  async downloadDocuments(
    _scope: { workItemKey?: string; entityKey?: string },
    documentIds: readonly string[],
  ): Promise<KarbonBatchDownload> {
    // Reported as failures rather than thrown, so the caller records that these
    // were not read — which is the distinction the contract exists for.
    return { files: [], failures: documentIds.map((documentId) => ({ documentId, reason: this.reason })) };
  }
  async uploadDocument(): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async addComment(): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async createTask(): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async completeTask(): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async updateWorkItemStatus(): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: this.reason };
  }

  async describeUnresolvedClient(): Promise<string> {
    return this.reason;
  }
}

/**
 * The real Karbon, with every write refused.
 *
 * The gap this fills was doing real damage. `BlockedKarbonProvider` refuses
 * reads as well as writes, so a connection honestly marked *production* did
 * nothing at all while Test Mode was on — no client list, no prior-year letter,
 * no work item. Karbon publishes no sandbox host, so a firm that wanted the
 * application to do anything with Karbon had exactly one lever: mark the
 * production connection "Sandbox". That is what was actually deployed, and it
 * turned Test Mode's only structural guarantee into a label.
 *
 * Reading a firm's own Karbon changes nothing on the firm's side and is what a
 * firm setting the application up genuinely needs to do. Writing is what Test
 * Mode exists to prevent: nothing reaches a client's permanent file, and no
 * client is contacted. Separating the two lets the label stay honest, which is
 * the only way the guarantee means anything.
 */
export class ReadOnlyKarbonProvider implements KarbonProvider {
  readonly name = 'karbon-read-only';
  /**
   * Not a mock: what it returns is the firm's real Karbon data, and anything
   * deciding whether an answer can be trusted — the client import refusing to
   * invent clients, the signature filing refusing to call a mock upload
   * "filed" — must treat it as real.
   */
  readonly isMock = false;

  constructor(
    private readonly inner: KarbonProvider,
    private readonly reason: string,
  ) {}

  capabilities(): CapabilityReport[] {
    return this.inner.capabilities();
  }

  private blocked(): KarbonWriteResult {
    return { outcome: 'SKIPPED_TEST_MODE', message: this.reason };
  }

  // ---- Reads: the firm's own data, unchanged by looking at it -------------
  getClient(entityKey: string): Promise<KarbonClient | null> {
    return this.inner.getClient(entityKey);
  }

  /** Reading who the firm's clients are changes nothing on the firm's side. */
  listClients(options?: { limit?: number }): Promise<KarbonClientList> {
    return this.inner.listClients(options);
  }
  getWorkItem(workItemKey: string): Promise<KarbonWorkItem | null> {
    return this.inner.getWorkItem(workItemKey);
  }
  searchWorkItems(query: KarbonWorkItemQuery): Promise<KarbonWorkItem[]> {
    return this.inner.searchWorkItems(query);
  }
  listDocuments(scope: { workItemKey?: string; entityKey?: string }): Promise<KarbonDocument[]> {
    return this.inner.listDocuments(scope);
  }
  listClientLibrary(entityKey: string, options?: { maxWorkItems?: number }): Promise<KarbonDocumentLibrary> {
    return this.inner.listClientLibrary(entityKey, options);
  }
  downloadDocument(
    documentId: string,
    scope?: { workItemKey?: string; entityKey?: string },
  ): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    return this.inner.downloadDocument(documentId, scope);
  }
  downloadDocuments(
    scope: { workItemKey?: string; entityKey?: string },
    documentIds: readonly string[],
  ): Promise<KarbonBatchDownload> {
    return this.inner.downloadDocuments(scope, documentIds);
  }
  healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return this.inner.healthCheck();
  }
  /**
   * Forwarded explicitly, like every other read.
   *
   * This wrapper lists the provider's methods by hand, so a capability added to
   * the interface and not added here does not fail — it goes *missing*. That
   * happened immediately: a diagnostic that names what an unreadable client key
   * actually is was added, worked in every test, and then reported nothing at
   * all in production, because under Test Mode the provider is this wrapper and
   * the method it was calling was `undefined`.
   *
   * An optional method makes it worse: `provider.thing?.()` on a wrapper that
   * forgot to forward is indistinguishable from a provider that legitimately
   * does not implement it. `read-only-karbon.test.ts` now asserts this class
   * covers the whole interface, so the next omission is a failing test rather
   * than a silence.
   */
  describeUnresolvedClient(entityKey: string): Promise<string> {
    return this.inner.describeUnresolvedClient(entityKey);
  }

  // ---- Writes: what Test Mode exists to prevent ---------------------------
  //
  // Each takes its request and discards it. Declaring the parameters rather
  // than omitting them keeps the refusal a deliberate no-op at every call site
  // instead of a signature that merely happens to be assignable.
  async uploadDocument(_request: KarbonUploadRequest): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async addComment(_request: KarbonCommentRequest): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async createTask(_request: KarbonTaskRequest): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async completeTask(_taskId: string): Promise<KarbonWriteResult> {
    return this.blocked();
  }
  async updateWorkItemStatus(_workItemKey: string, _status: string): Promise<KarbonWriteResult> {
    return this.blocked();
  }
}
