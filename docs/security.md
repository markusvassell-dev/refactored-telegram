# Security

This application handles personal, corporate, trust, tax and financial
information. The controls below are implemented, not aspirational; where
something is a known gap it says so.

## Authentication

Microsoft Entra ID, OpenID Connect authorization code flow with PKCE. MFA and
conditional access are enforced by the firm's tenant policy, not here.

- The `state` and `nonce` are generated server-side and the returned `nonce` is
  compared before any claim is trusted.
- The token is fetched over TLS directly from the Microsoft token endpoint
  using the confidential-client secret.
- A local development login exists, but `DevelopmentIdentityProvider` refuses
  to construct outside `development` and `test`, the route refuses to run, and
  the environment schema refuses to boot with `DEV_LOGIN_ENABLED` in staging or
  production. Three independent refusals.

### Sessions

An AES-256-GCM sealed cookie with a key derived from `SESSION_SECRET` via HKDF.
`httpOnly`, `sameSite=lax`, `secure` outside development, eight-hour expiry.

It carries only a user id, an expiry and a CSRF token. **Roles are re-read from
the database on every request**, so revoking a role takes effect immediately
rather than at the next sign-in.

## Authorisation

Five roles, additive permissions. Every server action and page calls
`requirePermission`; the browser tests confirm a read-only user is refused
server-side, not merely shown fewer links.

An **administrator does not get approval or sending rights**. Managing the
system is not the same as approving a client-facing legal document. Somebody
who needs both holds both roles.

### Separation of duties

Enforced independently of permissions. Nobody may approve:

- a draft they generated,
- a wording change they authored,
- a fee override they entered,
- a cover letter they generated.

## Data flow

| Data | Where it lives | Retention |
| --- | --- | --- |
| Final and signed documents | **Karbon** — the system of record | Karbon's policy |
| Working copies (draft .docx/.pdf) | Local storage, mode 0600 | `DOCUMENT_RETENTION_HOURS`, default 72 |
| Extracted values and evidence | Database | With the engagement |
| Evidence excerpts | Database, truncated to 400 characters | With the engagement |
| Audit events | Database, append-only | Indefinite |
| Integration credentials | Database, envelope-encrypted | Until rotated |

The database is deliberately **not** the permanent primary store for complete
client tax files. Evidence stores a citation and a short excerpt, never a whole
document.

## Secrets

Everything comes from the environment or the platform secret manager. Nothing
secret is committed; `.env` is git-ignored and `.env.example` carries no values.

Integration credentials are stored envelope-encrypted (AES-256-GCM, key derived
from `ENCRYPTION_KEY` per purpose) and are never rendered to a page — the
Integrations screen shows only whether credentials are configured.

Rotation: update the connection, which re-encrypts under the current key, then
run a health check. `IntegrationConnection.rotatedAt` records when.

## File handling

- Allowed types: `.docx` and `.pdf` only. This applies equally to a file a user
  uploads: the extension decides what the application *claims* the file is, and
  the magic-number check then decides whether that claim is true.
- **Content is checked against the declared type** by magic number; a mismatch
  is refused.
- Size limited by `DOCUMENT_MAX_UPLOAD_BYTES` (default 25 MB).
- Path traversal blocked — a resolved path must stay inside the storage root.
- Downloads only through short-lived signed links (default 300 s; the review
  workspace issues 900 s links), verified independently of the session, served
  `no-store` with `nosniff`.
- A reviewer reads the PDF in place, in a same-origin `<iframe>` pointed at one
  of those signed links. `frame-src 'self' blob:` permits exactly that and
  nothing else, and `frame-ancestors 'none'` still forbids anyone framing this
  application. The link carries no session of its own: an expired link stops
  working even in an open tab, and a copied URL is useless to anyone who is not
  signed in.

Server actions accept a body up to 26 MB so an ordinary scanned letter is not
rejected with an opaque framework error. `DOCUMENT_MAX_UPLOAD_BYTES` is what
actually enforces the limit, and it refuses with a message naming the size.

**Malware scanning is not implemented.** The integration point is
`DocumentStore.put`, which already validates type and size and is the single
choke point every stored byte passes through. A scanner should be called there
before the write.

