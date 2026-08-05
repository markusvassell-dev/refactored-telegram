'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { calculateFee } from '@element/pricing';
import type { FeeKind, FeeMethod } from '@element/shared';
import { ActionForm } from '@/components/action-form';
import { saveFeeRule } from '@/app/actions';

/**
 * The pricing-rule editor.
 *
 * The preview runs `calculateFee` — the same function the pricing service calls
 * — so the number shown before saving is the number the rule will produce,
 * including the round-up to the next $5 and whether the result would need
 * partner approval.
 */

const LEVELS: { value: string; label: string; help: string }[] = [
  { value: 'GLOBAL', label: 'Global', help: 'Applies to everything with no more specific rule.' },
  { value: 'ENGAGEMENT_TYPE', label: 'Engagement type', help: 'Applies to one engagement type.' },
  { value: 'PARTNER_OR_GROUP', label: 'Partner or client group', help: 'Applies to one partner’s clients, or one group.' },
  { value: 'CLIENT', label: 'Client', help: 'Applies to one client.' },
  { value: 'ONE_TIME_OVERRIDE', label: 'One-time override', help: 'The most specific level; beats everything else.' },
];

const METHODS: { value: FeeMethod; label: string; help: string }[] = [
  { value: 'PERCENTAGE', label: 'Percentage increase', help: 'Last year’s fee plus this percentage.' },
  { value: 'FIXED_AMOUNT', label: 'Fixed increase', help: 'Last year’s fee plus this amount.' },
  { value: 'EXACT_TARGET', label: 'Exact target price', help: 'This amount, whatever last year’s fee was.' },
  { value: 'NO_INCREASE', label: 'No increase', help: 'Last year’s fee, unchanged.' },
];

const FEE_KINDS: { value: FeeKind | ''; label: string }[] = [
  { value: '', label: 'Any fee' },
  { value: 'T1_PREPARATION', label: 'T1 preparation' },
  { value: 'T2_PREPARATION', label: 'T2 preparation' },
  { value: 'T3_PREPARATION', label: 'T3 preparation' },
  { value: 'CSRS_4200_COMPILATION', label: 'CSRS 4200 compilation' },
];

export interface FeeRuleFormValues {
  id: string | null;
  level: string;
  engagementType: string;
  feeKind: string;
  clientId: string;
  clientGroup: string;
  partnerUserId: string;
  method: FeeMethod;
  percentage: string;
  fixedAmount: string;
  exactTarget: string;
  skipRounding: boolean;
  appliesToAncillaryCharges: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  isActive: boolean;
  description: string;
}

