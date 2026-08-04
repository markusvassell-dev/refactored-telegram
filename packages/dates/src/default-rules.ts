import type { EngagementType } from '@element/shared';
import type { DateRuleDefinition } from './rule-engine.js';

/**
 * Seeded date rules.
 *
 * These encode the firm's *starting* interpretation. Every one is editable by
 * an administrator on the Date Rules screen, and every calculated result is
 * confirmed by a reviewer before a document is sent.
 */

export interface SeedDateRule {
  code: string;
  label: string;
  engagementType: EngagementType | null;
  definition: DateRuleDefinition;
  notes: string;
}

export const DEFAULT_DATE_RULES: readonly SeedDateRule[] = [
  // ---------------------------------------------------------------- T1
  {
    code: 't1.filing_deadline',
    label: 'T1 filing deadline',
    engagementType: null,
    definition: {
      base: 'CALENDAR_YEAR_END',
      requiredFacts: ['isSelfEmployedOrSpouseOfSelfEmployed'],
      steps: [{ op: 'FIXED_MONTH_DAY', month: 4, day: 30, yearOffset: 1 }],
      branches: [
        {
          whenFact: 'isSelfEmployedOrSpouseOfSelfEmployed',
          whenValue: true,
          steps: [{ op: 'FIXED_MONTH_DAY', month: 6, day: 15, yearOffset: 1 }],
          assumption:
            'Self-employment filing date applied because the taxpayer (or their spouse or common-law partner) reported self-employment income.',
        },
      ],
      assumption: 'General individual filing date of April 30 following the taxation year.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    notes:
      'Self-employed individuals may have a later filing deadline, but any balance owing is generally still payable by the regular payment deadline. Weekend and holiday relief is a legal judgement and is confirmed by a reviewer.',
  },
  {
    code: 't1.payment_deadline',
    label: 'T1 payment deadline',
    engagementType: null,
    definition: {
      base: 'CALENDAR_YEAR_END',
      steps: [{ op: 'FIXED_MONTH_DAY', month: 4, day: 30, yearOffset: 1 }],
      branches: [],
      requiredFacts: [],
      assumption: 'The balance-due date is April 30 following the taxation year regardless of the filing deadline.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    notes: 'Applies to self-employed individuals as well; only the filing date is extended.',
  },
  {
    code: 't1.information_due_date',
    label: 'T1 client information deadline',
    engagementType: null,
    definition: {
      base: 'FILING_DEADLINE',
      steps: [{ op: 'ADD_DAYS', days: -45 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Firm policy: complete information is requested 45 days before the filing deadline.',
      rollToBusinessDay: true,
      requiresConfirmation: true,
    },
    notes: 'Firm service-level policy, not a statutory date.',
  },
  {
    code: 't1.t183_requested_by',
    label: 'Signed Form T183 requested by',
    engagementType: null,
    definition: {
      base: 'FILING_DEADLINE',
      steps: [{ op: 'ADD_BUSINESS_DAYS', days: -5 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Firm policy: the signed T183 is requested five business days before the filing deadline.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    notes: 'Firm service-level policy.',
  },

  // ---------------------------------------------------------------- T2
  {
    code: 't2.filing_deadline',
    label: 'T2 filing deadline',
    engagementType: 'T2',
    definition: {
      base: 'YEAR_END',
      steps: [{ op: 'ADD_MONTHS', months: 6 }],
      branches: [],
      requiredFacts: [],
      assumption: 'A corporation generally must file its T2 return within six months after its taxation year-end.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    notes: 'General rule. Confirm against the corporation facts before issuing the letter.',
  },
  {
    code: 't2.balance_due_date',
    label: 'T2 estimated balance-due day',
    engagementType: 'T2',
    definition: {
      base: 'YEAR_END',
      requiredFacts: ['qualifiesForThreeMonthBalanceDueDay'],
      steps: [{ op: 'ADD_MONTHS', months: 2 }],
      branches: [
        {
          whenFact: 'qualifiesForThreeMonthBalanceDueDay',
          whenValue: true,
          steps: [{ op: 'ADD_MONTHS', months: 3 }],
          assumption:
            'Three-month balance-due day applied because the corporation was confirmed to be a qualifying Canadian-controlled private corporation.',
        },
      ],
      assumption: 'The balance of tax is generally due two months after year-end.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    notes:
      'Eligibility for the three-month balance-due day must be confirmed for each corporation. Until it is confirmed the rule is blocked rather than guessed.',
  },
  {
    code: 't2.information_due_date',
    label: 'T2 client information due date',
    engagementType: 'T2',
    definition: {
      base: 'YEAR_END',
      steps: [{ op: 'ADD_MONTHS', months: 3 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Firm policy: complete information is requested three months after year-end.',
      rollToBusinessDay: true,
      requiresConfirmation: true,
    },
    notes: 'Firm service-level policy.',
  },
  {
    code: 't2.target_completion_date',
    label: 'T2 target completion date',
    engagementType: 'T2',
    definition: {
      base: 'FILING_DEADLINE',
      steps: [{ op: 'ADD_DAYS', days: -30 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Firm policy: target completion 30 days before the filing deadline, subject to complete information.',
      rollToBusinessDay: true,
      requiresConfirmation: true,
    },
    notes: 'Firm service-level policy.',
  },
  {
    code: 't2.authorization_due_date',
    label: 'Signed authorization forms requested by',
    engagementType: 'T2',
    definition: {
      base: 'FILING_DEADLINE',
      steps: [{ op: 'ADD_BUSINESS_DAYS', days: -10 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Firm policy: signed filing authorizations are requested ten business days before the filing deadline.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    notes: 'Firm service-level policy.',
  },

  // ---------------------------------------------------------------- T3
  {
    code: 't3.filing_deadline',
    label: 'T3 filing deadline',
    engagementType: 'T3',
    definition: {
      base: 'YEAR_END',
      steps: [{ op: 'ADD_DAYS', days: 90 }],
      branches: [],
      requiredFacts: [],
      assumption:
        'A T3 return, the related slips and summaries, and any balance owing are generally due no later than 90 days after the trust tax year-end.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    notes: 'General rule stated in the approved T3 template.',
  },
  {
    code: 't3.payment_deadline',
    label: 'T3 payment deadline',
    engagementType: 'T3',
    definition: {
      base: 'YEAR_END',
      steps: [{ op: 'ADD_DAYS', days: 90 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Any balance owing is generally due 90 days after the trust tax year-end.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    notes: 'General rule stated in the approved T3 template.',
  },
  {
    code: 't3.information_due_date',
    label: 'T3 client information deadline',
    engagementType: 'T3',
    definition: {
      base: 'FILING_DEADLINE',
      steps: [{ op: 'ADD_DAYS', days: -45 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Firm policy: complete information is requested 45 days before the filing deadline.',
      rollToBusinessDay: true,
      requiresConfirmation: true,
    },
    notes: 'Firm service-level policy.',
  },

  // ---------------------------------------------------------------- Signing
  {
    code: 'signing.expiration_date',
    label: 'Adobe Sign expiration date',
    engagementType: null,
    definition: {
      base: 'DATE_SENT',
      steps: [{ op: 'ADD_DAYS', days: 30 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Default Adobe Sign expiry of 30 days after sending.',
      rollToBusinessDay: false,
      requiresConfirmation: false,
    },
    notes: 'Configurable per engagement type on the Integrations screen.',
  },
  {
    code: 'signing.first_reminder_date',
    label: 'First signing reminder',
    engagementType: null,
    definition: {
      base: 'DATE_SENT',
      steps: [{ op: 'ADD_BUSINESS_DAYS', days: 3 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Default reminder frequency of every three business days.',
      rollToBusinessDay: false,
      requiresConfirmation: false,
    },
    notes: 'Adobe Sign sends the reminders; this date is shown in the app for visibility.',
  },
];

/** Facts a reviewer must supply before certain deadlines can be calculated. */
export const DATE_FACTS: readonly { key: string; label: string; appliesTo: EngagementType[] }[] = [
  {
    key: 'isSelfEmployedOrSpouseOfSelfEmployed',
    label: 'Taxpayer (or spouse/common-law partner) has self-employment income',
    appliesTo: ['T1_JOINT', 'T1_SINGLE'],
  },
  {
    key: 'qualifiesForThreeMonthBalanceDueDay',
    label: 'Corporation qualifies for the three-month balance-due day',
    appliesTo: ['T2'],
  },
];
