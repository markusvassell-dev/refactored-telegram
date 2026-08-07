# Notifications

The application used to change state in silence. A client signed, the
engagement advanced, the signed PDF and its certificate were filed into Karbon,
the audit trail recorded all of it — and no human was told. The first anybody
knew was the next time they happened to open the page.

## What raises one

| Event | Who is told |
| --- | --- |
| The client signed | Preparer, reviewer, final approver |
| The client declined | Preparer, reviewer, final approver |
| The signature request expired | Preparer, reviewer, final approver |

A decline or an expiry matters more than a signature: that is work which has
**stopped**, and previously nothing said so.

Failing to notify never fails the signing. A notice is a courtesy on top of the
record; losing one must not roll back something that happened.

## In the application

A count in the header on every page, and a list at `/notifications`.

Reading is personal. Three people are told about one signature and each clears
it in their own time — it is not a shared inbox where the first to look
silences it for the rest. Marking one read is scoped to its recipient in the
service, because a notification id is not a capability.

## By e-mail, through Microsoft 365

Off by default. When it is on, notices are also e-mailed through the firm's own
Microsoft 365 tenant — no new vendor, no second copy of who works here, and no
third-party contract.

```
NOTIFICATION_EMAIL_ENABLED=true
NOTIFICATION_EMAIL_SENDER=engagements@yourfirm.ca
```

It sends through the **same Entra ID app registration** used for sign-in, so
`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` and `ENTRA_CLIENT_SECRET` must be set. The
environment schema refuses the combination without them, and refuses a sender
that is not set — there is no safe default mailbox to send a firm's notices
from.

### The permission, and the trap in it

Sign-in uses **delegated** scopes: the application acts as the person signing
in. Mail cannot, because notices are raised by a background worker where nobody
is signed in. It therefore needs the **`Mail.Send` application permission**,
granted with admin consent, and used through the client-credentials flow.

**That permission lets the application send as any mailbox in the tenant.**
That is far more than sending firm notices needs.

Restrict it. This client only ever sends from `NOTIFICATION_EMAIL_SENDER`, so
an Exchange application access policy costs nothing and removes the over-grant:

This is tenant configuration, not application configuration. It runs in
**Exchange Online PowerShell**, by somebody holding the Exchange Administrator
role, and it is done once.

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # first time only
Connect-ExchangeOnline -UserPrincipalName admin@yourfirm.ca

# One mail-enabled security group holding only the sending mailbox. The policy
# cannot name a mailbox directly; it can only name a group.
New-DistributionGroup -Name "ElementEngagementsSenders" -Type Security `
  -Members engagements@yourfirm.ca

New-ApplicationAccessPolicy -AppId <ENTRA_CLIENT_ID> `
  -PolicyScopeGroupId ElementEngagementsSenders@yourfirm.ca `
  -AccessRight RestrictAccess `
  -Description "Element Engagements may send only as the engagements mailbox."
```

The backtick is PowerShell's line continuation — each command is one statement.

### Legacy, and what replaces it

`New-ApplicationAccessPolicy` still works and is the shortest path today, but
Microsoft has marked application access policies **legacy** and directs new
configuration to **RBAC for Applications** — a scoped `Application Mail.Send`
role assignment against a resource scope, rather than a group-based policy.

Either restricts the grant, which is the point. Prefer RBAC for a new
deployment, and follow Microsoft's current page for the exact parameters rather
than the sketch above: the cmdlets there have changed more than once.

Without the policy, a compromised client secret can send mail as the managing
partner. With it, the worst case is mail from a mailbox created for the
purpose.

### Delivery

A background job drains what is waiting, once a minute. It is separate from
raising the notice in three ways:

- **In time.** Raising a notice is part of recording that a client signed;
  sending mail is not. Signing must never fail because a mail server was
  briefly unreachable.
- **In state.** `emailedAt` is not `readAt`. A notice may be emailed and
  unread, read and never emailed, or neither.
- **In consequence.** A notice that cannot be e-mailed is still a notice — it
  is in the application, where the recipient will see it. Failing to deliver
  degrades the service; it does not lose the information.

A failure is retried, bounded, and the vendor's own words are recorded against
the notification. A wrong address or a revoked permission is not transient, and
retrying for ever turns one misconfiguration into unbounded traffic against the
tenant.

Somebody who has been deactivated is not written to. Their notices stay in the
application; the firm should not keep mailing an address it has stopped
trusting for sign-in.

### What is in the message

The fact, and a link. Nothing else. A notice travels to an inbox this
application does not control, so the engagement is where the confidential part
stays. Test Mode marks every subject `[TEST MODE]`.

### Staff only

Nothing in this application e-mails a client. A client hears from Acrobat Sign,
which is where the signing record belongs. That boundary is why staff mail is
permitted while Test Mode is on and contacting a client is not: a misconfigured
sender can embarrass the firm, but it cannot reach a client.
