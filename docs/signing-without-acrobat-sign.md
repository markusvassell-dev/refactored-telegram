# Signing while the firm has no Acrobat Sign licence

## The problem this solves

Acrobat Pro with e-sign features — which the firm has — exposes no API. Acrobat
Sign Solutions — which does — is a separate paid product, quoted per customer
rather than publicly priced. `docs/adobe-sign-setup.md` covers how to tell the
two apart in ten seconds.

Without a bridge, that licensing gap is not a missing feature. It is a wall
across the middle of the application:

```
READY_TO_SEND: ['SENDING_FOR_SIGNATURE', 'CHANGES_REQUESTED', 'NEEDS_ATTENTION']
```

The only route from an approved letter to a signed one ran through the Adobe
API. Every engagement would stop at `READY_TO_SEND` — no signature tracking, no
completion, no compilation cover letter, no delivery — while the firm went on
signing those same letters in Acrobat and had nowhere to say so. The
application would be a drafting tool that stops at the moment it starts to
matter.

## What the bridge is

A person who could have authorised the send may instead record a signature they
obtained by other means, attaching the signed document as evidence. The
engagement then advances to `SIGNED` and the rest of the workflow runs as
normal.

**It does not skip review.** An engagement only reaches `READY_TO_SEND` after
final approval by someone who did not prepare it. Nothing about that changes.
What changes is who collected the signature, and what evidence exists.

## Why it is a separate table

`ExternalSignature` is not a flag on `AdobeAgreement`. The two records are not
the same kind of evidence:

| | Adobe Sign | Recorded here |
| --- | --- | --- |
| Audit trail | Adobe's, independent of this firm | This application's |
| Signing certificate | Issued | None |
| Per-signer status | Observed by Adobe | Asserted by the recorder |
| Identity verification | Adobe's | Whatever the firm did |
| Tamper evidence | Adobe's seal | A SHA-256 of the file as uploaded |

A boolean shared between two tables is the kind of distinction that gets
dropped in a join, defaulted on an insert, or quietly ignored by a later query.
Two tables cannot be confused for one another. Anywhere a signature is shown,
the provenance is shown with it.

## What is required

Enforced in three places, on purpose. The service checks it, the workflow gate
checks it, and the database refuses it — because this is the one step where a
false record would be worth making. It is the difference between a client
having agreed to a fee and somebody saying they did.

| Requirement | Why |
| --- | --- |
| Permission `signing:record_external` | Held only by `PARTNER_OR_FINAL_APPROVER`. Not by administrators — running the system is not the same as binding a client to a fee |
| Engagement in `READY_TO_SEND` | Anything earlier is still a draft |
| An approved PDF, and an explicit internal approval | Same preconditions as an Adobe send |
| The signed document, as a PDF | Checked by its bytes, not its file name. An assertion with nothing behind it is not evidence |
| Every named signer confirmed individually | A joint T1 needs both spouses. Without a box each, a half-signed letter reads as complete for ever after |
| A reason, at least ten characters | Goes in the permanent record |
| No open Adobe agreement | Two records of one signature that disagree is worse than either alone |
| A signature date not in the future | More than 90 days ago warns rather than blocks — a letter genuinely can be signed in March and recorded in August |

## What cannot be changed afterwards

A database trigger rejects any update to a recorded signature except filling in
the Karbon document id, which happens after the fact. Correcting a mistake
means recording the correction, not rewriting the original — the same rule the
audit trail follows.

The approved document version is never touched. Its PDF remains exactly what
was approved; the signed copy lives on the signature record. Overwriting it
would destroy the only thing that proves what the firm actually approved.

## Using it

1. Open the engagement, **Adobe Sign** tab.
2. The panel **Record a signature obtained elsewhere** sits under the send
   controls. If it is greyed out it says why — usually the engagement has not
   been authorised for sending yet.
3. Choose how it was signed, give the date the *client* signed (not today,
   unless they are the same), attach the signed PDF, tick each person who
   signed, and say why it did not go through the application.
4. The engagement moves to `SIGNED`. The preparer, reviewer and final approver
   are notified — with a different notice from the Adobe one, because the Adobe
   notice promises a certificate and automatic filing into Karbon, and neither
   of those happens here.

## When the licence is bought

Nothing needs to be removed. The bridge stays useful for the cases that will
always exist — a client who insists on paper, a letter signed in a meeting. The
`ACROBAT_ESIGN` method becomes rare rather than routine, and the difference
between the two kinds of record is visible in the file for every prior year.

## Verifying the Adobe path without buying anything

Adobe offers a free **Acrobat Sign Developer Edition** giving full REST API
access for development and testing. It cannot send to real clients, but it
turns every Adobe capability in this codebase from *unverified* into *tested
against Adobe's real API* — which is what the project's own rule requires
before an integration may be described as working.

That is a separate errand from this bridge, and it costs nothing.
