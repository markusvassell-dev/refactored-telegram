import { NotFoundError } from '@element/shared';
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
  private taskCompletions = new Set<string>();

  /** Every write attempted, for assertions and for the Karbon Activity tab. */
  readonly calls: MockCall[] = [];

  constructor(seed: MockKarbonSeed = {}) {
    for (const client of seed.clients ?? []) this.clients.set(client.entityKey, client);
    for (const item of seed.workItems ?? []) this.workItems.set(item.workItemKey, item);
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

  async downloadDocument(documentId: string): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    this.record('downloadDocument', { documentId });
    const document = this.documents.get(documentId);
    if (!document) throw new NotFoundError(`Karbon document ${documentId}`);
    return {
      content: document.content,
      fileName: document.fileName,
      mimeType: document.mimeType ?? 'application/octet-stream',
    };
  }

  async uploadDocument(request: KarbonUploadRequest): Promise<KarbonWriteResult> {
    this.record('uploadDocument', {
      workItemKey: request.workItemKey,
      fileName: request.fileName,
      idempotencyKey: request.idempotencyKey,
    });

    const replayed = this.idempotencyLog.get(request.idempotencyKey);
    if (replayed) return { ...replayed, outcome: 'SKIPPED_DUPLICATE' };

    if (request.neverOverwrite) {
      const collision = [...this.documents.values()].find(
        (document) => document.workItemKey === request.workItemKey && document.fileName === request.fileName,
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
      workItemKey: request.workItemKey,
      entityKey: null,
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

  async createTask(request: KarbonTaskRequest): Promise<KarbonWriteResult> {
    this.record('createTask', { workItemKey: request.workItemKey, title: request.title });

    const replayed = this.idempotencyLog.get(request.idempotencyKey);
    if (replayed) return { ...replayed, outcome: 'SKIPPED_DUPLICATE' };

    const result: KarbonWriteResult = { outcome: 'SUCCEEDED', objectId: `task_${this.calls.length}` };
    this.idempotencyLog.set(request.idempotencyKey, result);
    return result;
  }

  async completeTask(taskId: string): Promise<KarbonWriteResult> {
    this.record('completeTask', { taskId });
    if (this.taskCompletions.has(taskId)) return { outcome: 'SKIPPED_DUPLICATE', objectId: taskId };
    this.taskCompletions.add(taskId);
    return { outcome: 'SUCCEEDED', objectId: taskId };
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
  async listDocuments(): Promise<KarbonDocument[]> {
    return [];
  }
  async downloadDocument(): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    throw new NotFoundError('Karbon document (test mode blocks reads from production)');
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
  getWorkItem(workItemKey: string): Promise<KarbonWorkItem | null> {
    return this.inner.getWorkItem(workItemKey);
  }
  searchWorkItems(query: KarbonWorkItemQuery): Promise<KarbonWorkItem[]> {
    return this.inner.searchWorkItems(query);
  }
  listDocuments(scope: { workItemKey?: string; entityKey?: string }): Promise<KarbonDocument[]> {
    return this.inner.listDocuments(scope);
  }
  downloadDocument(documentId: string): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    return this.inner.downloadDocument(documentId);
  }
  healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return this.inner.healthCheck();
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
