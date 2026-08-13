import type { DocumentType } from '@element/shared';
import type { PlaceholderMapping } from './normalize.js';
import type { CheckboxRule, ConditionalSection, FieldDefinition, InternalOnlySection, SanitationRules, SignatureAnchor, EditableSection } from './manifest.js';

/**
 * The normalisation contract for each approved source template.
 *
 * Every entry was derived by inspecting the actual .docx. Nothing here invents
 * legal wording — it only says which visible placeholder becomes which token,
 * which blocks are conditional, and which content must never reach a client.
 */

export interface TemplateSpec {
  documentType: DocumentType;
  sourceFileName: string;
  mappings: PlaceholderMapping[];
  fields: FieldDefinition[];
  conditionalSections: ConditionalSection[];
  checkboxes: CheckboxRule[];
  signatureAnchors: SignatureAnchor[];
  internalOnlySections: InternalOnlySection[];
  editableSections: EditableSection[];
  sanitation: SanitationRules;
  notes?: string;
}

const BASE_SANITATION: SanitationRules = {
  removeAllHighlights: true,
  forbiddenText: [],
  placeholderPatterns: ['\\[[A-Z][^\\]]{2,}\\]', '\\[\\[[a-z0-9_.]+\\]\\]'],
  requiredText: [],
  requiredMediaParts: ['word/media/image1.png'],
};

function field(
  token: string,
  label: string,
  dataType: FieldDefinition['dataType'],
  extra: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    token,
    label,
    dataType,
    required: false,
    autoPopulatable: true,
    displayGroup: 'OTHER',
    displayOrder: 0,
    ...extra,
  };
}

// ===========================================================================
// T2 CORPORATE INCOME TAX ENGAGEMENT LETTER
// ===========================================================================

const T2_SCHEDULE_A_TABLE = 'Estimated balance-due day';
const T2_ACCEPTANCE_TABLE = 'Preferred email';
const T2_COMPILATION_TABLE = 'Management acknowledgement';
const T2_FEE_TABLE = 'Additional work';

