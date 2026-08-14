# Karbon capability matrix

## How to read this

| Level | Meaning |
| --- | --- |
| **Supported** | Implemented against a documented operation **and** observed working against a live tenant, via `pnpm verify:karbon`. |
| **Unverified** | Implemented against Karbon's published documentation, but **not yet run against a live tenant from this project**. |
| **Unsupported** | No officially supported API operation exists. The application uses the documented fallback and keeps the step visible in its own UI. |

**Verified 2026-08-06, revised 2026-08-10.** Every capability this application
depends on has now been run against the firm's live tenant and is `Supported`,
including both writes. The three rows that are `Unsupported` are properties of
Karbon's published API rather than of the tenant.

### What the write-enabled run found

A run with `--allow-writes` against the firm's production tenant failed on
notes, tasks and uploads. Tracing those failures against [Karbon's published
OpenAPI specification](https://github.com/karbonhq/karbon-api-reference) showed
the cause was not permissions or plan: **this application was calling endpoints
Karbon does not publish.**

| What this application called | What Karbon actually publishes |
| --- | --- |
| `GET`/`POST /v3/WorkItems/{key}/Documents` | `GET /v3/FileList/{EntityType}?EntityKey=`, `POST /v3/Files` |
| `GET`/`POST /v3/{Organizations,Contacts}/{key}/Documents` | the same `FileList` endpoint, with `EntityType` |
| `GET /v3/Documents/{id}/Content` | `GET /v3/Files?token=`, the token issued with a file listing |
| `POST /v3/Notes` with `RelatedEntityKey`/`RelatedEntityType` | `AuthorEmailAddress`, `Subject` and `Body` are required; the link is a `Timelines` array |
| `POST /v3/WorkItems/{key}/Tasks` | **nothing.** There is no task-creation operation |
| `PUT /v3/Tasks/{id}` | **nothing.** `/v3/IntegrationTasks/{key}` updates only tasks Karbon created for a registered integration partner |

The document listing is the one worth dwelling on. A 404 on a GET is mapped to
"found nothing", which is right for a missing record and wrong here: the path
did not exist, so **every work item and every client record in the tenant
reported zero documents**. Nothing threw, nothing was logged as a fault, and
prior-year document discovery would have found nothing for ever while looking
entirely healthy. Forty-seven records returning zero is what finally gave it
away.

### What the corrected endpoints then did

A read-only run on 2026-08-10 against the same tenant, on build `bbcefd6`:

```
[ ok ] LIST_DOCUMENTS      0 document(s)
[ ok ] DOWNLOAD_DOCUMENT   APAgingDetail 2023.pdf, 31118 bytes, application/pdf
                           (from work item QGMkCVvHTVD)
```

**A file came out of Karbon** — the first time in this project. That single line
proves both halves of the two-step: the listing that issues the download token,
and the request that spends it. `List documents` and `Download document` move to
`Supported`.

The `0 document(s)` above it is now an ordinary answer rather than a suspicious
one. It is the subject work item, which genuinely has no files; the harness kept
searching and found one three work items later. Before the fix, *every* record
in the tenant read zero, which is what gave the broken path away.

### The write-enabled run, after the corrections

```
[ ok ] ADD_COMMENT        SUCCEEDED (3bGz9QbNmxZt)
[ ok ] UPLOAD_DOCUMENT    SKIPPED_DUPLICATE — a document of that name already
                          exists on this work item and was not replaced
8 passed, 0 failed, 2 skipped
```

Both writes move to `Supported`. `UPLOAD_DOCUMENT` returned a real file id on
the run before this one; this run returned `SKIPPED_DUPLICATE` against the file
that upload created, which verifies the other half — **the never-overwrite guard
actually fires**. That guard had never been able to detect a collision, because
it looked for one in a listing that was always empty.

Getting the note to post took two corrections. The body was missing all three
fields Karbon requires, and the author address has to belong to a user on the
tenant — the first address configured did not, which Karbon answers with a `400`
naming no alternative. `KARBON_NOTE_AUTHOR_EMAIL` now names a current user.

### What is left, and why

- The **writes** are done. There is no Karbon sandbox, so verifying them meant
  writing to the firm's production tenant — and refusing that outright would
  have meant `upload document`, the step a signed engagement letter depends on
  to reach a client's permanent file, was never verified at all.

  To re-run it, **create a dummy client in Karbon** — something obviously not
  real, such as `Matador Pizza` — and a work item under it. Not a client's work
  item, and not a real internal one either: a verification note lands on a
  record somebody may later read as genuine, and a note nobody can account for
  is worse than no note. Open that work item and take the key from
  the end of its URL. A key looks like `wfyFwlWGZms`: eleven or twelve letters
  and digits, no underscores. Then run the command with **that key in place of
  the last word**:

  ```
  pnpm verify:karbon --allow-writes --write-to-production --work-item PasteTheKeyHere
  ```

  `PasteTheKeyHere` is not a key and will not work — it is there to be replaced.
  If it reaches the script the run stops before writing anything, because a key
  that resolves to no work item used to fall through to whichever one the search
  returned first, which is a real client's engagement.

  It writes a note and a small PDF, both named
  `ELEMENT ENGAGEMENTS VERIFICATION`, and tells you where to delete them.
  `neverOverwrite` is set, so nothing already in the file can be replaced.

  `KARBON_NOTE_AUTHOR_EMAIL` must name a current Karbon user. Karbon rejects any
  other address with a `400` that names no alternative; a failed run now lists
  the addresses it will accept.

- **Create, update and complete task** are now `Unsupported` and are no longer
  attempted at all. This is a property of the API, not of the tenant: Karbon
  publishes no operation that creates a task. The application posts a note
  carrying the review title and a deep link, and the authoritative task lives
  in the Review Queue.
- **Update work item status** stays unattempted: status values are
  tenant-specific and changing one alters real workflow state.
- **Download document** is done — see above. The harness searching past the
  first work item is what made it possible: the subject had no files, and giving
  up there is what left this unverified for so long.
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
| Read client | Supported | `GET /v3/Organizations/{EntityKey}?$expand=Contacts,BusinessCards`, `GET /v3/Contacts/{EntityKey}?$expand=BusinessCards` | Tries organisation, then contact | **`$expand` is not optional.** A bare read returns the name and keys only — no contacts, no address, no telephone. Contacts are one expansion and the address/e-mail/telephone live on a Business Card, which is another. Karbon publishes **no business-number field**; `UserDefinedIdentifier` is free text and is accepted only when number-shaped, because a wrong CRA number on a T2 letter is worse than a blank one. |
| List the firm's clients | Unverified | `GET /v3/Organizations` and `GET /v3/Contacts`, paged with `$top`/`$skip` | — | **Neither was ever called until 2026-08-14.** Client discovery ran entirely through work items — search them, take the distinct client keys — which answers "who has work open", not "who are the clients". A new client, a dormant one, and any client whose work predates the window examined were all invisible, and the screen reported the count as clients found in Karbon. Both entity types are read, because a corporation is an Organization and an individual filing a T1 is a Contact. `ContactType` is returned verbatim and **never filtered on**: the vocabulary is tenant-defined via `/v3/TenantSettings`, so filtering for `'Client'` would silently drop every client of a firm that calls them something else. Work-item discovery remains available and now says what it is. |
| Read contacts | Unverified | `GET /v3/Contacts` and the organisation contact collection | — | — |
| List documents | **Supported** | `GET /v3/FileList/{EntityType}?EntityKey=…`, where `EntityType` is `WorkItem`, `Organization` or `Contact` | — | Returns names and identifiers. **File names are never trusted on their own** — every prior-year candidate is verified against its contents. A client key names an organisation or a contact and only Karbon knows which, so both are tried in that order; an empty list from a recognised entity is a real answer and stops the search, a 404 is not. **Only `WorkItem` has been observed returning a file**; the other two entity types share the code path but have not yet produced one. |
| Read a client's whole library | Unverified | `GET /v3/FileList/{EntityType}` once per entity, plus `GET /v3/WorkItems` to enumerate them | — | **Karbon publishes no operation that returns a client's documents**, and `FileList` takes no paging parameters — it declares `EntityType` and `EntityKey`, nothing else, so it answers for exactly one entity. In Karbon's data model a client does not have documents: its organisation does, its contacts do, and each of its work items does. Its own Documents tab is an aggregate, and so is this — which is why a client with 93 documents returns almost none of them from the organisation scope alone. One request per entity means tens of requests for an established client, any of which can fail, so the result carries a `complete` flag. **A library assembled from nineteen of twenty scopes is not a smaller library, it is a wrong one**, and is never presented as the client's documents. Verify with `pnpm verify:karbon --library CLIENT_KEY`. |
| Download document | **Supported** | `GET /v3/Files?token=…` | — | There is no download by identifier. Karbon issues a signed token alongside a file listing, documented as valid for **fifteen minutes**, so a download first lists the entity holding the file. Tokens are never persisted, and only the token is taken from the vendor-supplied `DownloadUrl` — never the host. |
| Upload document | **Supported** | `POST /v3/Files`, `multipart/form-data` with `file` and `workitem_keys` | — | Approved, signed and certificate files are uploaded with `neverOverwrite`. On a name collision the upload is skipped, the collision is recorded, and the reviewer is told. |
| Add comment or note | **Supported** | `POST /v3/Notes` with `AuthorEmailAddress`, `Subject`, `Body` and a `Timelines` entry naming the work item | — | Karbon **requires** an author who is a user on the tenant. Set `KARBON_NOTE_AUTHOR_EMAIL`; otherwise the first user the tenant lists is used. Comments are **notifications only** — never parsed as automation commands. |
| Create task | **Unsupported** | — | Posts a note carrying the review title and deep link; the authoritative task stays in the app's Review Queue | Karbon publishes no task-creation operation. `/v3/IntegrationTasks` is `GET`-only. No request is attempted; the call returns `SKIPPED_UNSUPPORTED` so the limitation is visible in the Karbon Activity tab rather than silent. |
| Update task | **Unsupported** | — | Follow-up note; the app-side task is updated | `PUT /v3/IntegrationTasks/{IntegrationTaskKey}` updates only tasks Karbon created for a registered integration partner. No task can be created here, so no such key exists. |
| Complete task | **Unsupported** | — | Completion note; the app-side review assignment is closed | Nothing to complete, for the same reason. |
| Update work item status | Unverified | `PUT /v3/WorkItems/{WorkItemKey}` | Skipped when unmapped | Status values are tenant-specific. The mapping is configuration (`karbon_status_map`), not code. An unmapped status is skipped, never guessed. |
| Receive webhooks | Unverified | `POST /v3/WebhookSubscriptions` | Scheduled reconciliation poll | The published types are `Work`, `Note`, `Contact`, `User`, `IntegrationTask`, `Invoice` and `EstimateSummary` — that is the whole set. **Correctness never depends on a webhook arriving.** |
| Document upload events | **Unsupported** | — | The worker polls the file list on a schedule | There is no file or document webhook type. This is what drives stale-cover-letter detection. A cover letter is never generated merely because a PDF appeared — all three trigger conditions still apply. |

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

## Where the endpoint shapes come from

Karbon publishes an OpenAPI 3.1 specification at
[github.com/karbonhq/karbon-api-reference](https://github.com/karbonhq/karbon-api-reference).
Every path, request body and response shape in this document was read from it
rather than inferred from behaviour. That distinction earned its keep: three of
the endpoints this application called did not exist, and the API answered each
of them with a 404 that was indistinguishable from an ordinary "not found".

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
   pnpm verify:karbon --library 3bXVhdMHgc9P  # one client's whole document library
   ```

   `--library` answers a different question from the rest. The other checks
   prove each operation works; this proves the aggregate is **whole**, which is
   the only thing a client's document list is judged on. It prints the count
   beside the number of places read and lists every scope that held files, so
   "93 documents from 41 places" can be told apart from "93 documents, and four
   work items we could not read". A read that returns nothing **fails** rather
   than passing quietly: an empty library from a client who has files is the
   exact failure that raises no error, and it is why every work item in this
   tenant reported zero documents for months.

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

`UPDATE_WORK_ITEM_STATUS` is deliberately skipped by the harness: a status value
is tenant-specific and changing one alters real workflow state, which a firm
would then have to undo.

`UPLOAD_DOCUMENT` **is** attempted under `--allow-writes`, on the work item you
named and nowhere else. It was previously left to be "verified by hand", which
meant it was never verified at all — and it is the step a signed engagement
letter depends on to reach a client's permanent file.

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
