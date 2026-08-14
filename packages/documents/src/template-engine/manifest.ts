import { z } from 'zod';

/**
 * Template manifests.
 *
 * A manifest is the contract between an approved Word template and the
 * application. It describes what may be filled in, what may be conditionally
 * removed, what must never reach a client, and where signatures go.
 *
 * It never contains legal wording. The .docx remains the only source of the
 * approved text.
 */

export const fieldDataTypeSchema = z.enum([
  'STRING',
  'MULTILINE',
  'EMAIL',
  'PHONE',
  'DATE',
  'YEAR',
  'MONEY',
  'BOOLEAN',
  'ENUM',
]);
export type FieldDataType = z.infer<typeof fieldDataTypeSchema>;

export const fieldDefinitionSchema = z.object({
  /** Stable internal token used in the normalised .docx, e.g. `corporation.legal_name`. */
  token: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, 'Tokens are lowercase dotted identifiers'),
  label: z.string().min(1),
  dataType: fieldDataTypeSchema,
  required: z.boolean().default(false),
  /** The visible bracketed text this token replaced in the source template. */
  sourcePlaceholder: z.string().optional(),
  /** Whether the system may propose a value automatically. */
  autoPopulatable: z.boolean().default(true),
  enumValues: z.array(z.string()).optional(),
  maxLength: z.number().int().positive().optional(),
  helpText: z.string().optional(),
  displayGroup: z
    .enum(['CLIENT', 'DATES', 'SERVICES', 'PRICING', 'SIGNERS', 'COVER_LETTER', 'FIRM', 'OTHER'])
    .default('OTHER'),
  displayOrder: z.number().int().default(0),
  /** Only meaningful when the named conditional section is included. */
  requiredWhenSection: z.string().optional(),
});
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;

/**
 * A contiguous run of top-level body blocks, identified by the text at its
 * start and end. Anchors are matched against paragraph text, never against
 * formatting, so ordinary editing of the template does not break them.
 */
export const blockRangeSchema = z.object({
  /** Paragraph text that starts the range (prefix match, whitespace-normalised). */
  startsWith: z.string().min(3),
  /**
   * Paragraph text that starts the block *after* the range. Omit to run to the
   * end of the body.
   */
  endsBefore: z.string().min(3).optional(),
  /** Include the block identified by `endsBefore`. Defaults to false. */
  inclusiveEnd: z.boolean().default(false),
});
export type BlockRange = z.infer<typeof blockRangeSchema>;

export const conditionalSectionSchema = z.object({
  /** Stable key, e.g. `csrs_4200`. */
  key: z.string().min(1),
  label: z.string().min(1),
  /** The service code whose selection controls this section. */
  controlledBy: z.string().min(1),
  ranges: z.array(blockRangeSchema).min(1),
  /**
   * When the controlling selection is false the ranges are removed entirely.
   * Irrelevant wording must never survive into a client-facing document.
   */
  removeWhenFalse: z.boolean().default(true),
  /** Fields that become mandatory when the section is included. */
  requiredFields: z.array(z.string()).default([]),
});
export type ConditionalSection = z.infer<typeof conditionalSectionSchema>;

export const checkboxRuleSchema = z.object({
  /** Service code or field token controlling this checkbox. */
  code: z.string().min(1),
  label: z.string().min(1),
  /** Distinctive text of the paragraph carrying the checkbox glyph. */
  anchorText: z.string().min(3),
  defaultChecked: z.boolean().default(false),
  /** True when the template ships this box pre-ticked and it cannot be cleared. */
  alwaysChecked: z.boolean().default(false),
});
export type CheckboxRule = z.infer<typeof checkboxRuleSchema>;

/**
 * Reads a manifest written before signature anchors carried `adobeFieldType`.
 *
 * A published `TemplateVersion` is immutable — the database enforces it, and the
 * seed skips any version that already exists — so manifests stored under the old
 * encoding cannot be rewritten in place, and every one of them would otherwise
 * throw on read the moment this schema changed. That would take out every
 * engagement already using a seeded template, not just new ones.
 *
 * The old encoding held a finished tag with the participant index baked in
 * (`{{Sig_es_:signer1:signature}}`). Only the *kind* of field survives the
 * upgrade; the index is deliberately discarded, because computing it from the
 * real participants is the fix — an old version gets the correct index too.
 *
 * Removable once no stored manifest predates this change.
 */