export const T2_ENGAGEMENT_LETTER_SPEC: TemplateSpec = {
  documentType: 'T2_ENGAGEMENT_LETTER',
  sourceFileName: 'T2 Engagement Letter.docx',
  mappings: [
    { placeholder: '[LEGAL NAME OF CORPORATION]', token: 'corporation.legal_name' },
    { placeholder: '[BN / RC ACCOUNT NUMBER]', token: 'corporation.business_number' },
    { placeholder: '[MONTH DAY, YEAR]', token: 'corporation.year_end' },
    { placeholder: '[TAXATION YEAR-END]', token: 'corporation.year_end' },
    { placeholder: '[YEAR-END DATE]', token: 'corporation.year_end' },
    { placeholder: '[AUTHORIZED SIGNING OFFICER]', token: 'signer.officer_name' },
    { placeholder: '[REPORT DATE]', token: 'compilation.report_date' },
    { placeholder: '[CLIENT INFORMATION DUE DATE]', token: 'dates.client_information_due' },
    { placeholder: '[PAYMENT TERMS, E.G., UPON RECEIPT / 15 DAYS]', token: 'pricing.payment_terms' },
    { placeholder: '[ENGAGEMENT PARTNER / AUTHORIZED REPRESENTATIVE]', token: 'firm.signer_name' },
    { placeholder: '[NAME AND CONTACT INFORMATION]', token: 'firm.engagement_lead' },
    { placeholder: '[EMAIL ADDRESS]', token: 'signer.officer_email' },
    { placeholder: '[OTHER INCLUDED SERVICE]', token: 'services.other_included' },

    // "Date:" in the letterhead is the date sent.
    { placeholder: '[DATE]', token: 'dates.sent', scope: { kind: 'PARAGRAPH', startsWith: 'Date:' } },

    // Acceptance block — a signature date is never prefilled.
    {
      placeholder: '[NAME]',
      token: 'signer.officer_name',
      scope: { kind: 'TABLE_CELL', tableContains: T2_ACCEPTANCE_TABLE, rowIndex: 2, cellIndex: 1 },
    },
    {
      placeholder: '[TITLE]',
      token: 'signer.officer_title',
      scope: { kind: 'TABLE_CELL', tableContains: T2_ACCEPTANCE_TABLE, rowIndex: 3, cellIndex: 1 },
    },
    {
      placeholder: '[DATE]',
      token: 'signature.officer_date',
      scope: { kind: 'TABLE_CELL', tableContains: T2_ACCEPTANCE_TABLE, rowIndex: 4, cellIndex: 1 },
      isSignatureAnchor: true,
    },

    // Schedule A — engagement particulars.
    {
      placeholder: '[DATE]',
      token: 'dates.client_information_due',
      scope: { kind: 'TABLE_CELL', tableContains: T2_SCHEDULE_A_TABLE, rowIndex: 3, cellIndex: 1 },
    },
    { placeholder: '[DATE OR “SUBJECT TO COMPLETE INFORMATION”]', token: 'dates.target_completion' },
    {
      placeholder: '[DATE]',
      token: 'dates.filing_due',
      scope: { kind: 'TABLE_CELL', tableContains: T2_SCHEDULE_A_TABLE, rowIndex: 5, cellIndex: 1 },
    },
    { placeholder: '[DATE – CONFIRM ELIGIBILITY FOR 2- OR 3-MONTH RULE]', token: 'dates.balance_due' },

    // Compilation particulars.
    { placeholder: '[E.G., CORPORATE TAX FILING, INTERNAL MANAGEMENT, SPECIFIED LENDER]', token: 'compilation.intended_use' },
    { placeholder: '[MANAGEMENT AND IDENTIFIED THIRD PARTIES]', token: 'compilation.intended_users' },
    { placeholder: '[E.G., CASH BASIS WITH SELECTED ACCRUALS AND ACCOUNTING ESTIMATES]', token: 'compilation.basis_of_accounting' },
    {
      placeholder: '[OTHER]',
      token: 'compilation.financial_information_other',
      scope: { kind: 'TABLE_CELL', tableContains: T2_COMPILATION_TABLE, rowIndex: 3, cellIndex: 1 },
    },
    { placeholder: '[ELECTRONIC / PRINTED / CLIENT PORTAL]', token: 'compilation.report_delivery' },

    // Optional services list.
    { placeholder: '[OTHER]', token: 'services.other_optional', scope: { kind: 'PARAGRAPH', startsWith: '☐ [OTHER]' } },

    // Fee arrangement.
    {
      placeholder: '[AMOUNT]',
      token: 'pricing.t2_fee',
      scope: { kind: 'TABLE_CELL', tableContains: T2_FEE_TABLE, rowIndex: 0, cellIndex: 1 },
    },
    {
      placeholder: '[AMOUNT / NOT APPLICABLE]',
      token: 'pricing.compilation_fee',
      scope: { kind: 'TABLE_CELL', tableContains: T2_FEE_TABLE, rowIndex: 1, cellIndex: 1 },
    },
    { placeholder: '[FIXED FEE / HOURLY / VALUE-BASED]', token: 'pricing.billing_basis' },
    {
      placeholder: '[AMOUNT / NOT APPLICABLE]',
      token: 'pricing.retainer',
      scope: { kind: 'TABLE_CELL', tableContains: T2_FEE_TABLE, rowIndex: 3, cellIndex: 1 },
    },
    {
      placeholder: '[TERMS]',
      token: 'pricing.payment_terms_short',
      scope: { kind: 'TABLE_CELL', tableContains: T2_FEE_TABLE, rowIndex: 4, cellIndex: 1 },
    },
    { placeholder: '[HOURLY RATES OR SEPARATE QUOTE]', token: 'pricing.additional_work' },

    // Special terms.
    { placeholder: '[LIST ANY SPECIFIC EXCLUSIONS, ASSUMPTIONS, LIABILITY CAP, OR SPECIAL DELIVERABLES]', token: 'special_terms.line_1' },
    { placeholder: '[IF NONE, STATE “NONE”]', token: 'special_terms.line_2' },
  ],
  fields: [
    field('corporation.legal_name', 'Corporation legal name', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 1 }),
    field('corporation.business_number', 'Business Number / RC account number', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 2 }),
    field('corporation.year_end', 'Taxation year-end', 'DATE', { required: true, displayGroup: 'CLIENT', displayOrder: 3 }),
    field('signer.officer_name', 'Authorized signing officer', 'STRING', { required: true, displayGroup: 'SIGNERS', displayOrder: 1 }),
    field('signer.officer_title', 'Signing officer title', 'STRING', { required: true, displayGroup: 'SIGNERS', displayOrder: 2 }),
    field('signer.officer_email', 'Signing officer email address', 'EMAIL', { required: true, displayGroup: 'SIGNERS', displayOrder: 3 }),
    field('firm.signer_name', 'Engagement partner / authorized representative', 'STRING', { required: true, displayGroup: 'FIRM', displayOrder: 1 }),
    field('firm.engagement_lead', 'Engagement lead and contact information', 'STRING', { required: true, displayGroup: 'FIRM', displayOrder: 2 }),
    field('dates.sent', 'Date sent', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 1 }),
    field('dates.client_information_due', 'Client information due date', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 2 }),
    field('dates.target_completion', 'Target completion date', 'STRING', { required: true, displayGroup: 'DATES', displayOrder: 3 }),
    field('dates.filing_due', 'Filing due date', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 4 }),
    field('dates.balance_due', 'Estimated balance-due day', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 5 }),
    field('pricing.t2_fee', 'T2 preparation fee', 'MONEY', { required: true, displayGroup: 'PRICING', displayOrder: 1 }),
    field('pricing.compilation_fee', 'CSRS 4200 compilation fee', 'MONEY', { displayGroup: 'PRICING', displayOrder: 2, requiredWhenSection: 'csrs_4200' }),
    field('pricing.billing_basis', 'Billing basis', 'STRING', { required: true, displayGroup: 'PRICING', displayOrder: 3 }),
    field('pricing.retainer', 'Retainer', 'STRING', { displayGroup: 'PRICING', displayOrder: 4 }),
    field('pricing.payment_terms', 'Payment terms (letter body)', 'STRING', { required: true, displayGroup: 'PRICING', displayOrder: 5 }),
    field('pricing.payment_terms_short', 'Payment terms (Schedule A)', 'STRING', { required: true, displayGroup: 'PRICING', displayOrder: 6 }),
    field('pricing.additional_work', 'Additional-work rates or separate quote', 'STRING', { displayGroup: 'PRICING', displayOrder: 7 }),
    field('compilation.intended_use', 'Intended use', 'STRING', { displayGroup: 'SERVICES', displayOrder: 10, requiredWhenSection: 'csrs_4200' }),
    field('compilation.intended_users', 'Intended users', 'STRING', { displayGroup: 'SERVICES', displayOrder: 11, requiredWhenSection: 'csrs_4200' }),
    field('compilation.basis_of_accounting', 'Basis of accounting', 'STRING', { displayGroup: 'SERVICES', displayOrder: 12, requiredWhenSection: 'csrs_4200' }),
    field('compilation.financial_information_other', 'Other financial information included', 'STRING', { displayGroup: 'SERVICES', displayOrder: 13 }),
    field('compilation.report_delivery', 'Report delivery method', 'STRING', { displayGroup: 'SERVICES', displayOrder: 14, requiredWhenSection: 'csrs_4200' }),
    field('compilation.report_date', 'Expected compilation report date', 'DATE', { displayGroup: 'DATES', displayOrder: 6, requiredWhenSection: 'csrs_4200' }),
    field('services.other_included', 'Other included service', 'STRING', { displayGroup: 'SERVICES', displayOrder: 5 }),
    field('services.other_optional', 'Other optional service', 'STRING', { displayGroup: 'SERVICES', displayOrder: 20 }),
    field('special_terms.line_1', 'Special terms or assumptions', 'STRING', { required: true, displayGroup: 'OTHER', displayOrder: 1 }),
    field('special_terms.line_2', 'Special terms — second line', 'STRING', { displayGroup: 'OTHER', displayOrder: 2 }),
    field('signature.officer_date', 'Signature date (never prefilled)', 'STRING', { autoPopulatable: false, displayGroup: 'SIGNERS', displayOrder: 10 }),
  ],
  conditionalSections: [
    {
      key: 'csrs_4200',
      label: 'Section 3A — optional CSRS 4200 compilation engagement',
      controlledBy: 't2.csrs4200',
      removeWhenFalse: true,
      requiredFields: [
        'compilation.intended_use',
        'compilation.intended_users',
        'compilation.basis_of_accounting',
        'compilation.report_delivery',
        'pricing.compilation_fee',
      ],
      ranges: [
        // Section 3A itself, up to but not including section 4.
        { startsWith: '3A. Optional compilation engagement under CSRS 4200', endsBefore: '4. Corporation’s responsibilities', inclusiveEnd: false },
        // Schedule A compilation particulars heading and its table.
        { startsWith: 'Compilation engagement particulars', endsBefore: 'Optional or additional services expressly included', inclusiveEnd: false },
      ],
    },
  ],
  checkboxes: [
    { code: 't2.federal_return', label: 'Federal T2 return and ordinary schedules', anchorText: 'Federal T2 return and ordinary schedules', defaultChecked: true, alwaysChecked: false },
    { code: 't2.provincial_schedules', label: 'Applicable provincial or territorial corporate tax schedules', anchorText: 'Applicable provincial or territorial corporate tax schedules', defaultChecked: true, alwaysChecked: false },
    { code: 't2.gifi', label: 'GIFI preparation', anchorText: 'GIFI preparation from supplied or separately prepared financial information', defaultChecked: true, alwaysChecked: false },
    { code: 't2.efile', label: 'Electronic filing and confirmation', anchorText: 'Electronic filing and confirmation', defaultChecked: true, alwaysChecked: false },
    { code: 't2.csrs4200', label: 'Compilation engagement under CSRS 4200', anchorText: 'Compilation engagement under CSRS 4200', defaultChecked: false, alwaysChecked: false },
    { code: 't2.other_included', label: 'Other included service', anchorText: '[[services.other_included]]', defaultChecked: false, alwaysChecked: false },
    { code: 't2.tax_planning_meeting', label: 'Tax planning meeting', anchorText: 'Tax planning meeting', defaultChecked: false, alwaysChecked: false },
    { code: 't2.noa_review', label: 'Review of CRA Notice of Assessment', anchorText: 'Review of CRA Notice of Assessment', defaultChecked: false, alwaysChecked: false },
    { code: 't2.t1134', label: 'T1134 foreign affiliate reporting', anchorText: 'T1134 foreign affiliate reporting', defaultChecked: false, alwaysChecked: false },
    { code: 't2.t106', label: 'T106 non-arm’s-length transactions with non-residents', anchorText: 'T106 non-arm', defaultChecked: false, alwaysChecked: false },
    { code: 't2.t1135', label: 'T1135 foreign income verification reporting', anchorText: 'T1135 foreign income verification reporting', defaultChecked: false, alwaysChecked: false },
    { code: 't2.capital_dividend_election', label: 'Capital dividend election / other election', anchorText: 'Capital dividend election', defaultChecked: false, alwaysChecked: false },
    { code: 't2.provincial_outside_t2', label: 'Provincial filing outside the T2 system', anchorText: 'Provincial filing outside the T2 system', defaultChecked: false, alwaysChecked: false },
    { code: 't2.other_optional', label: 'Other optional service', anchorText: '[[services.other_optional]]', defaultChecked: false, alwaysChecked: false },
  ],
  signatureAnchors: [
    {
      role: 'AUTHORIZED_SIGNING_OFFICER',
      token: 'signature.officer_date',
      // T2 is sent with no Adobe tags at all, so Adobe places both the signature
      // block and its date itself.
      //
      // The T2 template has no signature line to anchor to — only this date —
      // and the firm chose not to edit the approved wording to add one. That
      // leaves a choice: send a document carrying a date tag but no signature
      // tag, or send one carrying nothing. Adobe's documented behaviour for an
      // untagged document is to auto-place a signature field per participant;
      // its behaviour when *some* fields are tagged is that tagging takes over
      // placement, which would give the officer a date field and no way to sign.
      // An agreement nobody can sign is worse than a blank date line, so until a
      // live send proves otherwise this stays AUTO_PLACED.
      adobeFieldType: 'AUTO_PLACED',
      draftPlaceholder: '',
      required: true,
    },
  ],
  internalOnlySections: [
    {
      key: 't2_internal_checklist',
      label: 'Internal customization checklist',
      alwaysRemove: true,
      range: { startsWith: 'Internal customization checklist', inclusiveEnd: false },
    },
  ],
  editableSections: [
    {
      key: 'special_terms',
      label: 'Special terms or assumptions',
      editLevel: 'EXCEPTIONAL',
      range: { startsWith: 'Special terms or assumptions', endsBefore: 'Internal customization checklist', inclusiveEnd: false },
    },
  ],
  sanitation: {
    ...BASE_SANITATION,
    forbiddenText: [
      'Internal customization checklist',
      'Delete this internal checklist before issuing the letter',
      'remove before sending',
      'Replace every yellow-highlighted placeholder',
      'Have firm counsel or the professional liability insurer review',
    ],
    requiredText: ['CORPORATE INCOME TAX (T2) ENGAGEMENT LETTER', 'ACCEPTANCE BY THE CORPORATION', 'SCHEDULE A'],
    expectedPageRange: [4, 14],
  },
  notes:
    'Section 3A and the Schedule A compilation particulars are removed entirely when CSRS 4200 is not selected. The internal customization checklist is always removed. Yellow highlighting is always stripped.',
};

