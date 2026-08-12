---
name: vendor-api-verification
description: >
  Verify a third-party API integration against the vendor's published
  specification instead of inferring it from behaviour, and report what is
  actually proven rather than what compiles. Use this whenever you are writing
  or changing code that calls an external API (Karbon, Adobe Sign, Microsoft
  Graph, Stripe, any vendor), debugging an integration that returns empty
  results or zero rows, writing or reviewing a mock or test double for a vendor,
  deciding whether an integration can be described as working, or investigating
  why a feature that depends on an external service quietly finds nothing. Use
  it even when nothing has thrown an error and the code looks correct —
  especially then, because the failures this prevents are the ones that raise no
  error at all.
---

# Verifying a vendor API integration

## The one idea

**Not throwing is not the same as working.**

Every serious integration bug in this project raised no error. The code
compiled, the tests passed, the health check was green, and the feature
silently found nothing — for months, in production, against a real client
tenant. An integration that fails loudly is a nuisance. One that succeeds
emptily is a liability, because every signal you have says it is fine.

So the question is never "did it error?" It is: **what did I actually observe,
and does that observation distinguish success from failure?**

## Before you write a line of client code

Find the vendor's machine-readable specification and read it. Most vendors
publish an OpenAPI/Swagger document; many keep it in a public repository.

```bash
# Clone or fetch it, then enumerate what actually exists
python3 -c "
import json; spec=json.load(open('api.json'))
for p in sorted(spec['paths']):
    print(','.join(m.upper() for m in spec['paths'][p] if m in ('get','post','put','patch','delete')), p)
"
```

This takes minutes and it is the difference between a correct integration and a
plausible one. In this project, four endpoints were implemented from reasonable
inference and **none of them existed**:

| What was written | What the vendor publishes |
| --- | --- |
| `GET /WorkItems/{key}/Documents` | `GET /FileList/{EntityType}?EntityKey=` |
| `GET /Documents/{id}/Content` | `GET /Files?token=` (token issued with a listing) |
| `POST /WorkItems/{key}/Tasks` | **nothing — no task-creation operation exists** |
| `POST /Notes` with `RelatedEntityKey` | requires `AuthorEmailAddress`, links via `Timelines` |

Each was a sensible guess. REST conventions made them look right. They were all
wrong, and the API's answer to three of them was an ordinary `404`.

When no specification exists, say so explicitly in the code and treat every
capability as unverified until observed. An undocumented API is a reason for
more caution, not less.

## The four ways an integration lies

### 1. A 404 becomes "found nothing"

Mapping a `404` on a GET to `null` or `[]` is a reasonable convention: a record
that is not there is legitimately "nothing". But it makes a **missing path**
indistinguishable from an **empty collection**.

That single conflation caused the worst bug here. Every work item and every
client record in the firm's tenant reported zero documents. Prior-year document
discovery — a core feature — would have found nothing for ever, while every
signal said it was healthy.

Guard it two ways:

- Map `404` to "nothing" **only for a read of a specific record**. A `404` on a
  write, or on a collection you expect to exist, is a fault — let it throw.
- When a listing comes back empty, be able to answer *which* it was. A small
  diagnostic that reports `200 with 0 items` versus `404` separately turns an
  afternoon of guessing into one command.

### 2. Fields the vendor omits unless you ask

Many APIs return a thin object by default and require explicit opt-in for
related data — `$expand`, `include=`, `fields=`, `?embed=`.

A bare `GET /Organizations/{key}` here returned the name and some keys. No
contacts, no address, no telephone. The client import brought the firm's whole
book across with **zero contacts on every record** — and an engagement letter
with no contact has nobody to address it to.

Nothing errored. The fields were simply absent from a response nobody had asked
to include them in.

Before mapping a response, check the specification for what the endpoint
returns **by default** versus **on request**, and confirm the field names
against the schema rather than against what seems natural. This code read
`AddressLines` and `BusinessNumber`; the vendor publishes neither.

### 3. A field the vendor does not have

Sometimes the data you need is not there at all. The temptation is to reach for
the nearest thing and map it.

There is no business-number field on a Karbon organisation. The nearest
candidate is a free-text identifier the firm controls — usually a client code.
Mapping that straight through would have put a wrong CRA business number on a
signed tax engagement letter.

**A wrong value is worse than a missing one**, because missing is visibly
missing and wrong sails through review. Where a candidate might be right,
validate its shape and return nothing when it fails, or surface it as a
conflict for a person to confirm.

### 4. A mock more capable than the vendor

A test double that succeeds where the real API cannot is worse than no mock,
because it hides the difference exactly where it is cheapest to find.

Two here:

- The mock returned `SUCCEEDED` with a fabricated task id for an operation the
  vendor **has no endpoint for**. Every run in test mode showed a task created;
  production never could.
