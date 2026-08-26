import type { Prisma, PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { parseManifest, requiredFieldTokens, type TemplateManifest } from '@element/documents';
import {
  ENGAGEMENT_LETTER_BY_TYPE,
  ValidationError,
  money,
  type DocumentType,
  type ValueSource,
} from '@element/shared';
import { resolveFieldValue, type FieldValueBasis } from './field-values.js';

/**
 * The structured field editor.
 *
 * Every approved template records what may be filled in: the label, the data
 * type, the help text, whether the system may propose a value, and when the
 * field becomes mandatory. This service turns that into a form a reviewer can
 * actually work through, and validates what comes back against the same
 * definitions.
 *
 * Two things it deliberately will not do. It never invents a value — an empty
 * field stays empty and the generation gate reports it. And it never offers an
 * input for a value that is owned elsewhere: a deadline belongs to the date
 * rules and a fee to the pricing engine, so those are shown read-only with a
 * pointer to the tab that decides them. Typing into them would look like it
 * worked and then be discarded at generation time.
 */

export interface FieldFormDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
}

/** Where a value is decided. Only `EDITABLE` accepts input on this form. */
export type FieldOwnership = 'EDITABLE' | 'CALCULATED_DATE' | 'CALCULATED_FEE';

export interface FieldEvidenceSummary {
  pageNumber: number | null;
  supportingText: string | null;
}

export interface FormField {
  token: string;
  label: string;
  dataType: string;
  helpText: string | null;
  /** The bracketed text this token replaced in the approved letter. */
  sourcePlaceholder: string | null;
  enumValues: string[];
  maxLength: number | null;
  required: boolean;
  /** False when the system must never propose a value; a person supplies it. */
  autoPopulatable: boolean;
  ownership: FieldOwnership;
  value: string | null;
  valueSource: ValueSource | null;
  /** Why this value is the effective one, so the reviewer is not left guessing. */
  valueBasis: FieldValueBasis | null;
  confidence: number | null;
  confirmed: boolean;
  evidence: FieldEvidenceSummary[];
  /** Set while a conflict on this token is still awaiting a decision. */
  conflictUnresolved: boolean;
}

export interface FormGroup {
  key: string;
  label: string;
  fields: FormField[];
}

export interface FieldForm {
  templateVersionId: string | null;
  documentType: DocumentType;
  groups: FormGroup[];
  /** Required fields with no value yet — what still stands between here and a draft. */
  outstandingRequired: string[];
  totalRequired: number;
}

export interface SaveFieldsInput {
  engagementId: string;
  actorId: string;
  /** Token to raw submitted value. A token absent from the map is left alone. */
  values: Record<string, string>;
}

export interface SaveFieldsResult {
  saved: string[];
  unchanged: string[];
  cleared: string[];
  errors: { token: string; message: string }[];
}


/** Fee tokens are written by the pricing engine, never typed here. */
export const FEE_TOKENS: readonly string[] = [
  'pricing.t1_fee',
  'pricing.t2_fee',
  'pricing.t3_fee',
  'pricing.compilation_fee',
];

const GROUP_LABELS: Record<string, string> = {
  CLIENT: 'Client',
  SIGNERS: 'Signers',
  FIRM: 'Firm',
  DATES: 'Dates and deadlines',
  PRICING: 'Pricing and billing',
  SERVICES: 'Services',
  COVER_LETTER: 'Cover letter',
  OTHER: 'Other',
};

/** Presentation order. Anything unlisted sorts after, alphabetically. */
const GROUP_ORDER = ['CLIENT', 'SIGNERS', 'FIRM', 'SERVICES', 'PRICING', 'DATES', 'COVER_LETTER', 'OTHER'];

export class FieldFormService {
  constructor(private readonly deps: FieldFormDeps) {}