// ===========================================================================
// T1 JOINT TAXPAYER ENGAGEMENT LETTER
// ===========================================================================

const T1_JOINT_HEADER_TABLE = 'Prepared by';
const T1_JOINT_SIGNATURE_TABLE = 'Electronic signature';

export const T1_JOINT_ENGAGEMENT_LETTER_SPEC: TemplateSpec = {
  documentType: 'T1_JOINT_ENGAGEMENT_LETTER',
  sourceFileName: 'T1 Joint Taxpayer Engagement Letter.docx',
  mappings: [
    { placeholder: '[YEAR]', token: 'engagement.tax_year' },
    { placeholder: '[TAXPAYER 1 FULL LEGAL NAME]', token: 'taxpayer1.full_legal_name' },
    { placeholder: '[TAXPAYER 2 FULL LEGAL NAME]', token: 'taxpayer2.full_legal_name' },
    { placeholder: '[TAXPAYER 1 FIRST NAME]', token: 'taxpayer1.first_name' },
    { placeholder: '[TAXPAYER 2 FIRST NAME]', token: 'taxpayer2.first_name' },
    { placeholder: '[CLIENT ADDRESS]', token: 'client.address' },
    { placeholder: '[DATE SENT]', token: 'dates.sent' },
    { placeholder: '[DESCRIBE]', token: 'services.other_description' },
    { placeholder: '[CLIENT INFORMATION DEADLINE]', token: 'dates.client_information_due' },
    { placeholder: '[AMOUNT]', token: 'pricing.t1_fee' },
    {
      placeholder: '[DATE]',
      token: 'pricing.proposal_date',
      scope: { kind: 'PARAGRAPH', startsWith: '☐ As set out in a separate proposal' },
    },
    { placeholder: '[UPON RECEIPT / WITHIN __ DAYS]', token: 'pricing.payment_terms' },
  ],
  fields: [
    field('taxpayer1.full_legal_name', 'Taxpayer 1 full legal name', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 1 }),
    field('taxpayer1.first_name', 'Taxpayer 1 first name', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 2 }),
    field('taxpayer1.email', 'Taxpayer 1 email address', 'EMAIL', { required: true, displayGroup: 'SIGNERS', displayOrder: 1 }),
    field('taxpayer1.telephone', 'Taxpayer 1 telephone number', 'PHONE', { displayGroup: 'SIGNERS', displayOrder: 2 }),
    field('taxpayer2.full_legal_name', 'Taxpayer 2 full legal name', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 3 }),
    field('taxpayer2.first_name', 'Taxpayer 2 first name', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 4 }),
    field('taxpayer2.email', 'Taxpayer 2 email address', 'EMAIL', { required: true, displayGroup: 'SIGNERS', displayOrder: 3 }),
    field('taxpayer2.telephone', 'Taxpayer 2 telephone number', 'PHONE', { displayGroup: 'SIGNERS', displayOrder: 4 }),
    field('client.address', 'Address', 'MULTILINE', { required: true, displayGroup: 'CLIENT', displayOrder: 5 }),
    field('engagement.tax_year', 'Taxation year', 'YEAR', { required: true, displayGroup: 'DATES', displayOrder: 1 }),
    field('dates.sent', 'Date sent', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 2 }),
    field('dates.client_information_due', 'Client information deadline', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 3 }),
    field('services.other_description', 'Other selected service', 'STRING', { displayGroup: 'SERVICES', displayOrder: 10 }),
    field('pricing.t1_fee', 'Fee amount', 'MONEY', { required: true, displayGroup: 'PRICING', displayOrder: 1 }),
    field('pricing.payment_terms', 'Payment terms', 'STRING', { required: true, displayGroup: 'PRICING', displayOrder: 2 }),
    field('pricing.proposal_date', 'Separate proposal or pricing schedule date', 'DATE', { displayGroup: 'PRICING', displayOrder: 3 }),
  ],
  conditionalSections: [],
  checkboxes: [
    { code: 't1.federal_return', label: 'Federal T1 return', anchorText: 'Federal T1 Income Tax and Benefit Return', defaultChecked: true, alwaysChecked: true },
    { code: 't1.provincial_return', label: 'Provincial or territorial return', anchorText: 'Applicable provincial or territorial personal income tax return', defaultChecked: true, alwaysChecked: true },
    { code: 't1.schedules', label: 'Related schedules, elections and forms', anchorText: 'Related schedules, elections and forms ordinarily required', defaultChecked: true, alwaysChecked: true },
    { code: 't1.t2125', label: 'T2125 Statement of Business or Professional Activities', anchorText: 'T2125 Statement of Business or Professional Activities', defaultChecked: false, alwaysChecked: false },
    { code: 't1.t776', label: 'T776 Statement of Real Estate Rentals', anchorText: 'T776 Statement of Real Estate Rentals', defaultChecked: false, alwaysChecked: false },
    { code: 't1.t1135', label: 'T1135 Foreign Income Verification Statement', anchorText: 'T1135 Foreign Income Verification Statement', defaultChecked: false, alwaysChecked: false },
    { code: 't1.other', label: 'Other selected service', anchorText: 'Other: [[services.other_description]]', defaultChecked: false, alwaysChecked: false },
    { code: 't1.fee_fixed', label: 'Fixed fee', anchorText: 'Fixed fee of $', defaultChecked: true, alwaysChecked: false },
    { code: 't1.fee_time', label: 'Time and complexity at standard rates', anchorText: 'Based on time and complexity at our standard rates', defaultChecked: false, alwaysChecked: false },
    { code: 't1.fee_proposal', label: 'Separate proposal or pricing schedule', anchorText: 'As set out in a separate proposal or pricing schedule', defaultChecked: false, alwaysChecked: false },
  ],
  signatureAnchors: [
    { role: 'TAXPAYER_1', token: 'signature.taxpayer1', adobeFieldType: 'SIGNATURE', draftPlaceholder: '________________________________', required: true },
    { role: 'TAXPAYER_2', token: 'signature.taxpayer2', adobeFieldType: 'SIGNATURE', draftPlaceholder: '________________________________', required: true },
    { role: 'FIRM_SIGNER', token: 'signature.firm', adobeFieldType: 'SIGNATURE', draftPlaceholder: '________________________________', required: false },
  ],
  internalOnlySections: [],
  editableSections: [],
  sanitation: {
    ...BASE_SANITATION,
    requiredText: [
      'T1 PERSONAL INCOME TAX ENGAGEMENT LETTER',
      'ELECTRONIC ACCEPTANCE AND SIGNATURES',
      'Both taxpayers must sign separately',
    ],
    expectedPageRange: [3, 12],
  },
  notes: `Both taxpayers receive their own signature field and sign in parallel by default. The header table anchor is "${T1_JOINT_HEADER_TABLE}" and the signature table anchor is "${T1_JOINT_SIGNATURE_TABLE}".`,
};