- The mock returned `SUCCEEDED` with a fabricated document id for an upload
  that never happened, so a signed letter was recorded as safely filed while it
  existed in one place only — and, being "successful", was never retried.

A mock's job is to stand in for the vendor, not to be a better version of it.
When you learn the real API refuses something, **change the mock to refuse it
too**.

## Proving a capability

An integration claim needs evidence, and the evidence has to be capable of
distinguishing success from failure.

Prefer a runnable harness over a manual checklist. A checklist that says
"exercise each operation against a test account" is a morning of careful work
nobody repeats; one command that prints a line per capability gets run.

Three properties matter more than coverage:

**Say what was observed, not that nothing threw.** A read that returns `null`
is not a pass. In this project a capability was reported `ok  not found` — for
a key the search had just returned — and that reading is what promoted it to
"supported". Let each check declare what would count as proof:

```ts
// `proves` decides whether the result is evidence, separately from whether it threw.
await attempt('READ_CLIENT', () => client.getClient(key),
  (found) => found ? `${found.legalName}` : 'no record matched',
  (found) => found !== null);
```

**Print the vendor's own words.** `HTTP 400 for /Notes` says a request was
rejected and nothing about why. The response body names the field it objected
to. Capture it and show it — an integration harness that hides the vendor's
explanation is the thing standing between you and the answer.

**Say which build answered.** A run once reported three failures that were
already fixed and pushed; the container had not been redeployed and nothing in
the output distinguished "the vendor rejects this" from "this code is a week
old". Print a commit identifier first.

### Writing to someone's real account

Many vendors offer no sandbox, so the only way to verify a write is against
production data. Refusing outright means the write path — often the most
consequential one — is never verified at all.

Make the risk explicit rather than avoiding it:

- Never write to a record the caller did not name. Falling back to "whichever
  record the search returned first" means writing into a real customer's file.
  If the named record does not resolve, **stop** — do not fall through.
- Require a separate, explicit acknowledgement for production writes, so it is
  something an operator says rather than something that happens.
- Use the vendor's no-overwrite option, and name test artefacts obviously so
  they can be found and deleted afterwards.

Watch placeholders in anything a person will paste. `<KEY>` is shell
redirection and fails with a syntax error; `THAT_KEY` looks enough like a real
identifier to be pasted verbatim — both happened here. Show the shape of a real
value and say plainly that the word is to be replaced.

## Reporting support honestly

Track each capability at one of three levels, and let only observation promote
it:

| Level | Means |
| --- | --- |
| **Supported** | Implemented against a documented operation **and** observed working against a live account |
| **Unverified** | Implemented per the documentation, not yet run against a live account |
| **Unsupported** | No such operation exists. The documented fallback is used and the limitation stays visible |

A corrected path is not an observed one — code that now matches the spec is
still `Unverified` until a run returns something real.

**"Unsupported" is a finding, not a defect.** When the vendor genuinely has no
operation, record that, stop calling the nonexistent endpoint, and use the
fallback. This project spent effort diagnosing "task availability varies by
tenant and plan" — an inference from a `404`, stated as fact, that sent everyone
looking at plans and permissions. There is no task endpoint on any tenant. Once
that was established, the fix was to stop asking.

## Signals worth acting on

- **Implausible uniformity.** Forty-seven records all returning zero is not a
  quiet tenant, it is a broken query. Ask whether the result is plausible for a
  working business, not merely whether it parsed.
- **A capability that has only ever been observed empty.** Demote it. An empty
  list is not evidence the operation works.
- **A vendor value used to build a request.** Take the parameter you need, never
  the host — a response that supplies a full URL can otherwise redirect an
  authenticated client anywhere. The same applies to pagination links.
- **Short-lived tokens stored.** A download token valid for fifteen minutes
  passes every test and fails in production the first time someone opens a
  document an hour later. Fetch it fresh.
- **A label that gates behaviour.** If a "sandbox or production" flag is what
  safety keys off, and marking production honestly breaks the app, people will
  mark it wrong. Key the guarantee off something structural — the host — and
  let the label be descriptive.

## When you find one of these

Fix the code, then close the loop so the same class cannot recur silently:

1. **Write the test that would have caught it**, and check it fails against the
   old behaviour. A test asserting `/FileList/WorkItem` is requested is worth
   more than one asserting a document comes back, because it pins the thing that
   was actually wrong.
2. **Correct the record, including your own earlier explanation.** If a previous
   note said "varies by tenant", say plainly that it was inferred and wrong.
   A misdiagnosis left standing sends the next person down the same path.
3. **Say what is now proven and what is merely corrected.** They are different,
   and only one of them is evidence.