function upgradeLegacySignatureAnchor(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || 'adobeFieldType' in raw) return raw;

  const legacyTag = (raw as { adobeTag?: unknown }).adobeTag;
  if (typeof legacyTag !== 'string') return raw;

  return { ...raw, adobeFieldType: legacyTag.includes(':date') ? 'DATE' : 'SIGNATURE' };
}

export const signatureAnchorSchema = z.preprocess(upgradeLegacySignatureAnchor, z.object({
  /** Participant role that signs here. */
  role: z.enum([
    'TAXPAYER_1',
    'TAXPAYER_2',
    'AUTHORIZED_SIGNING_OFFICER',
    'AUTHORIZED_REPRESENTATIVE',
    'FIRM_SIGNER',
  ]),
  /** Token inserted into the normalised template at the signature position. */
  token: z.string().min(1),
  /**
   * What Adobe should collect here.
   *
   * Deliberately not a literal tag. This field used to hold the finished string
   * — `{{Sig_es_:signer1:signature}}` — with the participant index baked in, and
   * an index written by hand at authoring time is a claim about signing order
   * that nothing kept true. Moving the firm to order 1 silently reassigned every
   * field to the wrong person: the client's signature block would have collected
   * the firm's signature. The index is now computed from the engagement's actual
   * participants at render time by `buildAdobeTag`, so it cannot disagree with
   * the order Adobe is actually given.
   *
   * `AUTO_PLACED` emits no tag at all and leaves the draft placeholder standing,
   * which tells Adobe to position its own field. T2 uses it — see the note on
   * that spec.
   */
  adobeFieldType: z.enum(['SIGNATURE', 'DATE', 'AUTO_PLACED']),
  /** What is rendered instead for an unsigned draft or preview. */
  draftPlaceholder: z.string().default('________________________________'),
  required: z.boolean().default(true),
}));
export type SignatureAnchor = z.infer<typeof signatureAnchorSchema>;

export const internalOnlySectionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  range: blockRangeSchema,
  /** Internal content is always removed from client-facing output. */
  alwaysRemove: z.literal(true).default(true),
});
export type InternalOnlySection = z.infer<typeof internalOnlySectionSchema>;

export const sanitationRulesSchema = z.object({
  /** Remove every text highlight (the T2 template ships yellow placeholders). */
  removeAllHighlights: z.boolean().default(true),
  /** Text fragments that must never appear in client-facing output. */
  forbiddenText: z.array(z.string()).default([]),
  /** Patterns that indicate an unresolved placeholder. */
  placeholderPatterns: z.array(z.string()).default(['\\[[A-Z][^\\]]{2,}\\]', '\\[\\[[a-z0-9_.]+\\]\\]']),
  /** Minimum and maximum plausible page counts for a rendered document. */
  expectedPageRange: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  /** Text that must still be present (branding, headings). */
  requiredText: z.array(z.string()).default([]),
  /** Media parts that must survive rendering (the firm logo). */
  requiredMediaParts: z.array(z.string()).default([]),
});
export type SanitationRules = z.infer<typeof sanitationRulesSchema>;

export const editableSectionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  range: blockRangeSchema,
  /**
   * ORDINARY: any reviewer may edit (cover-letter narrative).
   * EXCEPTIONAL: authorised users only, with reason and partner approval.
   */
  editLevel: z.enum(['ORDINARY', 'EXCEPTIONAL']),
});
export type EditableSection = z.infer<typeof editableSectionSchema>;