// ===========================================================================
// T3 TRUST ENGAGEMENT LETTER
// ===========================================================================

export const T3_ENGAGEMENT_LETTER_SPEC: TemplateSpec = {
  documentType: 'T3_ENGAGEMENT_LETTER',
  sourceFileName: 'T3 Trust Engagement Letter.docx',
  mappings: [
    { placeholder: '[FULL LEGAL NAME OF TRUST OR ESTATE]', token: 'trust.legal_name' },
    { placeholder: '[MAILING ADDRESS]', token: 'trust.address' },
    { placeholder: '[T3 ACCOUNT NUMBER / PENDING]', token: 'trust.account_number' },
    { placeholder: '[TRUST TAX YEAR-END]', token: 'trust.year_end' },
    { placeholder: '[NAME AND CAPACITY]', token: 'representative.name_and_capacity' },
    { placeholder: '[AUTHORIZED REPRESENTATIVE FIRST NAME]', token: 'representative.first_name' },
    { placeholder: '[AUTHORIZED REPRESENTATIVE NAME]', token: 'representative.full_name' },
    { placeholder: '[TRUSTEE / EXECUTOR / ADMINISTRATOR / OTHER]', token: 'representative.capacity' },
    { placeholder: '[DATE SENT]', token: 'dates.sent' },
    { placeholder: '[DESCRIBE]', token: 'services.other_description' },
    { placeholder: '[CLIENT INFORMATION DEADLINE]', token: 'dates.client_information_due' },
    { placeholder: '[AMOUNT]', token: 'pricing.t3_fee' },
    {
      placeholder: '[DATE]',
      token: 'pricing.proposal_date',
      scope: { kind: 'PARAGRAPH', startsWith: '☐ As set out in a separate proposal' },
    },
    { placeholder: '[UPON RECEIPT / WITHIN __ DAYS]', token: 'pricing.payment_terms' },
  ],
  fields: [
    field('trust.legal_name', 'Full legal name of trust or estate', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 1 }),
    field('trust.address', 'Mailing address', 'MULTILINE', { required: true, displayGroup: 'CLIENT', displayOrder: 2 }),
    field('trust.account_number', 'T3 account number (or "Pending")', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 3 }),
    field('trust.year_end', 'Trust tax year-end', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 1 }),
    field('representative.full_name', 'Authorized representative', 'STRING', { required: true, displayGroup: 'SIGNERS', displayOrder: 1 }),
    field('representative.first_name', 'Authorized representative first name', 'STRING', { required: true, displayGroup: 'SIGNERS', displayOrder: 2 }),
    field('representative.capacity', 'Representative capacity', 'ENUM', {
      required: true,
      autoPopulatable: false,
      displayGroup: 'SIGNERS',
      displayOrder: 3,
      enumValues: ['Trustee', 'Executor', 'Administrator', 'Liquidator', 'Other authorized representative'],
      helpText: 'The capacity is never assumed. A reviewer must confirm it.',
    }),
    field('representative.name_and_capacity', 'Representative name and capacity', 'STRING', { required: true, displayGroup: 'SIGNERS', displayOrder: 4 }),
    field('representative.email', 'Authorized representative email address', 'EMAIL', { required: true, displayGroup: 'SIGNERS', displayOrder: 5 }),
    field('dates.sent', 'Date sent', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 2 }),
    field('dates.client_information_due', 'Client information deadline', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 3 }),
    field('services.other_description', 'Other selected service', 'STRING', { displayGroup: 'SERVICES', displayOrder: 10 }),
    field('pricing.t3_fee', 'Fee amount', 'MONEY', { required: true, displayGroup: 'PRICING', displayOrder: 1 }),
    field('pricing.payment_terms', 'Payment terms', 'STRING', { required: true, displayGroup: 'PRICING', displayOrder: 2 }),
    field('pricing.proposal_date', 'Separate proposal or pricing schedule date', 'DATE', { displayGroup: 'PRICING', displayOrder: 3 }),
  ],
  conditionalSections: [],
  checkboxes: [
    { code: 't3.return', label: 'T3 Trust Income Tax and Information Return', anchorText: 'T3 Trust Income Tax and Information Return', defaultChecked: true, alwaysChecked: true },
    { code: 't3.schedules', label: 'Applicable federal, provincial or territorial schedules', anchorText: 'Applicable federal, provincial or territorial schedules', defaultChecked: true, alwaysChecked: true },
    { code: 't3.schedule15', label: 'Schedule 15 beneficial ownership information', anchorText: 'Schedule 15, Beneficial Ownership Information of a Trust', defaultChecked: true, alwaysChecked: true },
    { code: 't3.slips', label: 'T3 slips and T3 Summary', anchorText: 'T3 slips and T3 Summary', defaultChecked: false, alwaysChecked: false },
    { code: 't3.nr4', label: 'NR4 slips and NR4 Summary', anchorText: 'NR4 slips and NR4 Summary', defaultChecked: false, alwaysChecked: false },
    { code: 't3.t1135', label: 'T1135 Foreign Income Verification Statement', anchorText: 'T1135 Foreign Income Verification Statement', defaultChecked: false, alwaysChecked: false },
    { code: 't3.other', label: 'Other selected service', anchorText: 'Other: [[services.other_description]]', defaultChecked: false, alwaysChecked: false },
    { code: 't3.fee_fixed', label: 'Fixed fee', anchorText: 'Fixed fee of $', defaultChecked: true, alwaysChecked: false },
    { code: 't3.fee_time', label: 'Time and complexity at standard rates', anchorText: 'Based on time and complexity at our standard rates', defaultChecked: false, alwaysChecked: false },
    { code: 't3.fee_proposal', label: 'Separate proposal or pricing schedule', anchorText: 'As set out in a separate proposal or pricing schedule', defaultChecked: false, alwaysChecked: false },
  ],
  signatureAnchors: [
    { role: 'AUTHORIZED_REPRESENTATIVE', token: 'signature.representative', adobeFieldType: 'SIGNATURE', draftPlaceholder: '________________________________', required: true },
    { role: 'FIRM_SIGNER', token: 'signature.firm', adobeFieldType: 'SIGNATURE', draftPlaceholder: '________________________________', required: false },
  ],
  internalOnlySections: [],
  editableSections: [],
  sanitation: {
    ...BASE_SANITATION,
    requiredText: ['T3 TRUST INCOME TAX ENGAGEMENT LETTER', 'ELECTRONIC ACCEPTANCE AND SIGNATURE'],
    expectedPageRange: [3, 12],
  },
  notes: 'The representative capacity is never assumed; it must be confirmed by a reviewer before generation.',
};

