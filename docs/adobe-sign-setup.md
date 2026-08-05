# Adobe Acrobat Sign setup

**Not yet verified against a live Adobe account from this codebase.** The
client is implemented against Adobe's published REST API v6. The Integrations
screen reports the connection as unverified until a health check succeeds with
real credentials. Confirm the current official requirements before production
use.

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
