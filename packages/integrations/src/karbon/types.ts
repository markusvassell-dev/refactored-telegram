/**
 * Karbon provider interface.
 *
 * Karbon remains the primary document system of record. Everything this
 * application does against Karbon goes through this interface, so the real
 * client, the mock adapter used in Test Mode, and the test doubles are
 * interchangeable.
 *
 * IMPORTANT: capability support varies. `capabilities()` reports what the
 * configured connection can actually do; see docs/karbon-capability-matrix.md.
 * Unsupported operations must fail loudly or fall back visibly — never
 * silently pretend to have succeeded, and never use browser scraping.
 */

export interface KarbonContact {
  contactKey: string;
  fullName: string;
  firstName?: string | null;
  email?: string | null;
  telephone?: string | null;
  title?: string | null;
  isPrimary?: boolean;
}

export interface KarbonClient {
  entityKey: string;
  entityType: 'Organization' | 'Contact';
  /**
   * The legal entity, with any trailing trading name separated off.
   *
   * Karbon's `FullName` routinely carries both — `2140071 Alberta Ltd. (JC Spa
   * and Wellness)` — and this value is what prints onto an engagement letter, so
   * it must be the entity that signs it and nothing else.
   */
  legalName: string;
  /** The name over the door, when `FullName` carried one. Never the legal name. */
  tradeName?: string | null;
  displayName?: string | null;
  businessNumber?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
  /**
   * Karbon's contact type, verbatim and uninterpreted.
   *
   * Tenant-defined. The live tenant uses `Client` and `Inactive`, which is
   * exactly why nothing here decides what they mean: "Inactive" plainly matters
   * when choosing who to send an engagement letter to, and equally plainly that
   * is the firm's call rather than a string comparison's.
   */
  contactType?: string | null;
  contacts: KarbonContact[];
}

export interface KarbonWorkItem {
  workItemKey: string;
  title: string;
  clientKey?: string | null;
  clientName?: string | null;
  workType?: string | null;
  workStatus?: string | null;
  assigneeEmail?: string | null;
  dueDate?: string | null;
  startDate?: string | null;
  /** Raw payload retained for the Karbon Activity tab and for diagnostics. */
  raw?: unknown;
}

export interface KarbonDocument {
  documentId: string;
  fileName: string;
  workItemKey?: string | null;
  entityKey?: string | null;
  byteSize?: number | null;
  mimeType?: string | null;
  uploadedAt?: string | null;
  uploadedBy?: string | null;
  /**
   * Which file list this came from, in words — "2024 T2 Tax Return" or the
   * client's own name. A file key alone cannot tell a reviewer where in Karbon
   * a document is filed, and that is usually the question being asked.
   */
  sourceLabel?: string | null;
  /** The entity type whose file list produced this document. */
  sourceEntityType?: KarbonEntityType | null;
  /**
   * The signed API path Karbon hands out with a file listing. Short-lived — the
   * token carries its own expiry — so it is never persisted; a download fetches
   * a current listing to obtain a fresh one.
   */
  downloadUrl?: string | null;
}

/** One place a file list was read from, and what it held. */
export interface KarbonLibraryScope {
  entityType: KarbonEntityType;
  entityKey: string;
  /** What a person would call this — a work item title, or the client's name. */
  label: string;
  documentCount: number;
}

/** A scope that could not be read. Its documents are missing, not absent. */
export interface KarbonLibraryFailure {
  entityType: KarbonEntityType;
  entityKey: string;
  label: string;
  reason: string;
}

/**
 * Everything Karbon holds for one client.
 *
 * Karbon has no "all documents for this client" operation. The Documents tab in
 * its own interface is an aggregate, and so is this: the organization's files,
 * each contact's files, and the files on every work item ever raised for that
 * client, deduplicated by file key.
 *
 * `complete` is the field that matters. Reading a client's library means tens of
 * requests, and any one of them can fail; a library assembled from nineteen of
 * twenty scopes is not a smaller library, it is a wrong one. Presenting it as
 * the client's documents would mean a reviewer concluding a document does not
 * exist because the request that would have found it failed quietly. So a
 * partial result stays labelled partial, all the way to the screen.
 */