// ===========================================================================
// T1 PERSONAL INCOME TAX COVER LETTER
// ===========================================================================

const T1_COVER_DEADLINE_TABLE = 'Signed Form T183 requested by';
const T1_COVER_BALANCE_TABLE = 'Net estimated balance';
const T1_COVER_INSTALMENT_TABLE = 'Instalment date';

export const T1_COVER_LETTER_SPEC: TemplateSpec = {
  documentType: 'T1_COVER_LETTER',
  sourceFileName: 'T1 Cover Letter.docx',
  mappings: [
    { placeholder: '[TAXATION YEAR]', token: 'engagement.tax_year' },
    { placeholder: '[CLIENT NAME]', token: 'taxpayer.full_legal_name' },
    { placeholder: '[CLIENT ADDRESS]', token: 'taxpayer.address' },
    { placeholder: '[DATE SENT]', token: 'dates.sent' },
    { placeholder: '[FILING DEADLINE]', token: 'dates.filing_deadline' },
    { placeholder: '[PAYMENT DEADLINE]', token: 'dates.payment_deadline' },
    {
      placeholder: '[DATE]',
      token: 'dates.t183_requested_by',
      scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_DEADLINE_TABLE, rowIndex: 3, cellIndex: 1 },
    },
    {
      placeholder: '[AMOUNT]',
      token: 'amounts.estimated_balance',
      scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_BALANCE_TABLE, rowIndex: 1, cellIndex: 1 },
    },
    {
      placeholder: '[DATE / ESTIMATED]',
      token: 'dates.balance_payment_date',
      scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_BALANCE_TABLE, rowIndex: 1, cellIndex: 2 },
    },
    {
      placeholder: '[AMOUNT]',
      token: 'amounts.instalments_or_withheld',
      scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_BALANCE_TABLE, rowIndex: 2, cellIndex: 1 },
    },
    {
      placeholder: '[AMOUNT]',
      token: 'amounts.net_balance',
      scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_BALANCE_TABLE, rowIndex: 3, cellIndex: 1 },
    },
    // Instalment schedule — two configurable rows.
    { placeholder: '[DATE]', token: 'instalment1.date', scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_INSTALMENT_TABLE, rowIndex: 1, cellIndex: 0 } },
    { placeholder: '[AMOUNT]', token: 'instalment1.amount', scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_INSTALMENT_TABLE, rowIndex: 1, cellIndex: 1 } },
    { placeholder: '[DETAILS]', token: 'instalment1.notes', scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_INSTALMENT_TABLE, rowIndex: 1, cellIndex: 3 } },
    { placeholder: '[DATE]', token: 'instalment2.date', scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_INSTALMENT_TABLE, rowIndex: 2, cellIndex: 0 } },
    { placeholder: '[AMOUNT]', token: 'instalment2.amount', scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_INSTALMENT_TABLE, rowIndex: 2, cellIndex: 1 } },
    { placeholder: '[DETAILS]', token: 'instalment2.notes', scope: { kind: 'TABLE_CELL', tableContains: T1_COVER_INSTALMENT_TABLE, rowIndex: 2, cellIndex: 3 } },
    {
      placeholder: '[DETAILS]',
      token: 'foreign.details',
      scope: { kind: 'PARAGRAPH', startsWith: '☐ The following foreign information returns' },
    },
    { placeholder: '[TELEPHONE NUMBER]', token: 'firm.telephone' },
    { placeholder: '[EMAIL ADDRESS]', token: 'firm.email' },
  ],
  fields: [
    field('taxpayer.full_legal_name', 'Taxpayer name', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 1 }),
    field('taxpayer.address', 'Address', 'MULTILINE', { required: true, displayGroup: 'CLIENT', displayOrder: 2 }),
    field('engagement.tax_year', 'Taxation year', 'YEAR', { required: true, displayGroup: 'DATES', displayOrder: 1 }),
    field('dates.sent', 'Date sent', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 2 }),
    field('dates.filing_deadline', 'Filing deadline', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 3 }),
    field('dates.payment_deadline', 'Payment deadline', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 4 }),
    field('dates.t183_requested_by', 'Signed Form T183 requested by', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 5 }),
    field('dates.balance_payment_date', 'Balance payment / refund date', 'STRING', { displayGroup: 'DATES', displayOrder: 6 }),
    field('amounts.estimated_balance', 'Estimated balance owing / (refund)', 'MONEY', { required: true, displayGroup: 'COVER_LETTER', displayOrder: 1 }),
    field('amounts.instalments_or_withheld', 'Prior instalments or tax withheld', 'MONEY', { required: true, displayGroup: 'COVER_LETTER', displayOrder: 2 }),
    field('amounts.net_balance', 'Net estimated balance / (refund)', 'MONEY', { required: true, displayGroup: 'COVER_LETTER', displayOrder: 3 }),
    field('instalment1.date', 'Instalment 1 date', 'STRING', { displayGroup: 'COVER_LETTER', displayOrder: 10 }),
    field('instalment1.amount', 'Instalment 1 amount', 'MONEY', { displayGroup: 'COVER_LETTER', displayOrder: 11 }),
    field('instalment1.notes', 'Instalment 1 notes', 'STRING', { displayGroup: 'COVER_LETTER', displayOrder: 12 }),
    field('instalment2.date', 'Instalment 2 date', 'STRING', { displayGroup: 'COVER_LETTER', displayOrder: 13 }),
    field('instalment2.amount', 'Instalment 2 amount', 'MONEY', { displayGroup: 'COVER_LETTER', displayOrder: 14 }),
    field('instalment2.notes', 'Instalment 2 notes', 'STRING', { displayGroup: 'COVER_LETTER', displayOrder: 15 }),
    field('foreign.details', 'Foreign information returns prepared or required', 'STRING', { displayGroup: 'COVER_LETTER', displayOrder: 20 }),
    field('firm.telephone', 'Firm telephone number', 'PHONE', { required: true, displayGroup: 'FIRM', displayOrder: 1 }),
    field('firm.email', 'Firm email address', 'EMAIL', { required: true, displayGroup: 'FIRM', displayOrder: 2 }),
  ],
  conditionalSections: [],
  checkboxes: [
    { code: 'enc.t1_return', label: 'Personal income tax return and supporting schedules', anchorText: 'Personal income tax return and supporting schedules', defaultChecked: false, alwaysChecked: false },
    { code: 'enc.t183', label: 'T183 Information Return for Electronic Filing', anchorText: 'T183 Information Return for Electronic Filing', defaultChecked: false, alwaysChecked: false },
    { code: 'enc.tax_summary', label: 'Tax summary showing the estimated balance owing or refund', anchorText: 'Tax summary showing the estimated balance owing or refund', defaultChecked: false, alwaysChecked: false },
    { code: 'enc.instalment_information', label: 'Instalment information', anchorText: 'Instalment information, where applicable', defaultChecked: false, alwaysChecked: false },
    { code: 'enc.engagement_letter', label: 'Engagement letter', anchorText: 'Engagement letter, where applicable', defaultChecked: false, alwaysChecked: false },
    { code: 'enc.other_schedules', label: 'Other schedules, elections or information returns', anchorText: 'Other schedules, elections or information returns prepared', defaultChecked: false, alwaysChecked: false },
    { code: 'instalments.not_required', label: 'Instalments not currently expected', anchorText: 'You are not currently expected to be required to make personal income tax instalments', defaultChecked: false, alwaysChecked: false },
    { code: 'instalments.required', label: 'Instalments may be required', anchorText: 'You may be required to make personal income tax instalments', defaultChecked: false, alwaysChecked: false },
    { code: 'foreign.none', label: 'No additional foreign information returns required', anchorText: 'You were not required to file any additional foreign information returns', defaultChecked: false, alwaysChecked: false },
    { code: 'foreign.required', label: 'Foreign information returns prepared or required', anchorText: 'The following foreign information returns were prepared', defaultChecked: false, alwaysChecked: false },
    { code: 'review.identity', label: 'Name, address, marital status, residency and dependants accurate', anchorText: 'Your name, address, marital status, residency and dependant information are accurate', defaultChecked: false, alwaysChecked: false },
  ],
  signatureAnchors: [],
  internalOnlySections: [],
  editableSections: [
    {
      key: 'cover_letter_intro',
      label: 'Introductory paragraphs',
      editLevel: 'ORDINARY',
      range: { startsWith: 'We are pleased to enclose your personal income tax return', endsBefore: '1. Documents enclosed', inclusiveEnd: false },
    },
  ],
  sanitation: {
    ...BASE_SANITATION,
    requiredText: ['PERSONAL INCOME TAX COVER LETTER', '16. Final review checklist'],
    expectedPageRange: [3, 10],
  },
  notes:
    'Written for a single taxpayer. A joint T1 engagement produces one cover letter per taxpayer; two taxpayers are never combined into one letter unless an approved joint cover-letter template is added.',
};