  async formFor(engagementId: string): Promise<FieldForm> {
    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: { id: true, engagementType: true, compilationSelected: true },
    });

    const documentType = ENGAGEMENT_LETTER_BY_TYPE[engagement.engagementType];

    const template = await this.deps.prisma.documentTemplate.findUnique({
      where: { documentType },
      include: {
        versions: {
          where: { status: 'ACTIVE' },
          orderBy: { versionNumber: 'desc' },
          take: 1,
          include: { fieldDefinitions: { orderBy: [{ displayGroup: 'asc' }, { displayOrder: 'asc' }] } },
        },
      },
    });

    const version = template?.versions[0];
    if (!version) {
      return { templateVersionId: null, documentType, groups: [], outstandingRequired: [], totalRequired: 0 };
    }

    const manifest = parseManifest(version.manifest);
    const includedSections = await this.includedSections(engagement.id, manifest, engagement.compilationSelected);
    const required = new Set(requiredFieldTokens(manifest, includedSections));

    const [fields, conflicts, dates] = await Promise.all([
      this.deps.prisma.extractedField.findMany({
        where: { engagementId: engagement.id, coverLetterPackageId: null },
        include: { evidence: { take: 3 } },
      }),
      this.deps.prisma.fieldConflict.findMany({ where: { engagementId: engagement.id } }),
      this.deps.prisma.calculatedDate.findMany({
        where: { engagementId: engagement.id },
        select: { token: true },
      }),
    ]);

    const rowsByToken = new Map<string, typeof fields>();
    for (const field of fields) {
      const bucket = rowsByToken.get(field.token) ?? [];
      bucket.push(field);
      rowsByToken.set(field.token, bucket);
    }

    const conflictByToken = new Map(conflicts.map((conflict) => [conflict.token, conflict]));
    const dateTokens = new Set(dates.map((date) => date.token));

    const groups = new Map<string, FormField[]>();
    const outstandingRequired: string[] = [];

    for (const definition of version.fieldDefinitions) {
      const rows = rowsByToken.get(definition.token) ?? [];
      const conflict = conflictByToken.get(definition.token) ?? null;

      const resolved = resolveFieldValue(
        rows.map((row) => ({
          value:
            (row.valueDecimal ? row.valueDecimal.toString() : null) ??
            (row.valueDate ? row.valueDate.toISOString().slice(0, 10) : null) ??
            row.value,
          source: row.source,
          manualOverrideValue: row.manualOverrideValue,
          manuallyConfirmed: row.manuallyConfirmed,
        })),
        conflict,
      );

      const isRequired = required.has(definition.token);
      const ownership = this.ownershipOf(definition.token, dateTokens);

      if (isRequired && !resolved) outstandingRequired.push(definition.token);

      const evidence = rows
        .flatMap((row) => row.evidence)
        .slice(0, 3)
        .map((item) => ({ pageNumber: item.pageNumber, supportingText: item.supportingText }));

      const field: FormField = {
        token: definition.token,
        label: definition.label,
        dataType: definition.dataType,
        helpText: definition.helpText,
        sourcePlaceholder: definition.sourcePlaceholder,
        enumValues: definition.enumValues,
        maxLength: definition.maxLength,
        required: isRequired,
        autoPopulatable: definition.isAutoPopulatable,
        ownership,
        value: resolved?.value ?? null,
        valueSource: resolved?.source ?? null,
        valueBasis: resolved?.basis ?? null,
        confidence: rows.find((row) => row.source === resolved?.source)?.confidence ?? null,
        confirmed: rows.some((row) => row.manuallyConfirmed),
        evidence,
        conflictUnresolved: conflict?.status === 'UNRESOLVED',
      };

      const key = definition.displayGroup ?? 'OTHER';
      groups.set(key, [...(groups.get(key) ?? []), field]);
    }

    const ordered = [...groups.entries()].sort(([a], [b]) => {
      const rankA = GROUP_ORDER.indexOf(a);
      const rankB = GROUP_ORDER.indexOf(b);
      if (rankA !== rankB) return (rankA === -1 ? GROUP_ORDER.length : rankA) - (rankB === -1 ? GROUP_ORDER.length : rankB);
      return a.localeCompare(b);
    });

    return {
      templateVersionId: version.id,
      documentType,
      groups: ordered.map(([key, fields]) => ({ key, label: GROUP_LABELS[key] ?? key, fields })),
      outstandingRequired,
      totalRequired: required.size,
    };
  }

  /**
   * Saves the values a reviewer submitted.
   *
   * Every value is validated against its own definition, and a field that fails
   * is reported rather than stored — a half-valid form must not leave a
   * plausible-looking wrong value in a legal document.
   */
  async save(input: SaveFieldsInput): Promise<SaveFieldsResult> {
    const form = await this.formFor(input.engagementId);
    const definitions = new Map(form.groups.flatMap((group) => group.fields).map((field) => [field.token, field]));

    const result: SaveFieldsResult = { saved: [], unchanged: [], cleared: [], errors: [] };

    for (const [token, raw] of Object.entries(input.values)) {
      const definition = definitions.get(token);

      if (!definition) {
        result.errors.push({ token, message: 'This field is not part of the approved template.' });
        continue;
      }

      if (definition.ownership !== 'EDITABLE') {
        result.errors.push({
          token,
          message:
            definition.ownership === 'CALCULATED_DATE'
              ? 'This deadline is set on the Dates and Deadlines tab.'
              : 'This fee is set on the Pricing tab.',
        });
        continue;
      }

      const submitted = raw.trim();

      let normalized: NormalizedValue;
      try {
        normalized = normalizeValue(submitted, definition);
      } catch (error) {
        result.errors.push({ token, message: error instanceof Error ? error.message : 'This value is not valid.' });
        continue;
      }

      const existing = await this.deps.prisma.extractedField.findFirst({
        where: {
          engagementId: input.engagementId,
          coverLetterPackageId: null,
          token,
          source: 'MANUAL_ENTRY',
        },
      });

      const before = existing?.value ?? null;
      if ((before ?? '') === (normalized.value ?? '')) {
        result.unchanged.push(token);
        continue;
      }

      if (existing) {
        await this.deps.prisma.extractedField.update({
          where: { id: existing.id },
          data: {
            ...normalized,
            manuallyConfirmed: normalized.value !== null,
            confirmedByUserId: normalized.value !== null ? input.actorId : null,
            confirmedAt: normalized.value !== null ? new Date() : null,
          },
        });
      } else {
        await this.deps.prisma.extractedField.create({
          data: {
            engagementId: input.engagementId,
            token,
            ...normalized,
            source: 'MANUAL_ENTRY',
            extractionMethod: 'MANUAL_ENTRY',
            confidence: 1,
            manuallyConfirmed: normalized.value !== null,
            confirmedByUserId: normalized.value !== null ? input.actorId : null,
            confirmedAt: normalized.value !== null ? new Date() : null,
          },
        });
      }

      await this.deps.audit.record({
        eventType: 'FIELD_EDITED',
        objectType: 'ExtractedField',
        objectId: `${input.engagementId}:${token}`,
        engagementId: input.engagementId,
        userId: input.actorId,
        // Which field changed and whether it now has a value — never the value
        // itself: an audit trail must not become a second copy of client
        // information. The key avoids the word "token", which log redaction
        // treats as a credential and would strip.
        beforeValue: { templateField: token, hadValue: before !== null },
        afterValue: { templateField: token, hasValue: normalized.value !== null },
        reason: normalized.value === null ? 'Reviewer cleared the value.' : 'Reviewer entered the value.',
      });

      if (normalized.value === null) result.cleared.push(token);
      else result.saved.push(token);
    }

    return result;
  }

  /** Which conditional sections apply, so required-ness matches the gate exactly. */
  private async includedSections(
    engagementId: string,
    manifest: TemplateManifest,
    compilationSelected: boolean | null,
  ): Promise<string[]> {
    const selections = await this.deps.prisma.serviceSelection.findMany({ where: { engagementId } });
    const selected = new Map(selections.map((selection) => [selection.serviceCode, selection.isSelected]));

    const included: string[] = [];
    for (const section of manifest.conditionalSections) {
      if (selected.get(section.controlledBy) === true) included.push(section.key);
    }

    // Compilation follows the reviewer's explicit confirmation, exactly as
    // generation does, so the two never disagree about what is required.
    if (manifest.conditionalSections.some((section) => section.key === 'csrs_4200')) {
      const index = included.indexOf('csrs_4200');
      if (compilationSelected === true && index === -1) included.push('csrs_4200');
      if (compilationSelected !== true && index !== -1) included.splice(index, 1);
    }

    return included;
  }

  private ownershipOf(token: string, dateTokens: ReadonlySet<string>): FieldOwnership {
    if (FEE_TOKENS.includes(token)) return 'CALCULATED_FEE';
    if (dateTokens.has(token)) return 'CALCULATED_DATE';
    return 'EDITABLE';
  }
}

