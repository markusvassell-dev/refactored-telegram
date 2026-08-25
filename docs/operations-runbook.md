# Operations runbook

Start at **Needs Attention** and **System Jobs**. Between them they surface
every blocked engagement, exhausted retry, declined or expired agreement, and
stale cover letter.

Every retry in this application is safe. Deterministic idempotency keys mean a
retry cannot produce a second draft, a second Karbon upload, a second Adobe
agreement, or a second client email.

---

## Failed generation

**Looks like:** engagement in `GENERATION_FAILED` or `NEEDS_ATTENTION`; a
dead-lettered `GENERATE_ENGAGEMENT_LETTER` job.

1. Read the job's user message on System Jobs — it is written for a human.
2. Open the engagement. The Overview tab lists exactly what is blocking it.

Common causes:

| Message | Action |
| --- | --- |
| "no approved master template" | Activate one on Templates. Do not substitute a different document type. |
| "a confirmed fee is required" | No prior-year fee was found. Enter a base fee or select a rate card on the Pricing tab. The application will not guess or emit a zero-dollar fee. |
| "confirm whether CSRS 4200 compilation services are included" | A reviewer confirms on the Services tab. Last year's answer is only a suggestion. |
| "required information is missing" | Fill the listed tokens on the Client Information tab. |
| "template and manifest are out of step" | The template changed and a conditional section anchor no longer matches. Re-run `pnpm templates:normalize` and publish a new version. |

Fix the cause, then press **Retry** on the job or **Generate draft** on the
engagement.

## Failed PDF conversion

**Looks like:** "PDF conversion failed"; `CONVERT_PDF` retrying then
dead-lettering.

1. **Check LibreOffice Writer is installed.** `libreoffice-core` alone cannot
   load `.docx` and fails with "source file could not be loaded". The image
   installs `libreoffice-writer`; a hand-built environment often does not.

   ```bash
   soffice --headless --convert-to pdf --outdir /tmp /path/to/test.docx
   ```

2. Check disk space in `DOCUMENT_TEMP_DIRECTORY`. Each conversion writes a
   scratch profile.
3. Check memory. LibreOffice is the heaviest step; if the worker is being
   OOM-killed, lower `WORKER_CONCURRENCY` or raise the memory limit. Note that
   until 25 August 2026 the worker ran one job at a time regardless of that
   setting, so this advice could not do anything; it can now, and a worker that
   started being OOM-killed around that date is running up to four handlers
   where it used to run one.
4. Retry the job.

Conversion is a pure function of the .docx, so a retry is always safe.

## Karbon outage

**Looks like:** `IntegrationError` on Karbon jobs; retries backing off.

Karbon failures are transient by default, so jobs retry with exponential
backoff and recover on their own. No action is needed for a short outage.

For a long one:

1. Confirm on Integrations — the health check shows the last result.
2. Work continues. Generation, review and approval do not need Karbon; only
   upload and notification do.
3. When it recovers, retry the dead-lettered upload jobs. The idempotency key
   prevents a duplicate upload for anything that actually landed.

If a specific *operation* is unavailable rather than the whole API, check the
capability matrix — the application already falls back, records
`SKIPPED_UNSUPPORTED`, and shows it on the Karbon Activity tab.

## Adobe Sign outage

**Looks like:** agreement creation failing; status synchronisation stalling.

A failed send moves the engagement back to `READY_TO_SEND`. **The approved
document is unchanged and can be re-sent safely** — the same idempotency key
resolves to the same agreement, so a retry after a timeout cannot create a
second one.

If the send genuinely timed out and you are unsure whether Adobe created the
agreement, retry. Deduplication is the point of the key.

Status reconciliation also runs on a schedule, so a missed webhook is caught
without intervention.

## Declined agreement

**Looks like:** `DECLINED` on Needs Attention.

Nothing is resent automatically. A person decides.

1. Read the decline reason on the Adobe Sign tab.
2. Contact the client.
3. If the letter needs changing: request changes, regenerate — a **new version**
   with a new approval and a new agreement.
4. If it does not: cancel and re-send deliberately.

Never edit an approved version. The database refuses, and the audit trail would
no longer match what was sent.

## Expired agreement

**Looks like:** `EXPIRED` on Needs Attention.

Also never resent automatically. The default expiry is 30 days with reminders
every three business days.

1. Confirm with the client that the letter is still wanted.
2. Confirm the fee and dates are still right — if the year has moved on, they
   may not be.
3. Move back to `READY_TO_SEND` and send again, which creates a new agreement
   under a new attempt number.

## Duplicate events

No action needed; this is worth knowing rather than doing.

- A repeated Adobe webhook is rejected by the unique constraint on the provider
  event id, recorded, and ignored. The endpoint still returns 200 so Adobe does
  not retry.
- A repeated enqueue returns the existing job.
- A repeated upload with the same key is a no-op.
- Two workers polling at once take different jobs.

The end-to-end tests cover each of these.

## Wrong client document

**Looks like:** a reviewer spots a prior-year document belonging to someone
else.

1. Source Documents tab — the verification score and the signals behind it are
   shown. Deselect the wrong document.
2. Select the correct one, or mark it for manual entry.
3. Regenerate.

The verification service asks rather than guesses whenever two candidates are
plausible, so this should be rare. If it happens repeatedly, the signals in
`packages/integrations/src/extraction/verification.ts` need tuning — check
whether business numbers and year-ends are actually populated on the client
record, since those carry the most weight.

Nothing was overwritten: the draft is a new version and the prior-year document
in Karbon is untouched.

## Cover-letter source replaced

**Looks like:** a package marked `STALE`; the engagement moved to
`COVER_LETTER_CHANGES_REQUESTED`.

This is the system working. A revised return or revised financial statements
changed the source fingerprint, so the cover letter no longer matches the
documents it was built from.

1. Review the replacement on the Source Documents tab.
2. Confirm which documents belong in the package.
3. Regenerate the cover letter.
4. **Re-approve.** The previous approval is void — it referred to a different
   set of documents, and the approval record names them.

Delivery is refused while a package is stale.

## Manual recovery

### Re-queue a dead-lettered job

System Jobs → **Retry**. Attempt count resets; the idempotency key does not.

### Release jobs from a crashed worker

Automatic: any job `RUNNING` for more than 15 minutes with no live worker is
reclaimed and re-queued.

### Move an engagement out of NEEDS_ATTENTION

Fix the underlying cause, then use the normal action. There is no "force
status" control, and adding one would defeat the point — the transition guard
exists precisely so a stuck engagement cannot be pushed past an approval.

### Purge working copies early

Automatic on the retention schedule. To force it, enqueue
`PURGE_TEMPORARY_FILES`. Karbon holds every final document, so this is always
safe.

### Decide whether a storage volume can be detached

Read the boot log's storage line, or Settings, which reports the same thing:

```
      document storage         durable, 0 file(s) on disk
```

Documents are database rows, so a volume decides nothing for anything written
since that change. The count is what matters — `0 file(s)` means detaching
destroys nothing. **Deleting a Railway volume destroys its contents**, so read
the count before, not after.

A non-zero count is files predating the move to database storage. They are
readable (`DocumentStore.get` falls back to the filesystem when a reference has
no row) and, on container disk, are discarded by the next deploy. A warning
appears only in that pairing: files present **and** a disk that will not survive.

### Confirm what was actually sent

Audit Log, filtered by engagement or correlation id. Every generation,
approval, upload, send and signing event is there with the file hash, and it
cannot have been altered — the database rejects any update or delete.