// ===========================================================================
// COMPILATION ENGAGEMENT COVER LETTER
// ===========================================================================

const COMP_DEADLINE_TABLE = 'Signed authorization forms requested by';
const COMP_TAX_TABLE = 'Total estimated balance';
const COMP_INSTALMENT_TABLE = 'First payment due';

export const COMPILATION_COVER_LETTER_SPEC: TemplateSpec = {
  documentType: 'COMPILATION_COVER_LETTER',
  sourceFileName: 'Compilation Engagement Cover Letter.docx',
  mappings: [
    { placeholder: '[CLIENT FULL LEGAL NAME]', token: 'client.legal_name' },
    { placeholder: '[CLIENT ADDRESS]', token: 'client.address' },
    { placeholder: '[CLIENT CONTACT NAME]', token: 'client.contact_name' },
    { placeholder: '[YEAR-END DATE]', token: 'client.year_end' },
    { placeholder: '[DATE SENT]', token: 'dates.sent' },
    { placeholder: '[FILING DEADLINE]', token: 'dates.filing_deadline' },
    { placeholder: '[PAYMENT DEADLINE]', token: 'dates.payment_deadline' },
    {
      placeholder: '[DATE]',
      token: 'dates.authorization_due',
      scope: { kind: 'TABLE_CELL', tableContains: COMP_DEADLINE_TABLE, rowIndex: 3, cellIndex: 1 },
    },
    { placeholder: '[AMOUNT]', token: 'amounts.federal_balance', scope: { kind: 'TABLE_CELL', tableContains: COMP_TAX_TABLE, rowIndex: 1, cellIndex: 1 } },
    { placeholder: '[DATE]', token: 'dates.federal_payment_due', scope: { kind: 'TABLE_CELL', tableContains: COMP_TAX_TABLE, rowIndex: 1, cellIndex: 2 } },
    { placeholder: '[AMOUNT]', token: 'amounts.provincial_balance', scope: { kind: 'TABLE_CELL', tableContains: COMP_TAX_TABLE, rowIndex: 2, cellIndex: 1 } },
    { placeholder: '[DATE]', token: 'dates.provincial_payment_due', scope: { kind: 'TABLE_CELL', tableContains: COMP_TAX_TABLE, rowIndex: 2, cellIndex: 2 } },
    { placeholder: '[AMOUNT]', token: 'amounts.total_balance', scope: { kind: 'TABLE_CELL', tableContains: COMP_TAX_TABLE, rowIndex: 3, cellIndex: 1 } },
    { placeholder: '[AMOUNT]', token: 'instalments.federal_amount', scope: { kind: 'TABLE_CELL', tableContains: COMP_INSTALMENT_TABLE, rowIndex: 1, cellIndex: 1 } },
    { placeholder: '[MONTHLY / QUARTERLY]', token: 'instalments.federal_frequency', scope: { kind: 'TABLE_CELL', tableContains: COMP_INSTALMENT_TABLE, rowIndex: 1, cellIndex: 2 } },
    { placeholder: '[DATE]', token: 'instalments.federal_first_due', scope: { kind: 'TABLE_CELL', tableContains: COMP_INSTALMENT_TABLE, rowIndex: 1, cellIndex: 3 } },
    { placeholder: '[AMOUNT]', token: 'instalments.provincial_amount', scope: { kind: 'TABLE_CELL', tableContains: COMP_INSTALMENT_TABLE, rowIndex: 2, cellIndex: 1 } },
    { placeholder: '[MONTHLY / QUARTERLY]', token: 'instalments.provincial_frequency', scope: { kind: 'TABLE_CELL', tableContains: COMP_INSTALMENT_TABLE, rowIndex: 2, cellIndex: 2 } },
    { placeholder: '[DATE]', token: 'instalments.provincial_first_due', scope: { kind: 'TABLE_CELL', tableContains: COMP_INSTALMENT_TABLE, rowIndex: 2, cellIndex: 3 } },
    {
      placeholder: '[DETAILS]',
      token: 'foreign.details',
      scope: { kind: 'PARAGRAPH', startsWith: '☐ The following foreign information returns' },
    },
  ],
  fields: [
    field('client.legal_name', 'Client full legal name', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 1 }),
    field('client.address', 'Client address', 'MULTILINE', { required: true, displayGroup: 'CLIENT', displayOrder: 2 }),
    field('client.contact_name', 'Client contact', 'STRING', { required: true, displayGroup: 'CLIENT', displayOrder: 3 }),
    field('client.year_end', 'Year-end date', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 1 }),
    field('dates.sent', 'Date sent', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 2 }),
    field('dates.filing_deadline', 'Filing deadline', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 3 }),
    field('dates.payment_deadline', 'Payment deadline', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 4 }),
    field('dates.authorization_due', 'Authorization due date', 'DATE', { required: true, displayGroup: 'DATES', displayOrder: 5 }),
    field('dates.federal_payment_due', 'Federal payment due date', 'DATE', { displayGroup: 'DATES', displayOrder: 6 }),
    field('dates.provincial_payment_due', 'Provincial payment due date', 'DATE', { displayGroup: 'DATES', displayOrder: 7 }),
    field('amounts.federal_balance', 'Federal tax balance or refund', 'MONEY', { required: true, displayGroup: 'COVER_LETTER', displayOrder: 1 }),
    field('amounts.provincial_balance', 'Provincial tax balance or refund', 'MONEY', { required: true, displayGroup: 'COVER_LETTER', displayOrder: 2 }),
    field('amounts.total_balance', 'Total estimated balance', 'MONEY', { required: true, displayGroup: 'COVER_LETTER', displayOrder: 3 }),
    field('instalments.federal_amount', 'Federal instalment amount', 'MONEY', { displayGroup: 'COVER_LETTER', displayOrder: 10 }),
    field('instalments.federal_frequency', 'Federal instalment frequency', 'STRING', { displayGroup: 'COVER_LETTER', displayOrder: 11 }),
    field('instalments.federal_first_due', 'Federal first instalment date', 'DATE', { displayGroup: 'COVER_LETTER', displayOrder: 12 }),
    field('instalments.provincial_amount', 'Provincial instalment amount', 'MONEY', { displayGroup: 'COVER_LETTER', displayOrder: 13 }),
    field('instalments.provincial_frequency', 'Provincial instalment frequency', 'STRING', { displayGroup: 'COVER_LETTER', displayOrder: 14 }),
    field('instalments.provincial_first_due', 'Provincial first instalment date', 'DATE', { displayGroup: 'COVER_LETTER', displayOrder: 15 }),
    field('foreign.details', 'Foreign information returns prepared or required', 'STRING', { displayGroup: 'COVER_LETTER', displayOrder: 20 }),
  ],
  conditionalSections: [
    {
      key: 'adjusting_journal_entries',
      label: 'Adjusting journal entries instruction',
      controlledBy: 'enc.adjusting_journal_entries',
      removeWhenFalse: true,
      requiredFields: [],
      ranges: [
        { startsWith: 'Adjusting journal entries', endsBefore: 'Business expenses and supporting documentation', inclusiveEnd: false },
      ],
    },
  ],
  checkboxes: [
    { code: 'instalments.not_required', label: 'Corporation not required to make instalments', anchorText: 'The corporation is not currently required to make corporate income tax instalments', defaultChecked: false, alwaysChecked: false },
    { code: 'instalments.required', label: 'Corporation required to make instalments', anchorText: 'The corporation is required to make corporate income tax instalments', defaultChecked: false, alwaysChecked: false },
    { code: 'foreign.none', label: 'No additional foreign information returns required', anchorText: 'The corporation was not required to file any additional foreign information returns', defaultChecked: false, alwaysChecked: false },
    { code: 'foreign.required', label: 'Foreign information returns prepared or required', anchorText: 'The following foreign information returns were prepared', defaultChecked: false, alwaysChecked: false },
  ],
  signatureAnchors: [],
  internalOnlySections: [],
  editableSections: [
    {
      key: 'cover_letter_intro',
      label: 'Introductory paragraphs',
      editLevel: 'ORDINARY',
      range: { startsWith: 'We are pleased to enclose the year-end compilation engagement documents', endsBefore: 'Documents enclosed', inclusiveEnd: false },
    },
  ],
  sanitation: {
    ...BASE_SANITATION,
    requiredText: ['COMPILATION ENGAGEMENT COVER LETTER', 'Final review checklist'],
    expectedPageRange: [3, 10],
  },
  notes:
    'The enclosure list is dynamic: each bullet under "Documents enclosed" is emitted only when the corresponding final document is present and selected for delivery. See ENCLOSURE_RULES.',
};