export interface KarbonDocumentLibrary {
  entityKey: string;
  documents: KarbonDocument[];
  scopes: KarbonLibraryScope[];
  failures: KarbonLibraryFailure[];
  /** True only when every scope was read. False means documents may be missing. */
  complete: boolean;
}

export interface KarbonWorkItemQuery {
  clientKey?: string;
  workType?: string;
  workStatus?: string;
  /** Free-text title search. */
  title?: string;
  /** Inclusive year filter applied client-side when the API cannot filter. */
  year?: number;
  limit?: number;
}

export interface KarbonUploadRequest {
  workItemKey: string;
  fileName: string;
  content: Uint8Array | Buffer;
  mimeType: string;
  /** Deterministic key; a repeated upload with the same key must be a no-op. */
  idempotencyKey: string;
  /**
   * When true the provider must refuse to replace an existing document with
   * the same name. Signed and approved files are never overwritten.
   */
  neverOverwrite: boolean;
}

export interface KarbonCommentRequest {
  workItemKey: string;
  body: string;
  idempotencyKey: string;
  /** Email of the person the note should be directed to, when supported. */
  assigneeEmail?: string | null;
}

export interface KarbonTaskRequest {
  workItemKey: string;
  title: string;
  description?: string;
  assigneeEmail?: string | null;
  dueDate?: string | null;
  idempotencyKey: string;
}

export type KarbonCapability =
  | 'SEARCH_WORK_ITEMS'
  | 'READ_WORK_ITEM'
  | 'READ_CONTACTS'
  | 'READ_CLIENT'
  | 'LIST_CLIENTS'
  | 'LIST_DOCUMENTS'
  | 'LIST_CLIENT_LIBRARY'
  | 'DOWNLOAD_DOCUMENT'
  | 'UPLOAD_DOCUMENT'
  | 'ADD_COMMENT'
  | 'CREATE_TASK'
  | 'UPDATE_TASK'
  | 'COMPLETE_TASK'
  | 'UPDATE_WORK_ITEM_STATUS'
  | 'RECEIVE_WEBHOOKS'
  | 'DOCUMENT_UPLOAD_EVENTS';

export type CapabilitySupport = 'SUPPORTED' | 'UNSUPPORTED' | 'UNVERIFIED';

export interface CapabilityReport {
  capability: KarbonCapability;
  support: CapabilitySupport;
  /** Officially documented operation used, when supported. */
  operation?: string;
  /** What the application does instead when unsupported. */
  fallback?: string;
  limitation?: string;
}

/** Result wrapper so callers can tell "did nothing" from "succeeded". */
export interface KarbonWriteResult {
  outcome: 'SUCCEEDED' | 'SKIPPED_DUPLICATE' | 'SKIPPED_TEST_MODE' | 'SKIPPED_UNSUPPORTED';
  objectId?: string | null;
  message?: string;
}

/** The entity kinds Karbon serves a file list for. */
export type KarbonEntityType = 'WorkItem' | 'Contact' | 'Organization';

/** `GET /v3/FileList/{EntityType}` — the shape Karbon actually returns. */
export interface KarbonFileListItem {
  FileContextKey?: string;
  FileName?: string;
  FileSize?: number;
  MimeType?: string;
  /** A signed, short-lived API path. Never stored: the token expires. */
  DownloadUrl?: string;
  DateCreated?: string;
}

export interface KarbonFileList {
  EntityKey?: string;
  EntityType?: KarbonEntityType;
  Attachments?: KarbonFileListItem[];
}

/**
 * One entry of Karbon's own client list.
 *
 * Deliberately thin: the list endpoints return a summary DTO with no business
 * cards, so no address and no contacts. `getClient` is still what fills a
 * client in. This exists to answer "who are the firm's clients?", which is a
 * different question from "what do we know about this one?".
 */
export interface KarbonClientSummary {
  entityKey: string;
  entityType: 'Organization' | 'Contact';
  fullName: string;
  /**
   * Karbon's contact type, verbatim.
   *
   * Tenant-defined — the vocabulary comes from `/TenantSettings` and differs
   * between firms — so nothing here interprets it. It is carried through and
   * shown, because which of a firm's types mean "a client" is the firm's answer
   * and not one this application can infer.
   */
  contactType: string | null;
}