## Web security

- CSP with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-src 'self' blob:`; `X-Frame-Options: DENY`;
  `nosniff`; a strict referrer policy; a restrictive permissions policy.
- CSRF: a token bound to the session, checked by every mutating action, on top
  of the same-origin guarantee of server actions.
- Errors show a digest reference; stack traces stay in the server logs.

**Known gap:** the production CSP still allows `'unsafe-inline'` for scripts,
which Next.js needs for hydration data unless a nonce is issued from
middleware. `'unsafe-eval'` is allowed in development only, because React
Refresh requires it. Moving to a nonce-based policy is the intended follow-up.

## Logging

Redaction happens in the logger, so it cannot be forgotten at a call site.

- Secret-looking keys (password, token, secret, key, authorization, cookie,
  session, credential, signature) are dropped entirely.
- Client identifiers (email, phone, address, business number, trust account,
  SIN, date of birth) are masked.
- Free text is scanned for SIN-shaped digits, email addresses and bearer
  tokens.
- Binary values are replaced by a byte count — a document body cannot be
  logged.

The same redaction runs over audit `beforeValue` / `afterValue` before storage.

Full social insurance numbers are neither displayed nor stored.

## Audit trail

Append-only, enforced by the database: a trigger rejects `UPDATE` and `DELETE`
on `audit_event` outright. There is no code path in this application — or any
other client of the database — that can rewrite history.

`audit_event` deliberately has **no foreign keys**. A key with
`ON DELETE SET NULL` performs an update, which the trigger correctly refuses;
more importantly, an audit trail must outlive the records it describes.

Every event carries a correlation id threading a whole operation together.

## Rate limiting

**Not implemented in the application.** It is expected at the platform edge.
The paths worth limiting are the sign-in callback and the two webhook
endpoints. Both webhooks already reject an unverified payload before doing any
work, which bounds the cost of an unauthenticated flood.

## Integration security

- Adobe webhooks: constant-time signature comparison, and exactly-once
  processing guaranteed by a unique constraint on the provider event id.
- Karbon webhooks: HMAC verification; a work item status triggers generation
  only when an administrator has configured that exact status. **A free-text
  comment never triggers anything.**
- All integration operations are idempotent under deterministic keys, so a
  retry cannot duplicate a document, an upload, or an agreement.

## AI data handling

Disabled by default. Nothing is sent to an AI provider unless an administrator
enables it and configures a provider.

When enabled:

- it runs **only after** deterministic extraction, and only for tokens that
  failed;
- only the minimum necessary text is sent, capped at 60,000 characters;
- output must satisfy a strict schema or it is discarded;
- a value whose supporting quotation does not actually appear in the document
  is discarded as invented;
- values below `AI_MIN_CONFIDENCE` are reported as missing so a person enters
  them;
- every call is logged with the document id, token count and character count —
  never the content.

AI never rewrites legal wording, approves anything, resolves a conflict, or
makes a deadline decision.

## Incident considerations

1. **Suspected credential compromise** — disable the connection on the
   Integrations screen, rotate at the vendor, store the new credentials, health
   check. Filter the audit log by `IntegrationConnection` for the history.
2. **Suspected unauthorised access** — deactivate the user (`isActive: false`),
   which takes effect on their next request. Filter the audit log by user.
3. **Wrong document sent** — the audit trail records the file hash approved,
   who approved it, and when. Cancel the Adobe agreement; prior-year and signed
   documents in Karbon were never overwritten.
4. **Data exposure question** — the audit trail answers what was generated,
   approved, uploaded and sent, for every engagement, immutably.

## Content Security Policy and sign-in

`form-action` is checked against where a form submission **ends up**, not only
where it was aimed. Sign-in posts to this application and is answered with a
redirect to Microsoft, so a policy of `form-action 'self'` blocks it — and
browsers block it silently: the button appears to do nothing, and the reason
goes only to the developer console.

The policy therefore lists the Entra sign-in host explicitly. It is configurable
through `ENTRA_SIGN_IN_HOSTS` because a national cloud uses a different one
(`login.microsoftonline.us` for US Government, and so on), and it stays a short
explicit list rather than a wildcard: anything named there can receive a form
submission from this application.
