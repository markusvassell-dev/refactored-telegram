# Template system

## The rule everything else serves

**The current approved master template controls all standard legal wording.**
The prior-year letter is not the legal master. It is read only to recover
client-specific facts — names, addresses, numbers, dates, selected services,
fees, payment terms, signers.

AI never rewrites, summarises, improves or modernises approved wording.
Neither does any deterministic code path: the renderer substitutes values,
toggles checkboxes, and deletes whole blocks the manifest marks conditional or
internal. It never edits a sentence.

## Source templates

`templates/source/` holds the five approved `.docx` files exactly as supplied,
read-only, with their SHA-256 hashes recorded in the manifest and on the
`TemplateVersion` row.

| File | SHA-256 |
| --- | --- |
| T1 Joint Taxpayer Engagement Letter.docx | `d4c93ea2c582526d5465d2cadac4d0fe7c7873d0057a0f5810c9cf8566e37010` |
| T1 Cover Letter.docx | `a982fb6a0e7b970c17e50d5f0b12e6d301ba50cfbb692ea9af86a3cf61be87c6` |
| T2 Engagement Letter.docx | `01917c9e61eab58dfb8cb67c0376e42203fe99424da10187cddae8c1b8433870` |
| T3 Trust Engagement Letter.docx | `cfef8b783476fbc31089a8d6132ef4025f3214187af37be98ee257724851f639` |
| Compilation Engagement Cover Letter.docx | `c42fc450956acd2a13a68892789cb23bacdc99c01fd990b340b529febbcdb26c` |

`pnpm templates:verify` re-checks them.

## Normalisation

The approved templates carry visible bracketed placeholders such as
`[LEGAL NAME OF CORPORATION]`. `pnpm templates:normalize` rewrites those — and
only those — into stable internal tokens:

```
[LEGAL NAME OF CORPORATION]  →  [[corporation.legal_name]]
```

It writes `templates/normalized/<name>.docx` and
`templates/manifests/<DOCUMENT_TYPE>.json`. The source is opened read-only.

Nothing else changes. Legal text, branding, formatting, tables, headers,
footers, the logo, page breaks and paragraph structure are preserved because
the document is never re-serialised — only individual text runs are spliced.

Current result: **127 placeholder occurrences across the five templates, zero
unmapped, zero errors.**

### Why `[[ ]]`

Adobe Acrobat Sign's text tags use `{{ }}`. A different delimiter means the two
syntaxes can never collide.

### Ambiguous placeholders

`[DATE]` appears four times in the T2 template with four different meanings.
Mappings can therefore be scoped:

```ts
{ placeholder: '[DATE]', token: 'dates.sent',
  scope: { kind: 'PARAGRAPH', startsWith: 'Date:' } }

{ placeholder: '[AMOUNT]', token: 'pricing.t2_fee',
  scope: { kind: 'TABLE_CELL', tableContains: 'Additional work',
           rowIndex: 0, cellIndex: 1 } }
```

Unscoped mappings apply to every occurrence. A mapping that matches nothing is
an error, not a silent no-op — the template has changed and someone must look.

### Run-spanning placeholders

Word routinely splits text across runs, so `[LEGAL NAME OF CORPORATION]` may be
stored as three fragments. The engine concatenates a paragraph's text, matches
against that, and writes the replacement into the run where the match begins so
it inherits that run's formatting. Continuation runs simply drop their share of
the matched characters.

Straight and curly quotes, hyphen and dashes, and space and non-breaking space
are matched interchangeably.

## Manifests

A manifest is the contract between an approved template and the application. It
contains **no legal wording**.

- **fields** — token, label, data type, required, auto-populatable,
  `requiredWhenSection`, display group and order
- **conditionalSections** — key, controlling service code, and the block ranges
  to remove when not selected
- **checkboxes** — service code, anchor text, default, and whether the template
  ships it permanently ticked
- **signatureAnchors** — role, token, Adobe text tag, draft placeholder,
  signing order
- **internalOnlySections** — always removed from client-facing output
- **editableSections** — `ORDINARY` (cover-letter narrative) or `EXCEPTIONAL`
  (needs a reason and partner approval)
- **sanitation** — highlight removal, forbidden text, placeholder patterns,
  required text, required media parts, expected page range

Everything not listed as an editable section is locked approved wording.

## Conditional sections

Ranges are identified by the text at their start and end, not by index, so
ordinary editing of the template does not break them:

```ts
{ startsWith: '3A. Optional compilation engagement under CSRS 4200',
  endsBefore: '4. Corporation’s responsibilities' }
```

When CSRS 4200 is not selected, section 3A **and** the Schedule A compilation
particulars are removed entirely — not marked "not applicable", not left in
place. The compilation fee cell reads `Not applicable` rather than `$0.00`.

Whether it is selected is confirmed by a reviewer each year. The prior year's
answer is a suggestion and nothing more.

## Sanitation and validation

Before a document can be approved, all of these must pass:

- no unresolved placeholder — neither `[BRACKETED]` nor `[[token]]`
- no highlighting (the T2 template ships 29 yellow runs; all are stripped)
- no internal-only content, checked by exact phrase
- required branding and headings still present, and the logo part intact
- no blank required field, no invalid email, no invalid year
- no unconfirmed date or fee
- no duplicate signature field
- the Word file opens, the PDF converted, page count within the expected range
- the correct client name and year appear in the output

Errors block approval. Warnings are shown to the reviewer.

## Signature anchors

Anchors render as an underscore rule in a draft and as an Adobe text tag when
sent for signature. Anchor values always win over supplied values, so a stale
prior-year signature or signed date can never be written into a new document —
there is a test asserting exactly that.

## Versioning

A published `TemplateVersion` is immutable. The application enforces it and so
does a database trigger: only lifecycle columns may change once a version is
`ACTIVE` or `RETIRED`. Updating a template creates a new version.

Administrator workflow: upload → classify → map fields → validate tokens →
generate a sample → preview Word and PDF → approve → activate → retire the old
version, with rollback by re-activating a prior version.

Editing one client's document never touches the master template. An exceptional
wording change is stored against that document version with its original
wording, revised wording, reason, author and approver, and appears in the
comparison report.

## Adding a template

1. Put the approved `.docx` in `templates/source/`.
2. Add a `TemplateSpec` in
   `packages/documents/src/template-engine/source-mappings.ts`.
3. Run `pnpm templates:normalize` and fix any reported error.
4. Run `pnpm db:seed`, or activate the version on the Templates screen.
5. Add the document type to `PRODUCTION_SUPPORTED_DOCUMENT_TYPES`.

Until step 5, the type stays visible as *awaiting an approved template* and
generation is refused.
