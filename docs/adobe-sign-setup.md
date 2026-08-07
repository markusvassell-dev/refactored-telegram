# Adobe Acrobat Sign setup

**Not yet verified against a live Adobe account from this codebase.** The
client is implemented against Adobe's published REST API v6. The Integrations
screen reports the connection as unverified until a health check succeeds with
real credentials. Confirm the current official requirements before production
use.

## 0. Confirm the account has an API at all

**Acrobat Pro with eSign features is not Acrobat Sign.** They are different
products, and only the second has an API. Acrobat Pro's e-signature feature has
no API applications page, no OAuth, and nothing to connect to.

The test takes ten seconds. Sign in and open:

```
https://secure.adobesign.com
```

| What happens | What it means |
| --- | --- |
| It loads into Send / Manage / Reports | The account has Acrobat Sign |
| It redirects to a marketing page (`adobe.com/acrobat/business/sign.html?fromES=true`) | **That login has no Acrobat Sign entitlement.** Either the firm's Sign account is under a different login, or this person has not been added to it |

A redirect is not a permissions problem to work around — there is nothing
behind it for that login.

### If the firm already uses Acrobat Sign

The account almost certainly exists under someone else's login. What is needed
from whoever administers it:

1. **Add the integrator as a user** on the Acrobat Sign account, and make them
   an **Account Administrator**. The API Applications page is admin-only; a
   normal user seat can send agreements and will still see no API section.
2. Or, if that is not acceptable, have the administrator complete sections 1
   and 2 below themselves and hand over the client id, client secret and
   refresh token. All three are credentials — they belong in the Integrations
   screen, not in an email thread.

### Which scopes, and why `:self` is enough

Acrobat Sign scopes carry a modifier: `:self`, `:group` or `:account`.

This application authenticates as **one identity** and only ever reads back
agreements it created itself, so:

```
agreement_read:self
agreement_write:self
```

is sufficient, and is the least privilege that works. It also matters
practically: **only an account administrator can approve an `:account` scope**,
so asking for one raises the bar for no benefit here.

`:account` would only be needed if the application had to see agreements that
people created by hand in the Acrobat Sign UI. It does not — every agreement it
cares about, it sent.

## 1. Register the application

In the Adobe Acrobat Sign account, under **Account → Adobe Sign API → API
Applications**, create an application for **Customer** use.

Configure OAuth with the redirect URI:

```
https://<your-app-domain>/api/integrations/adobe-sign/callback
```

Enable the scopes the application needs:

| Scope | Used for |
| --- | --- |
| `agreement_write` | Creating agreements |
| `agreement_read` | Status, signers, downloads |
| `agreement_send` | Sending for signature |
| `webhook_write` | Managing the webhook subscription |
| `user_read` | The health check (`/users/me`) |

## 2. OAuth

Adobe issues a refresh token that this application exchanges for short-lived
access tokens. The refresh token is the credential to protect; it is stored
envelope-encrypted.

1. Complete the authorization-code flow once to obtain the refresh token.
2. Store `ADOBE_SIGN_CLIENT_ID`, `ADOBE_SIGN_CLIENT_SECRET`,
   `ADOBE_SIGN_REFRESH_TOKEN` and the region-specific
   `ADOBE_SIGN_API_BASE_URL` (for example `https://api.na1.adobesign.com`) on
   the Integrations screen.
3. Run the health check.

The client refreshes the access token automatically, one minute before expiry.

**The base URL is region-specific.** Using the wrong shard produces confusing
authorisation failures.

## 3. Webhooks

Create a webhook pointing at:

```
https://<your-app-domain>/api/webhooks/adobe-sign
```

Subscribe to at least: agreement created, sent, viewed, delegated, signed by
each participant, completed, declined, cancelled, expired.

Adobe verifies the endpoint with a `GET` carrying `x-adobesign-clientid`; the
route echoes it back, which is what the verification handshake expects.

Delivered events are verified before they are trusted, and de-duplicated by
Adobe's event id using a unique constraint — a redelivery is recorded and
ignored, and the endpoint still returns 200 so Adobe does not retry.

Webhooks are an optimisation, not a dependency. A scheduled reconciliation job
polls agreement status regardless, so a missed event self-corrects.

## 4. Signature placement

Placement uses Adobe **text tags** embedded at manifest-defined anchors, not
coordinates, so the tag stays with its paragraph when content above it changes
length.

```
{{Sig_es_:signer1:signature}}
{{Dte_es_:signer1:date}}
```

A draft renders the anchor as an underscore rule; only a document rendered for
signature carries the tags. Anchor values always override supplied values, so a
prior-year signature or signed date can never be written into a new document.

Only names, email addresses, roles and titles are prefilled. Never a signature,
never a signed date.