export const templateManifestSchema = z.object({
  manifestVersion: z.literal(1),
  documentType: z.enum([
    'T1_JOINT_ENGAGEMENT_LETTER',
    'T1_SINGLE_ENGAGEMENT_LETTER',
    'T2_ENGAGEMENT_LETTER',
    'T3_ENGAGEMENT_LETTER',
    'T1_COVER_LETTER',
    'T2_COVER_LETTER',
    'T3_COVER_LETTER',
    'COMPILATION_COVER_LETTER',
  ]),
  templateVersion: z.number().int().positive(),
  sourceFileName: z.string().min(1),
  sourceFileHash: z.string().length(64),
  normalizedFileHash: z.string().length(64).optional(),
  fields: z.array(fieldDefinitionSchema),
  conditionalSections: z.array(conditionalSectionSchema).default([]),
  checkboxes: z.array(checkboxRuleSchema).default([]),
  signatureAnchors: z.array(signatureAnchorSchema).default([]),
  internalOnlySections: z.array(internalOnlySectionSchema).default([]),
  editableSections: z.array(editableSectionSchema).default([]),
  sanitation: sanitationRulesSchema,
  /**
   * Everything not listed as an editable section is locked approved wording.
   * Recorded explicitly so the review UI can show what is protected.
   */
  lockedWordingByDefault: z.literal(true).default(true),
  notes: z.string().optional(),
});

export type TemplateManifest = z.infer<typeof templateManifestSchema>;

export function parseManifest(value: unknown): TemplateManifest {
  return templateManifestSchema.parse(value);
}

export function requiredFieldTokens(
  manifest: TemplateManifest,
  includedSections: readonly string[],
): string[] {
  const tokens = new Set<string>();

  for (const field of manifest.fields) {
    // `requiredWhenSection` makes a field required exactly when that section is
    // included, whatever the unconditional `required` flag says. That is what
    // makes the CSRS 4200 fields mandatory only when compilation is selected.
    if (field.requiredWhenSection) {
      if (includedSections.includes(field.requiredWhenSection)) tokens.add(field.token);
      continue;
    }
    if (field.required) tokens.add(field.token);
  }

  for (const section of manifest.conditionalSections) {
    if (!includedSections.includes(section.key)) continue;
    for (const token of section.requiredFields) tokens.add(token);
  }

  return [...tokens].sort();
}

/**
 * The Adobe Sign text tag for one anchor, at a computed participant index.
 *
 * Adobe addresses fields by participant *set* — `signer1` is whoever occupies
 * the first signing order, not a fixed person — so the index is a property of
 * the engagement, never of the template. Callers pass the index resolved from
 * the engagement's actual participants; see `resolveSignerIndices`.
 *
 * Returns `null` for `AUTO_PLACED`, meaning: write no tag, leave the draft
 * placeholder, and let Adobe position its own field.
 */
export function buildAdobeTag(fieldType: SignatureAnchor['adobeFieldType'], signerIndex: number): string | null {
  if (fieldType === 'AUTO_PLACED') return null;

  if (!Number.isInteger(signerIndex) || signerIndex < 1) {
    // A zero or fractional index would produce a tag Adobe silently ignores,
    // and a silently ignored signature field is an unsigned agreement.
    throw new Error(`A signer index must be a positive integer, got ${signerIndex}.`);
  }

  return fieldType === 'SIGNATURE'
    ? `{{Sig_es_:signer${signerIndex}:signature}}`
    : `{{Dte_es_:signer${signerIndex}:date}}`;
}

/**
 * Maps each signing role to the Adobe participant-set index it occupies.
 *
 * Mirrors how `AdobeSignRestClient.createAgreement` builds participant sets: it
 * groups participants by distinct `signingOrder`, ascending, and Adobe numbers
 * those sets from 1. Deriving the index the same way here is what keeps the tags
 * in the document and the sets in the request describing the same people.
 *
 * Roles absent from `participants` are absent from the result — the caller
 * decides whether that is fatal, because it depends on whether the anchor is
 * required.
 */
export function resolveSignerIndices(
  participants: readonly { role: string; signingOrder: number }[],
): Map<string, number> {
  const orders = [...new Set(participants.map((participant) => participant.signingOrder))].sort((a, b) => a - b);
  const indexByOrder = new Map(orders.map((order, position) => [order, position + 1]));

  const result = new Map<string, number>();
  for (const participant of participants) {
    const index = indexByOrder.get(participant.signingOrder);
    if (index !== undefined) result.set(participant.role, index);
  }
  return result;
}