export function FeeRuleEditor({
  csrfToken,
  initial,
  clients,
  partners,
  highIncreaseThresholdPercent,
}: {
  csrfToken: string;
  initial: FeeRuleFormValues;
  clients: { id: string; legalName: string }[];
  partners: { id: string; displayName: string }[];
  highIncreaseThresholdPercent: number;
}): ReactNode {
  const [values, setValues] = useState<FeeRuleFormValues>(initial);
  const [samplePreviousFee, setSamplePreviousFee] = useState('2000.00');

  function set<K extends keyof FeeRuleFormValues>(key: K, value: FeeRuleFormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  // The same engine the pricing service uses, so the preview cannot promise a
  // number the rule would not actually produce.
  const preview = useMemo(() => {
    try {
      return calculateFee({
        feeKind: (values.feeKind || 'T2_PREPARATION') as FeeKind,
        rule: {
          method: values.method,
          percentage: values.percentage || null,
          fixedAmount: values.fixedAmount || null,
          exactTarget: values.exactTarget || null,
          skipRounding: values.skipRounding,
        },
        previousFee: samplePreviousFee || null,
        previousFeeSource: 'PRIOR_YEAR_DOCUMENT',
        highIncreaseThresholdPercent,
      });
    } catch {
      return null;
    }
  }, [values, samplePreviousFee, highIncreaseThresholdPercent]);

  const method = METHODS.find((entry) => entry.value === values.method);
  const level = LEVELS.find((entry) => entry.value === values.level);

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
      <div className="card">
        <div className="card-body">
          <ActionForm action={saveFeeRule} csrfToken={csrfToken} submitLabel={initial.id ? 'Save this rule' : 'Create this rule'}>
            {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
            <input type="hidden" name="level" value={values.level} />
            <input type="hidden" name="method" value={values.method} />
            <input type="hidden" name="engagementType" value={values.engagementType} />
            <input type="hidden" name="feeKind" value={values.feeKind} />
            <input type="hidden" name="clientId" value={values.clientId} />
            <input type="hidden" name="clientGroup" value={values.clientGroup} />
            <input type="hidden" name="partnerUserId" value={values.partnerUserId} />
            <input type="hidden" name="percentage" value={values.percentage} />
            <input type="hidden" name="fixedAmount" value={values.fixedAmount} />
            <input type="hidden" name="exactTarget" value={values.exactTarget} />
            <input type="hidden" name="skipRounding" value={values.skipRounding ? 'yes' : 'no'} />
            <input
              type="hidden"
              name="appliesToAncillaryCharges"
              value={values.appliesToAncillaryCharges ? 'yes' : 'no'}
            />
            <input type="hidden" name="isActive" value={values.isActive ? 'yes' : 'no'} />
            <input type="hidden" name="effectiveFrom" value={values.effectiveFrom} />
            <input type="hidden" name="effectiveTo" value={values.effectiveTo} />

            <div>
              <label className="label" htmlFor="rule-level">
                Applies at
              </label>
              <select
                id="rule-level"
                className="input"
                value={values.level}
                onChange={(event) => set('level', event.target.value)}
              >
                {LEVELS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <p className="field-note">{level?.help} A more specific rule always wins.</p>
            </div>

            {values.level === 'ENGAGEMENT_TYPE' ? (
              <div>
                <label className="label" htmlFor="rule-engagement-type">
                  Engagement type
                </label>
                <select
                  id="rule-engagement-type"
                  className="input"
                  value={values.engagementType}
                  onChange={(event) => set('engagementType', event.target.value)}
                >
                  <option value="">— choose one —</option>
                  <option value="T1_JOINT">T1 joint</option>
                  <option value="T1_SINGLE">T1 single</option>
                  <option value="T2">T2</option>
                  <option value="T3">T3</option>
                </select>
              </div>
            ) : null}

            {values.level === 'PARTNER_OR_GROUP' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="rule-partner">
                    Partner
                  </label>
                  <select
                    id="rule-partner"
                    className="input"
                    value={values.partnerUserId}
                    onChange={(event) => set('partnerUserId', event.target.value)}
                  >
                    <option value="">— none —</option>
                    {partners.map((partner) => (
                      <option key={partner.id} value={partner.id}>
                        {partner.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="rule-client-group">
                    Client group
                  </label>
                  <input
                    id="rule-client-group"
                    className="input"
                    value={values.clientGroup}
                    onChange={(event) => set('clientGroup', event.target.value)}
                  />
                  <p className="field-note">One of the two is enough.</p>
                </div>
              </div>
            ) : null}

            {values.level === 'CLIENT' || values.level === 'ONE_TIME_OVERRIDE' ? (
              <div>
                <label className="label" htmlFor="rule-client">
                  Client
                </label>
                <select
                  id="rule-client"
                  className="input"
                  value={values.clientId}
                  onChange={(event) => set('clientId', event.target.value)}
                >
                  <option value="">— choose one —</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.legalName}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div>
              <label className="label" htmlFor="rule-fee-kind">
                Which fee
              </label>
              <select
                id="rule-fee-kind"
                className="input"
                value={values.feeKind}
                onChange={(event) => set('feeKind', event.target.value)}
              >
                {FEE_KINDS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <p className="field-note">
                The compilation fee is priced separately from the T2 fee, so a rule for one does not touch the other.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="rule-method">
                How the new fee is worked out
              </label>
              <select
                id="rule-method"
                className="input"
                value={values.method}
                onChange={(event) => set('method', event.target.value as FeeMethod)}
              >
                {METHODS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <p className="field-note">{method?.help}</p>
            </div>

            {values.method === 'PERCENTAGE' ? (
              <div>
                <label className="label" htmlFor="rule-percentage">
                  Increase
                </label>
                <input
                  id="rule-percentage"
                  className="input w-40"
                  inputMode="decimal"
                  value={values.percentage}
                  onChange={(event) => set('percentage', event.target.value)}
                />
                <span className="ml-2 text-sm text-slate-600">%</span>
              </div>
            ) : null}

            {values.method === 'FIXED_AMOUNT' ? (
              <div>
                <label className="label" htmlFor="rule-fixed">
                  Increase
                </label>
                <input
                  id="rule-fixed"
                  className="input w-40"
                  inputMode="decimal"
                  value={values.fixedAmount}
                  onChange={(event) => set('fixedAmount', event.target.value)}
                />
                <span className="ml-2 text-sm text-slate-600">before GST</span>
              </div>
            ) : null}

            {values.method === 'EXACT_TARGET' ? (
              <div>
                <label className="label" htmlFor="rule-target">
                  Target price
                </label>
                <input
                  id="rule-target"
                  className="input w-40"
                  inputMode="decimal"
                  value={values.exactTarget}
                  onChange={(event) => set('exactTarget', event.target.value)}
                />
                <span className="ml-2 text-sm text-slate-600">before GST</span>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="rule-effective-from">
                  Applies from
                </label>
                <input
                  id="rule-effective-from"
                  type="date"
                  className="input"
                  value={values.effectiveFrom}
                  onChange={(event) => set('effectiveFrom', event.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="rule-effective-to">
                  Applies until (optional)
                </label>
                <input
                  id="rule-effective-to"
                  type="date"
                  className="input"
                  value={values.effectiveTo}
                  onChange={(event) => set('effectiveTo', event.target.value)}
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.appliesToAncillaryCharges}
                onChange={(event) => set('appliesToAncillaryCharges', event.target.checked)}
              />
              Also increase retainers, hourly rates and out-of-pocket charges
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.skipRounding}
                onChange={(event) => set('skipRounding', event.target.checked)}
              />
              Exception: do not round up to the next $5
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={values.isActive} onChange={(event) => set('isActive', event.target.checked)} />
              Active — an inactive rule is never resolved
            </label>

            <div>
              <label className="label" htmlFor="rule-description">
                Description
              </label>
              <input
                id="rule-description"
                name="description"
                className="input"
                value={values.description}
                onChange={(event) => set('description', event.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor="rule-reason">
                Why are you changing this?
              </label>
              <textarea id="rule-reason" name="reason" className="input" rows={2} required minLength={10} />
              <p className="field-note">Recorded in the audit trail with the whole rule, before and after.</p>
            </div>
          </ActionForm>
        </div>
      </div>

      <div>
        <section className="card">
          <div className="card-header">
            <h2 className="text-base font-semibold text-slate-900">Preview</h2>
            <p className="mt-1 text-sm text-slate-600">Computed by the same pricing engine, as you type.</p>
          </div>
          <div className="card-body">
            <label className="label" htmlFor="sample-previous-fee">
              If last year&rsquo;s fee was
            </label>
            <input
              id="sample-previous-fee"
              className="input w-40"
              inputMode="decimal"
              value={samplePreviousFee}
              onChange={(event) => setSamplePreviousFee(event.target.value)}
            />

            <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
              {!preview || preview.isBlocked ? (
                <p className="text-sm text-amber-800">
                  {preview?.blockedReason ?? 'This rule does not produce a fee yet.'}
                </p>
              ) : (
                <>
                  <p className="text-lg font-semibold text-slate-900">
                    ${preview.roundedFee?.toFixed(2) ?? '—'}
                  </p>
                  <p className="text-xs text-slate-600">
                    {preview.unroundedFee ? `$${preview.unroundedFee.toFixed(2)} before rounding` : ''}
                    {preview.effectivePercentage ? ` · ${preview.effectivePercentage.toFixed(2)}% effective` : ''}
                  </p>
                </>
              )}

              {preview && preview.requiredApproval !== 'NONE' ? (
                <p className="mt-2 text-sm text-amber-800">
                  Needs partner approval: {preview.requiredApproval.replace(/_/g, ' ').toLowerCase()}.
                </p>
              ) : null}

              {preview && preview.warnings.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-700">
                  {preview.warnings.map((warning) => (
                    <li key={warning.code}>{warning.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            <p className="mt-3 text-xs text-slate-500">
              Every calculated fee is rounded upward to the next $5 unless this rule sets the exception. Fees are quoted
              before GST.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
