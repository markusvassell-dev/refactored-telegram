# Karbon capability matrix

## How to read this

| Level | Meaning |
| --- | --- |
| **Supported** | Implemented against a documented operation **and** observed working against a live tenant, via `pnpm verify:karbon`. |
| **Unverified** | Implemented against Karbon's published documentation, but **not yet run against a live tenant from this project**. |
| **Unsupported** | No officially supported API operation exists. The application uses the documented fallback and keeps the step visible in its own UI. |

**Verified 2026-08-06, revised 2026-08-10.** Health check, search, read work
item and read client were run against a live tenant and are `Supported`.

`List documents` was `Supported` and has been **demoted to `Unverified`**: every
observation of it has been an empty list, and an empty list is not evidence the
operation works. A 404 on a GET is mapped to "found nothing", so a collection
the API key cannot read is indistinguishable from one with nothing in it. It
moves back when a run returns a document.

Everything else remains `Unverified`, and the reasons are worth stating rather
than glossing:

- The **writes** — add comment, create task, upload document — need a run that
  writes. The tenant available is the firm's production Karbon, and there is no
  Karbon sandbox to use instead, so refusing production writes outright would
  have meant these were never verified at all. `upload document` is how a
  signed engagement letter reaches a client's permanent file; leaving it
  unverified indefinitely is its own risk.

  What the script refuses is writing to production *by accident*, or to a work
  item nobody chose. Create a work item you are willing to have test data
  written to — an internal one, not a client's — and name it:

  ```
  pnpm verify:karbon --allow-writes --write-to-production --work-item THAT_KEY
  ```

  It writes a note, a task and a small PDF, all named
  `ELEMENT ENGAGEMENTS VERIFICATION`, and tells you where to delete them.
  `neverOverwrite` is set, so nothing already in the file can be replaced.

- **Update work item status** stays unattempted even then: status values are
  tenant-specific and changing one alters real workflow state.
- **Download document** was skipped because the work item it landed on had no
  documents. Re-run with `--work-item` followed by the key of one that does;
  prior-year document discovery is the feature that depends on it.
- **Webhooks** need a subscription and an inbound request, which no script can
  arrange on its own.

The Integrations screen shows the same levels, and a connection stays
unverified until a health check succeeds with real credentials.

Browser automation and scraping are not used anywhere, and will not be added.

## Matrix

| Operation | Support | Official method | Fallback | Known limitation |
| --- | --- | --- | --- | --- |
| Search work items | Supported | `GET /v3/WorkItems` with OData `$filter` / `$top`, following `@odata.nextLink` | Broader query, then filter client-side | Pages are capped at 100. The provider follows `@odata.nextLink` until the result set is exhausted, taking only the `$skip` offset from the link rather than following a vendor-supplied URL. It re-filters every result locally, so a tenant that ignores an unsupported `$filter` produces a smaller result set, never a wrong one — which is precisely why it must page rather than read the first 100. |
| Read work item | Supported | `GET /v3/WorkItems/{WorkItemKey}` | — | — |
| Read client | Supported | `GET /v3/Organizations/{EntityKey}`, `GET /v3/Contacts/{EntityKey}` | Tries organisation, then contact | The entity type must be known in advance; it is stored on the client record. |
| Read contacts | Unverified | `GET /v3/Contacts` and the organisation contact collection | — | — |
| List documents | Unverified | `GET /v3/WorkItems/{WorkItemKey}/Documents` | — | Returns names and identifiers. **File names are never trusted on their own** — every prior-year candidate is verified against its contents. **Observed returning an empty list only.** A 404 on a GET is mapped to "found nothing", so a collection this API key cannot read looks identical to one with nothing in it; forty-seven work items and client records all returned zero, which is implausible for a working firm. `pnpm verify:karbon` now reports what the endpoint actually answered. |
| Download document | Unverified | `GET /v3/Documents/{DocumentId}/Content` | — | — |
| Upload document | Unverified | `POST /v3/WorkItems/{WorkItemKey}/Documents` | — | Approved, signed and certificate files are uploaded with `neverOverwrite`. On a name collision the upload is skipped, the collision is recorded, and the reviewer is told. |
| Add comment or note | Unverified | `POST /v3/Notes` | — | Comments are **notifications only**. They are never parsed as automation commands. |
| Create task | Unverified | `POST /v3/WorkItems/{WorkItemKey}/Tasks` — availability varies by tenant and plan | Posts a note carrying the review title and deep link; the authoritative task stays in the app's Review Queue | The client catches a non-retryable failure, falls back, and returns `SKIPPED_UNSUPPORTED` so the outcome is visible rather than silent. |
| Update task | Unverified | `PUT /v3/WorkItems/{WorkItemKey}/Tasks/{TaskId}` | Follow-up note; the app-side task is updated | — |
| Complete task | Unverified | `PUT` with a completed state | Completion note; the app-side review assignment is closed | — |
| Update work item status | Unverified | `PUT /v3/WorkItems/{WorkItemKey}` | Skipped when unmapped | Status values are tenant-specific. The mapping is configuration (`karbon_status_map`), not code. An unmapped status is skipped, never guessed. |
| Receive webhooks | Unverified | Karbon webhook subscriptions | Scheduled reconciliation poll | Event coverage varies, so **correctness never depends on a webhook arriving**. |
| Document upload events | **Unsupported** | — | The worker polls the work item document list on a schedule | This is what drives stale-cover-letter detection. A cover letter is never generated merely because a PDF appeared — all three trigger conditions still apply. |

