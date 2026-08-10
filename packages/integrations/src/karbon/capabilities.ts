import type { CapabilityReport } from './types.js';

/**
 * Karbon capability matrix.
 *
 * Support levels reflect what has actually been verified from this codebase:
 *
 *   SUPPORTED   — observed working against a live Karbon tenant from this
 *                 project, via `pnpm verify:karbon`.
 *   UNVERIFIED  — implemented per Karbon's published documentation, but not
 *                 yet exercised against a live tenant from this project.
 *   UNSUPPORTED — no officially supported API operation is available. The
 *                 application uses the documented fallback instead and keeps
 *                 the step visible in its own UI.
 *
 * Nothing here is claimed as working merely because the code compiles.
 * See docs/karbon-capability-matrix.md for the human-readable version.
 */
export const KARBON_CAPABILITY_MATRIX: readonly CapabilityReport[] = [
  {
    capability: 'SEARCH_WORK_ITEMS',
    support: 'SUPPORTED',
    operation: 'GET /v3/WorkItems with $filter/$top OData parameters',
    limitation:
      'Filter support varies by field. The provider requests a filtered page and then re-filters client-side, so an unsupported $filter degrades to a broader query rather than a wrong result. Pages are 100 items; the provider follows @odata.nextLink until the result set is exhausted, taking only the $skip offset from the link.',
  },
  {
    capability: 'READ_WORK_ITEM',
    support: 'SUPPORTED',
    operation: 'GET /v3/WorkItems/{WorkItemKey}',
  },
  {
    capability: 'READ_CLIENT',
    support: 'SUPPORTED',
    operation: 'GET /v3/Organizations/{EntityKey} and GET /v3/Contacts/{EntityKey}',
    limitation: 'The entity type must be known in advance; the application stores it on the client record.',
  },
  {
    capability: 'READ_CONTACTS',
    support: 'UNVERIFIED',
    operation: 'GET /v3/Contacts and the Organization contact collection',
  },
  {
    capability: 'LIST_DOCUMENTS',
    // Observed 2026-08-10 against the live tenant: a listing returned a real
    // file with a usable download token, which is what finally distinguished a
    // working endpoint from the old one. `/v3/WorkItems/{key}/Documents` does
    // not exist, and a 404 on a GET is mapped to "found nothing", so every work
    // item and client record used to report zero.
    //
    // Only the WorkItem entity type has been observed returning a file. The
    // Organization and Contact types are implemented from the same documented
    // operation and are exercised by the same code path, but no run has yet had
    // one return a document.
    support: 'SUPPORTED',
    operation: 'GET /v3/FileList/{EntityType}?EntityKey=... (EntityType is WorkItem, Organization or Contact)',
    limitation:
      'Document listings expose file names and identifiers. File names are never trusted on their own — every candidate prior-year document is verified against its content. A client key names either an Organization or a Contact, so both are tried in that order; those two entity types have not yet been observed returning a file.',
  },
  {
    capability: 'DOWNLOAD_DOCUMENT',
    // Observed 2026-08-10: 31,118 bytes of application/pdf came back from a
    // live work item. Both halves of the two-step are therefore exercised —
    // the listing that issues the token, and the request that spends it.
    support: 'SUPPORTED',
    operation: 'GET /v3/Files?token=... (the token comes from DownloadUrl on a current file listing)',
    limitation:
      'There is no download by document id. Karbon issues a signed token alongside a file listing and documents it as valid for fifteen minutes, so a download must first list the entity that holds the file. Tokens are never persisted.',
  },
  {
    capability: 'UPLOAD_DOCUMENT',
    support: 'UNVERIFIED',
    operation: 'POST /v3/Files (multipart/form-data: file plus workitem_keys)',
    limitation:
      'The application never overwrites an existing approved, signed, or certificate document. If a name collides it uploads under a suffixed name and records the collision.',
  },
  {
    capability: 'ADD_COMMENT',
    support: 'UNVERIFIED',
    operation: 'POST /v3/Notes with AuthorEmailAddress, Subject, Body and a Timelines entry naming the Work Item',
    limitation:
      'Karbon requires every note to name an author who is a user on the tenant. Set a note author on the Karbon connection; otherwise the first user the tenant lists is used, which may not be who the firm would choose. Comments are notifications only — they are never parsed as automation commands.',
  },
  {
    capability: 'CREATE_TASK',
    // Not "varies by tenant and plan" — that was a guess dressed as a fact.
    // Karbon's v3 surface has no operation that creates a task on a work item.
    // `/v3/IntegrationTasks` is GET-only and `/v3/IntegrationTasks/{key}` is
    // GET and PUT: both read or update tasks Karbon created for a registered
    // integration partner, and neither creates one.
    support: 'UNSUPPORTED',
    fallback:
      'The application posts a note carrying the review title and a deep link, and keeps the authoritative review task in its own Review Queue. No request is made to a task endpoint, because there is none to make.',
    limitation: 'Karbon publishes no task-creation operation. This is a property of the API, not of the tenant.',
  },
  {
    capability: 'UPDATE_TASK',
    support: 'UNSUPPORTED',
    fallback: 'A follow-up note is posted instead, and the app-side task is updated.',
    limitation:
      'PUT /v3/IntegrationTasks/{IntegrationTaskKey} updates only tasks Karbon created for a registered integration partner. Since no task can be created, no such key ever exists here.',
  },
  {
    capability: 'COMPLETE_TASK',
    support: 'UNSUPPORTED',
    fallback: 'A completion note is posted and the app-side review assignment is closed.',
    limitation: 'There is no task to complete, for the same reason task creation is unavailable.',
  },
  {
    capability: 'UPDATE_WORK_ITEM_STATUS',
    support: 'UNVERIFIED',
    operation: 'PUT /v3/WorkItems/{WorkItemKey}',
    limitation:
      'Work status values are tenant-specific. The mapping from application status to Karbon status is configuration, not code, and an unmapped status is skipped rather than guessed.',
  },
  {
    capability: 'RECEIVE_WEBHOOKS',
    support: 'UNVERIFIED',
    operation: 'POST /v3/WebhookSubscriptions with a WebhookType of Work, Note, Contact, User, IntegrationTask, Invoice or EstimateSummary',
    limitation:
      'Those seven types are the whole published set. The application does not depend on Karbon webhooks for correctness; it reconciles by polling on a schedule.',
  },
  {
    capability: 'DOCUMENT_UPLOAD_EVENTS',
    support: 'UNSUPPORTED',
    fallback:
      'The worker polls the file list on a schedule to detect new or replaced final documents, which is what drives stale-cover-letter detection.',
    limitation:
      'There is no file or document webhook type — the published set covers work items, notes, contacts, users, integration tasks, invoices and estimate summaries, and nothing else. A cover letter is never generated merely because a PDF appeared; all three trigger conditions must still be satisfied.',
  },
];

export function capabilityFor(capability: CapabilityReport['capability']): CapabilityReport {
  const found = KARBON_CAPABILITY_MATRIX.find((entry) => entry.capability === capability);
  return found ?? { capability, support: 'UNSUPPORTED' };
}

export function isUsable(capability: CapabilityReport['capability']): boolean {
  return capabilityFor(capability).support !== 'UNSUPPORTED';
}