## 5. Signing order

Signers sharing an order form one participant set and sign in parallel.

| Engagement | Order |
| --- | --- |
| **T1 joint** | Both taxpayers at order 1, in parallel. Firm signer at order 2, after both. |
| **T2** | Authorized signing officer at order 1. Firm representative at order 2. |
| **T3** | Trustee / executor / administrator / liquidator at order 1. Firm signer at order 2. |

The firm signer is only included when a firm signature is required.

## 6. Defaults

| Setting | Default | Configurable |
| --- | --- | --- |
| Reminder frequency | Every 3 business days | Yes |
| Expiry | 30 days | Yes |
| CC | Assigned engagement lead | Yes |
| Language | English (`en_US`) | Yes |
| Delegation | **Off** | Administrator |
| Authentication | Email verification | Stronger methods configurable |

## 7. Test configuration

Use a **sandbox** Adobe account and mark the connection as sandbox.

With Test Mode on and no sandbox configured, the application hands out
`BlockedAdobeSignProvider`, which refuses every send. A production agreement is
impossible by construction, not by convention.

Without any connection, `MockAdobeSignProvider` is used. It is clearly labelled
as a mock on the Integrations screen and reproduces the behaviours the workflow
depends on — idempotent creation, parallel signing, decline, expiry, and signed
webhook payloads — so the workflow can be exercised end to end without
contacting Adobe.

## 8. Production activation

Deliberately more than one step:

1. Verify the sandbox connection with a real health check.
2. Complete a full engagement in Test Mode.
3. Store production credentials and clear the sandbox flag.
4. Set `ALLOW_PRODUCTION_SENDING=true` and `TEST_MODE=false`.
5. An administrator arms production sending in Settings.

Both the environment and the administrator action are required. Either alone
leaves sending disabled, and the environment's `TEST_MODE` cannot be overridden
from inside the application.

## Common errors

| Symptom | Cause |
| --- | --- |
| `OAuth refresh failed with HTTP 400` | Refresh token revoked or issued for a different application. Re-authorise. |
| `HTTP 401` on every call | Wrong region in the base URL. |
| Agreement created but nobody notified | The signing order left everyone waiting. Confirm at least one participant is at the lowest order. |
| Signature field in the wrong place | The anchor text no longer matches after a template edit. Re-normalise and publish a new version. |
| Duplicate agreement suspected | Check `AdobeAgreement.idempotencyKey`. The database also enforces at most one live agreement per engagement, so a duplicate cannot exist. |
| Webhook returns 400 | Signature verification failed. Confirm `ADOBE_SIGN_WEBHOOK_SECRET` matches. |
| Signed PDF not in Karbon | Check `RETRIEVE_SIGNED_DOCUMENTS` on System Jobs. If the name collided, the upload was skipped rather than overwriting — the message says so. |

## Verifying the connection

```bash
pnpm verify:adobe
```

**It never writes.** Karbon's writes are a note and a task on a work item —
untidy at worst. Adobe's principal write is an agreement, and creating one
emails a real person asking them to sign a document. There is no version of
that which belongs in a verification script, so the write path is not offered
at all, not even behind a flag.

What it proves without sending anything:

| Check | What a failure means |
| --- | --- |
| `OAUTH_AND_REACHABILITY` | The refresh token has expired or been revoked; the API base URL is for a different region than the account; or the integration lacks `agreement_read` |
| `DUPLICATE_CHECK` | The agreement list cannot be read — which is worse than it sounds; see below |

Signing itself is verified by running one engagement end to end with Test Mode
on. That is the only way to see a real agreement without the risk of sending
one to a client.

## Rate limits

Acrobat Sign publishes no fixed number — the rate depends on the service plan —
but it throttles with `429` and a `Retry-After`, and Adobe's guidance is
explicit that a client should retry only after the interval that header names.
The client honours it, and paces itself with a token bucket so a bulk status
sync does not arrive all at once.

Polling is limited far more tightly than ordinary calls: **three identical
calls per one-minute interval** on Global, Enterprise and Developer tiers, and
per three-minute interval elsewhere. `SYNC_ADOBE_STATUS` walks every
outstanding agreement in one pass, so on a large rollout the limiter is what
keeps that from becoming a throttled account.

## The duplicate check

`findByExternalId` runs before every agreement creation and is the only thing
standing between a retried job and a client receiving a second signature
request for a letter already sent to them.

It must therefore never answer "no existing agreement" unless it actually
looked and found none. It used to: the client returned `null` on any 404, and
`null?.userAgreementList` is `undefined`, so a missing endpoint, a revoked
scope and a path typo all read as "nothing found" — and the caller then created
a duplicate. A lookup that cannot complete now throws, so a retry fails loudly
instead.