interface NormalizedValue {
  value: string | null;
  valueDate: Date | null;
  valueDecimal: Prisma.Decimal | string | null;
  valueBoolean: boolean | null;
}

const EMPTY: NormalizedValue = { value: null, valueDate: null, valueDecimal: null, valueBoolean: null };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates and types a submitted value.
 *
 * Typed columns are populated as well as the text, so a date stays a date and
 * money stays exact through every later comparison.
 */
export function normalizeValue(
  raw: string,
  definition: Pick<FormField, 'label' | 'dataType' | 'enumValues' | 'maxLength'>,
): NormalizedValue {
  const value = raw.trim();
  if (value === '') return { ...EMPTY };

  if (definition.maxLength && value.length > definition.maxLength) {
    throw new ValidationError(`${definition.label} must be ${definition.maxLength} characters or fewer.`);
  }

  switch (definition.dataType) {
    case 'EMAIL': {
      if (!EMAIL.test(value)) throw new ValidationError(`${definition.label} must be an email address.`);
      return { ...EMPTY, value };
    }

    case 'PHONE': {
      const digits = value.replace(/\D/g, '');
      if (digits.length < 10) throw new ValidationError(`${definition.label} must be a complete telephone number.`);
      return { ...EMPTY, value };
    }

    case 'DATE': {
      if (!ISO_DATE.test(value)) throw new ValidationError(`${definition.label} must be a date in YYYY-MM-DD form.`);
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) throw new ValidationError(`${definition.label} is not a real date.`);
      // Round-tripping catches 2026-02-31, which Date would silently shift.
      if (parsed.toISOString().slice(0, 10) !== value) {
        throw new ValidationError(`${definition.label} is not a real date.`);
      }
      return { ...EMPTY, value, valueDate: parsed };
    }

    case 'YEAR': {
      if (!/^\d{4}$/.test(value)) throw new ValidationError(`${definition.label} must be a four-digit year.`);
      return { ...EMPTY, value };
    }

    case 'MONEY': {
      let amount;
      try {
        amount = money(value);
      } catch {
        throw new ValidationError(`${definition.label} must be an amount.`);
      }
      if (amount.isNegative()) throw new ValidationError(`${definition.label} cannot be negative.`);
      return { ...EMPTY, value: amount.toFixed(2), valueDecimal: amount.toFixed(2) };
    }

    case 'BOOLEAN': {
      const truthy = ['yes', 'true', 'on', '1'];
      const falsy = ['no', 'false', 'off', '0'];
      const lowered = value.toLowerCase();
      if (truthy.includes(lowered)) return { ...EMPTY, value: 'Yes', valueBoolean: true };
      if (falsy.includes(lowered)) return { ...EMPTY, value: 'No', valueBoolean: false };
      throw new ValidationError(`${definition.label} must be yes or no.`);
    }

    case 'ENUM': {
      const match = definition.enumValues.find((option) => option.toLowerCase() === value.toLowerCase());
      if (!match) {
        throw new ValidationError(
          `${definition.label} must be one of: ${definition.enumValues.join(', ')}.`,
        );
      }
      return { ...EMPTY, value: match };
    }

    case 'MULTILINE':
      return { ...EMPTY, value: value.replace(/\r\n/g, '\n') };

    default:
      return { ...EMPTY, value };
  }
}