/**
 * The "Documents enclosed" bullets in the compilation cover letter are static
 * text in the approved template. Each bullet is removed unless the matching
 * final document is actually present and selected for delivery.
 */
export const COMPILATION_ENCLOSURE_RULES: readonly {
  code: string;
  label: string;
  anchorText: string;
  requiredSourceKinds: readonly string[];
}[] = [
  {
    code: 'enc.financial_statements',
    label: 'Compiled financial statements and the compilation engagement report',
    anchorText: 'Compiled financial statements and the compilation engagement report',
    requiredSourceKinds: ['COMPILED_FINANCIAL_STATEMENTS', 'COMPILATION_ENGAGEMENT_REPORT'],
  },
  {
    code: 'enc.tax_returns',
    label: 'Corporate income tax returns and supporting schedules',
    anchorText: 'Corporate income tax returns and supporting schedules',
    requiredSourceKinds: ['FINAL_T2_RETURN'],
  },
  {
    code: 'enc.trial_balance_and_aje',
    label: 'Trial balance and adjusting journal entries',
    anchorText: 'Trial balance and adjusting journal entries',
    requiredSourceKinds: ['TRIAL_BALANCE', 'ADJUSTING_JOURNAL_ENTRIES'],
  },
  {
    code: 'enc.authorizations',
    label: 'Federal and provincial corporate tax filing authorization forms',
    anchorText: 'Federal and provincial corporate tax filing authorization forms',
    requiredSourceKinds: ['FEDERAL_FILING_AUTHORIZATION', 'PROVINCIAL_FILING_AUTHORIZATION'],
  },
  {
    code: 'enc.engagement_letter',
    label: 'Engagement letter',
    anchorText: 'Engagement letter, where applicable',
    requiredSourceKinds: [],
  },
  {
    code: 'enc.other',
    label: 'Other schedules or documents prepared as part of the engagement',
    anchorText: 'Other schedules or documents prepared as part of the engagement',
    requiredSourceKinds: ['OTHER_SUPPORTING_SCHEDULE'],
  },
];

export const TEMPLATE_SPECS: readonly TemplateSpec[] = [
  T2_ENGAGEMENT_LETTER_SPEC,
  T1_JOINT_ENGAGEMENT_LETTER_SPEC,
  T3_ENGAGEMENT_LETTER_SPEC,
  T1_COVER_LETTER_SPEC,
  COMPILATION_COVER_LETTER_SPEC,
];

export function specFor(documentType: DocumentType): TemplateSpec | null {
  return TEMPLATE_SPECS.find((spec) => spec.documentType === documentType) ?? null;
}
