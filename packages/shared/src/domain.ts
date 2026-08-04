/**
 * Domain vocabulary shared by every package.
 *
 * These string unions mirror the Prisma enums exactly. They exist so that
 * packages which must not depend on the generated Prisma client (the document
 * engine, the pricing engine) can still speak the same language.
 */

export const ENGAGEMENT_TYPES = ['T1_JOINT', 'T1_SINGLE', 'T2', 'T3'] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

export const DOCUMENT_TYPES = [
  'T1_JOINT_ENGAGEMENT_LETTER',
  'T1_SINGLE_ENGAGEMENT_LETTER',
  'T2_ENGAGEMENT_LETTER',
  'T3_ENGAGEMENT_LETTER',
  'T1_COVER_LETTER',
  'T2_COVER_LETTER',
  'T3_COVER_LETTER',
  'COMPILATION_COVER_LETTER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Document types that ship with an approved master template in this release.
 * Everything else stays unavailable until an administrator uploads and
 * activates an approved template — we never invent legal wording.
 */
export const PRODUCTION_SUPPORTED_DOCUMENT_TYPES: readonly DocumentType[] = [
  'T1_JOINT_ENGAGEMENT_LETTER',
  'T2_ENGAGEMENT_LETTER',
  'T3_ENGAGEMENT_LETTER',
  'T1_COVER_LETTER',
  'COMPILATION_COVER_LETTER',
];

export const AWAITING_APPROVED_TEMPLATE: readonly DocumentType[] = [
  'T1_SINGLE_ENGAGEMENT_LETTER',
  'T2_COVER_LETTER',
  'T3_COVER_LETTER',
];

export function isEngagementLetterType(type: DocumentType): boolean {
  return type.endsWith('_ENGAGEMENT_LETTER');
}

export function isCoverLetterType(type: DocumentType): boolean {
  return type.endsWith('_COVER_LETTER');
}

export const ROLES = ['ADMINISTRATOR', 'PARTNER_OR_FINAL_APPROVER', 'REVIEWER', 'PREPARER', 'READ_ONLY'] as const;
export type Role = (typeof ROLES)[number];

export const FEE_METHODS = ['NO_INCREASE', 'PERCENTAGE', 'FIXED_AMOUNT', 'EXACT_TARGET'] as const;
export type FeeMethod = (typeof FEE_METHODS)[number];

export const FEE_KINDS = ['T1_PREPARATION', 'T2_PREPARATION', 'T3_PREPARATION', 'CSRS_4200_COMPILATION'] as const;
export type FeeKind = (typeof FEE_KINDS)[number];

export const VALUE_SOURCES = [
  'KARBON_CLIENT',
  'KARBON_WORK_ITEM',
  'PRIOR_YEAR_DOCUMENT',
  'TEMPLATE_DEFAULT',
  'MANUAL_ENTRY',
  'CALCULATED',
] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

/**
 * Information source priority, highest first. The extraction and reconciliation
 * services resolve conflicts by *recommending* the highest-priority source —
 * they never silently choose one.
 */
export const SOURCE_PRIORITY: readonly ValueSource[] = [
  'KARBON_CLIENT',
  'KARBON_WORK_ITEM',
  'PRIOR_YEAR_DOCUMENT',
  'TEMPLATE_DEFAULT',
  'MANUAL_ENTRY',
];

export function sourceRank(source: ValueSource): number {
  const index = SOURCE_PRIORITY.indexOf(source);
  return index === -1 ? SOURCE_PRIORITY.length : index;
}

export const EXTRACTION_METHODS = [
  'STRUCTURED_EXPORT',
  'PDF_TEXT',
  'DETERMINISTIC_PATTERN',
  'AI_ASSISTED',
  'OCR_VISION',
  'MANUAL_ENTRY',
] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/** Extraction priority, highest first. AI never precedes deterministic data. */
export const EXTRACTION_PRIORITY: readonly ExtractionMethod[] = [
  'STRUCTURED_EXPORT',
  'PDF_TEXT',
  'DETERMINISTIC_PATTERN',
  'AI_ASSISTED',
  'OCR_VISION',
  'MANUAL_ENTRY',
];

export const REPRESENTATIVE_CAPACITIES = [
  'TRUSTEE',
  'EXECUTOR',
  'ADMINISTRATOR',
  'LIQUIDATOR',
  'OTHER_AUTHORIZED_REPRESENTATIVE',
] as const;
export type RepresentativeCapacity = (typeof REPRESENTATIVE_CAPACITIES)[number];

export interface ProductBranding {
  /** Displayed product name. Configurable so the product can be renamed. */
  readonly name: string;
}

export function productBranding(appName?: string): ProductBranding {
  return { name: appName?.trim() || 'Element Engagements' };
}
