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
    // Demoted deliberately. Every observation of this so far has been an empty
    // list, and an empty list is not evidence the operation works: a 404 on a
    // GET is mapped to "found nothing", so a collection the API key cannot read
    // is indistinguishable from one with nothing in it. Forty-seven work items
    // and client records returned zero, which is implausible for a working firm.
    // `describeDocumentAccess` reports what the endpoint actually answered; this
    // row moves back to SUPPORTED when a run returns a document.
    support: 'UNVERIFIED',
    operation: 'GET /v3/WorkItems/{WorkItemKey}/Documents',
    limitation:
      'Document listings expose file names and identifiers. File names are never trusted on their own — every candidate prior-year document is verified against its content. Observed returning an empty list only, which does not distinguish "no documents" from "not readable by this API key".',
  },
  {
    capability: 'DOWNLOAD_DOCUMENT',
    support: 'UNVERIFIED',
    operation: 'GET /v3/Documents/{DocumentId}/Content',
  },
  {
    capability: 'UPLOAD_DOCUMENT',
    support: 'UNVERIFIED',
    operation: 'POST /v3/WorkItems/{WorkItemKey}/Documents',
    limitation:
      'The application never overwrites an existing approved, signed, or certificate document. If a name collides it uploads under a suffixed name and records the collision.',
  },
  {
    capability: 'ADD_COMMENT',
    support: 'UNVERIFIED',
    operation: 'POST /v3/Notes',
    limitation:
      'Comments are notifications only. They are never parsed as automation commands — generation is triggered by an explicit action, a bulk rollout, or a configured Work Item status.',
  },
  {
    capability: 'CREATE_TASK',
    support: 'UNVERIFIED',
    operation: 'POST /v3/WorkItems/{WorkItemKey}/Tasks (availability varies by tenant and plan)',
    fallback:
      'When task creation is unavailable the application posts a note containing the review title and a deep link, and keeps the authoritative review task in its own Review Queue.',
  },
  {
    capability: 'UPDATE_TASK',
    support: 'UNVERIFIED',
    operation: 'PUT /v3/WorkItems/{WorkItemKey}/Tasks/{TaskId}',
    fallback: 'A follow-up note is posted instead, and the app-side task is updated.',
  },
  {
    capability: 'COMPLETE_TASK',
    support: 'UNVERIFIED',
    operation: 'PUT /v3/WorkItems/{WorkItemKey}/Tasks/{TaskId} with a completed state',
    fallback: 'A completion note is posted and the app-side review assignment is closed.',
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
    operation: 'Karbon webhook subscriptions',
    limitation:
      'Event coverage varies. The application does not depend on Karbon webhooks for correctness; it reconciles by polling on a schedule.',
  },
  {
    capability: 'DOCUMENT_UPLOAD_EVENTS',
    support: 'UNSUPPORTED',
    fallback:
      'The worker polls the Work Item document list on a schedule to detect new or replaced final documents, which is what drives stale-cover-letter detection.',
    limitation:
      'A cover letter is never generated merely because a PDF appeared. All three trigger conditions must still be satisfied.',
  },
];

export function capabilityFor(capability: CapabilityReport['capability']): CapabilityReport {
  const found = KARBON_CAPABILITY_MATRIX.find((entry) => entry.capability === capability);
  return found ?? { capability, support: 'UNSUPPORTED' };
}

export function isUsable(capability: CapabilityReport['capability']): boolean {
  return capabilityFor(capability).support !== 'UNSUPPORTED';
}