## Authentication

The client sends the documented pair of headers:

```
Authorization: Bearer <bearer token>
AccessKey: <access key>
```

Both are entered on the Integrations screen, where they are encrypted with
`ENCRYPTION_KEY` and carry a sandbox-or-production flag. They are **not**
environment variables: the flag is what Test Mode keys off, and a credential
supplied through the environment would have no flag.

Confirm what Karbon actually issues against their current documentation before
production use. The field labels in this application are what it reads, not a
claim about what Karbon calls them.

## Behaviour when an operation is unavailable

1. Use the safest supported fallback.
2. Record a `KarbonActivity` row with outcome `SKIPPED_UNSUPPORTED`.
3. Surface the limitation to the user — the action result carries the message,
   and the Karbon Activity tab shows it.
4. Keep the authoritative workflow in this application, so nothing is lost.

Failing loudly or falling back visibly is always preferred to appearing to
succeed.

## Verification checklist

Before relying on any row above:

1. Configure a **sandbox** connection on the Integrations screen: enter the
   bearer token and access key, leave the environment set to Sandbox, set
   "Use this connection" to Yes, and save.
2. Press **Check connection**. It issues `GET /WorkItems?$top=1` and stores the
   result — success or the vendor's own error — against the connection.
3. Run the verification harness:

   ```bash
   pnpm verify:karbon                       # reads only
   pnpm verify:karbon --work-item 3xKmQp9   # a key you have chosen; not a placeholder
   pnpm verify:karbon --allow-writes --work-item 3xKmQp9
   ```

   It reads the credentials already stored on the Integrations screen — there
   is no second home for a Karbon credential, and none is passed on a command
   line where it would land in a shell history.

   It performs no writes unless asked, and never writes to a work item nobody
   named: without `--work-item` it would write to whichever one the search
   happened to return, which is somebody's live engagement. Against a
   production tenant it additionally requires `--write-to-production`, so that
   writing to real data is something an operator says rather than something
   that happens.

   It prints one line per capability with the vendor's own error text where
   something failed. A failure is evidence, not necessarily a defect: an
   operation genuinely unavailable on the tenant belongs in the table as
   `Unsupported` with its fallback, not left `Unverified`.

4. Update the level in `packages/integrations/src/karbon/capabilities.ts` from
   `UNVERIFIED` to `SUPPORTED` or `UNSUPPORTED`, with the fallback recorded.
5. Update this table to match.

`UPDATE_WORK_ITEM_STATUS` and `UPLOAD_DOCUMENT` are deliberately skipped by the
harness. Both change real state in a way a firm would have to undo: a status
value is tenant-specific and alters workflow, and an upload puts a file on a
client's work item. Verify those two by hand, on a work item you have chosen.

## Rate limits

Karbon asks for no more than **120 requests a minute**, per account per
application, and answers `429` with a `Retry-After` header. The limit is shared
with anything else the firm has connected to the same account.

The client holds itself to that budget with a token bucket — a burst is allowed
so long as the average holds — and honours `Retry-After` when it is throttled
anyway. Lower `requestsPerMinute` if the firm runs other integrations against
the same Karbon account.

This matters most during an annual rollout: several hundred engagements,
several calls each, drained by however many workers are running. Without a
limiter that is a throttled account, not a slow one.
