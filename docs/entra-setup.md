# Microsoft Entra ID sign-in

Production authentication. The development login refuses to run outside
development and test, so this is the only way into a deployed instance.

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

A session lasts **four hours without activity** and is extended by acting —
saving a field, leaving a comment, approving a document — up to an absolute
**twelve hours** from sign-in, after which it ends whatever you are doing.

Page views do not extend it. A Server Component cannot set a cookie, and the
middleware that normally would runs on a runtime that cannot open this one, so
activity means a mutation rather than a navigation.

Deactivating a user on the Users page ends their session **immediately**,
everywhere. Roles and the active flag are re-read from the database on every
request rather than trusted from the cookie, so revoking access does not wait
for a sign-out.

Signing out clears the session here but **leaves the Microsoft session live**, so
on a shared machine the next person can sign back in without re-entering
credentials. Ending the Entra session too is not yet implemented.

## Roles do not come from Entra

Directory groups and app roles are recorded from the token and **not acted on**.
A setting existed to map them onto application roles; nothing could write it, so
it granted nothing while appearing to. Roles are granted on the Users page.

If the firm later wants directory-driven roles, that mapping needs a UI as well
as a setting — the history is in git.
