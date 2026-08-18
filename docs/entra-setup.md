# Microsoft Entra ID sign-in

Production authentication. The development login refuses to run outside
development and test, so this is the only way into a deployed instance.

**Working in production since 14 August 2026.** A live sign-in against the
Gordon and Company tenant issued an administrator session, so the flow below is
described from something that happened rather than something expected to.

The application registration already exists in the Gordon and Company tenant:

| | |
| --- | --- |
| Name | **Element Engagements** |
| Application (client) ID | `6723d301-9353-4718-ae5e-52b24f3560eb` |
| Created | 6 August 2026 |

What follows is gathering four values and checking three settings on it.

## 1. The four values

Open [portal.azure.com](https://portal.azure.com) → **App registrations** →
**Element Engagements**.

| Variable | Where it comes from |
| --- | --- |
| `ENTRA_TENANT_ID` | Overview → **Directory (tenant) ID** |
| `ENTRA_CLIENT_ID` | Overview → **Application (client) ID** — the value above |
| `ENTRA_CLIENT_SECRET` | Certificates & secrets → see below |
| `ENTRA_REDIRECT_URI` | `https://elementweb-production.up.railway.app/api/auth/entra/callback` |

**The secret value cannot be read back.** The portal shows it once, at creation,
and only its description and expiry afterwards. The registration reports a
current secret, but if nobody saved the value when it was made, create a new one:
**Certificates & secrets → New client secret**, copy the **Value** column — not
the Secret ID — immediately.

Set an expiry you will survive. A secret that expires in six months takes sign-in
down on a date nobody has written anywhere.

## 2. Three things to check on the registration

**Redirect URI.** Authentication → Platform configurations. It must list the
callback URL exactly, under a **Web** platform. Not *Single-page application* —
this is a confidential client that exchanges the code server-side using the
secret, and Entra refuses the exchange for an SPA registration.

**Front-channel logout URL.** Same Authentication screen, its own field. Set it
to:

```
https://elementweb-production.up.railway.app/sign-in
```

Signing out redirects to Microsoft's end-session endpoint so the Microsoft
session ends too, not only ours — without that, the next person on a shared
machine presses "Sign in with Microsoft" and lands in the previous user's
account with no prompt.

**An unregistered value here is ignored, not rejected.** Entra will sign the
person out and then show its own "You have signed out of your account" page
instead of returning to the application. Nothing errors, and nothing says why —
so if sign-out works but strands people on a Microsoft page, this field is the
reason. The URL must match what the application sends, which is `/sign-in` on
`APP_BASE_URL`.

**API permissions.** `openid`, `profile`, `email` and `User.Read`, all
**delegated**. None needs administrator consent; a signing-in user consents for
themselves.

**Supported account types.** Single tenant. Anything wider would let an account
from another Microsoft tenant reach the sign-in page.

## 3. Set them in Railway

On the **web** service, alongside the existing variables:

```
ENTRA_TENANT_ID=…
ENTRA_CLIENT_ID=6723d301-9353-4718-ae5e-52b24f3560eb
ENTRA_CLIENT_SECRET=…
ENTRA_REDIRECT_URI=https://elementweb-production.up.railway.app/api/auth/entra/callback
BOOTSTRAP_ADMIN_EMAILS=…
```

`BOOTSTRAP_ADMIN_EMAILS` is not optional for the first deployment. Signing in
proves who you are and grants nothing — roles are assigned on the Users page by
an administrator, and until one exists nobody can create one. This is the only
path that grants a role without an existing administrator, so keep it to one or
two firm addresses and remove it once real administrators exist.

It grants nothing on its own: the address must be authenticated by Entra first.

## 4. First sign-in

1. Open the application. **Continue with Microsoft** should be enabled — while
   the configuration is missing or malformed the button is disabled and the page
   says which value is wrong.
2. Sign in with an address listed in `BOOTSTRAP_ADMIN_EMAILS`. You arrive as an
   administrator.
3. Everyone else signs in once, arriving with **no permissions**. That is
   deliberate.
4. Grant each of them roles on **Users**.

## Sessions

**Two clocks run at once, and the session ends when either of them runs out.**

| | Length | Resets? |
| --- | --- | --- |
| **Idle** | 4 hours | Yes — every time you change something |
| **Absolute** | 12 hours | No — it starts at sign-in and runs to the end |

The idle clock is what people notice. It resets on a *mutation*: saving a field,
leaving a comment, approving a document, granting a role. It does **not** reset
on a page view, so reading for four hours signs you out and editing for eleven
does not.

The refresh does not happen on every action — that would mean a `Set-Cookie` on
every save for no benefit. It waits until the session is **half used**, so an
action two hours in moves expiry to four hours from then, while an action ten
minutes in changes nothing.

A worked day, signing in at 09:00:

| Time | | Idle expiry |
| --- | --- | --- |
| 09:00 | Sign in | 13:00 (absolute: 21:00) |
| 10:00 | Save a field — more than half remains | 13:00, unchanged |
| 11:30 | Approve a document — past halfway | 15:30 |
| 14:00 | Lunch, then reading. Nothing changed | 15:30, unchanged |
| 15:00 | Leave a comment | 19:00 |
| 19:30 | Act again — but the absolute cap binds | 21:00, not 23:30 |
| 21:00 | Signed out mid-anything. Sign in again | both clocks restart |

### Why four hours and twelve

Four is what an abandoned browser on a shared desk is worth. Twelve covers the
longest plausible working day and then ends, because a session that slides
forever is not a session.

The **ratio** matters more than either number. An idle window close to the
absolute cap would mean the cap binds on the very first refresh and the session
never slides again — one extension wearing the name of many. The original design
here was eight against twelve, and a test caught exactly that.

### Why activity means changing rather than viewing

Extending a session means writing a new cookie. Next.js permits that only in a
Server Action, a Route Handler or middleware — never while rendering a page.
Middleware would have been the natural home, but it runs on the Edge runtime,
which cannot open this cookie at all: `seal` is AES-256-GCM from `node:crypto`.

So the extension lives in the server-action wrapper that every mutation already
passes through (`apps/web/src/app/actions.ts`), and it runs *after* the action
succeeds. Failing to extend a session must never fail the thing the person
actually asked for, so `extendSession` returns quietly rather than throwing.

### Revocation does not wait for expiry

Deactivating a user on the Users page ends their session **immediately**,
everywhere. Roles and the active flag are re-read from the database on every
request rather than trusted from the cookie — the cookie carries only a user id,
an issue time and an expiry.

The cap is checked on read as well as on refresh, so a cookie somehow carrying a
later expiry than twelve hours allows is refused rather than honoured.

Signing out clears the session here but **leaves the Microsoft session live**, so
on a shared machine the next person can sign back in without re-entering
credentials. Ending the Entra session too is not yet implemented.

## Roles do not come from Entra

Directory groups and app roles are recorded from the token and **not acted on**.
A setting existed to map them onto application roles; nothing could write it, so
it granted nothing while appearing to. Roles are granted on the Users page.

If the firm later wants directory-driven roles, that mapping needs a UI as well
as a setting — the history is in git.