/**
 * A page of the firm's client list, and whether it is all of it.
 *
 * The flag is not a nicety. A caller has to distinguish "this is the whole
 * client list" from "this is as much as you asked for", and a count cannot do
 * it: a list of exactly the limit may or may not have more behind it, and two
 * lists drawn from two endpoints cannot be told apart by their total at all.
 *
 * Verifying against the live tenant is what exposed this. `listClients` handed
 * back 50 — 25 organisations and 25 contacts, each stopping precisely on the
 * limit — and nothing in the result said so, so 50 read as the firm's client
 * list when it was a truncation of something larger.
 */
export interface KarbonClientList {
  clients: KarbonClientSummary[];
  /** True when a list was cut short by the limit, so more clients exist. */
  more: boolean;
}

export interface KarbonProvider {
  readonly name: string;
  /** True when this adapter is a mock and performs no real network calls. */
  readonly isMock: boolean;

  capabilities(): CapabilityReport[];

  getClient(entityKey: string): Promise<KarbonClient | null>;
  getWorkItem(workItemKey: string): Promise<KarbonWorkItem | null>;
  searchWorkItems(query: KarbonWorkItemQuery): Promise<KarbonWorkItem[]>;

  /**
   * The firm's client list, as Karbon holds it.
   *
   * Client discovery used to run entirely through work items: search them, take
   * the distinct client keys, import those. That finds only clients somebody
   * has already opened work for, which silently omits a new client, a dormant
   * one, and any client whose work predates the window being examined. The
   * screen reported "63 clients found in Karbon" when it meant "63 clients
   * among the work items I looked at" — a number a person reconciles against
   * their own client list and finds short.
   *
   * Karbon publishes `/Organizations` and `/Contacts` for exactly this, and
   * neither was ever called.
   *
   * `limit` is a **total** across both entity types, split evenly between them.
   * It was originally passed to each endpoint whole, so asking for 25 returned
   * 50 — a cap that quietly meant twice what the caller said. Splitting biases
   * nothing: taking the total from organisations first would mean a firm with
   * more organisations than the limit never sees a single individual client, and
   * an individual filing a T1 is exactly a `Contact`.
   */
  listClients(options?: { limit?: number }): Promise<KarbonClientList>;

  listDocuments(scope: { workItemKey?: string; entityKey?: string }): Promise<KarbonDocument[]>;

  /**
   * Every document Karbon holds for a client, across every scope it files them
   * under. See `KarbonDocumentLibrary` — in particular `complete`, which a
   * caller must not discard.
   */
  listClientLibrary(
    entityKey: string,
    options?: { maxWorkItems?: number },
  ): Promise<KarbonDocumentLibrary>;
  /**
   * `scope` names the entity whose listing carries the download token. Karbon
   * issues one only alongside a file list, so a document id alone is not enough.
   */
  downloadDocument(
    documentId: string,
    scope?: { workItemKey?: string; entityKey?: string },
  ): Promise<{ content: Buffer; fileName: string; mimeType: string }>;

  /**
   * What a client key is, when `getClient` returned null.
   *
   * "Could not be read" names a symptom and no cause, and the cause is worth a
   * request rather than a guess.
   *
   * Required, not optional, and that distinction cost a deployment to learn.
   * As an optional method it was added to the real client and forgotten on the
   * read-only wrapper — which is the provider in Test Mode. `provider.thing?.()`
   * then returned `undefined`, indistinguishable from an adapter that
   * legitimately does not implement it, so the feature simply did not exist in
   * production while passing every test. Required means the compiler finds the
   * next omission instead of the operator.
   */
  describeUnresolvedClient(entityKey: string): Promise<string>;

  uploadDocument(request: KarbonUploadRequest): Promise<KarbonWriteResult>;
  addComment(request: KarbonCommentRequest): Promise<KarbonWriteResult>;
  createTask(request: KarbonTaskRequest): Promise<KarbonWriteResult>;
  completeTask(taskId: string): Promise<KarbonWriteResult>;
  updateWorkItemStatus(workItemKey: string, status: string): Promise<KarbonWriteResult>;

  /** Lightweight connectivity check for the Integrations screen. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
