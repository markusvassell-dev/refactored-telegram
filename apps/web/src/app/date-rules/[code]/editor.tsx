'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { evaluateDateRule, type DateRuleDefinition, type DateStep } from '@element/dates';
import { ActionForm } from '@/components/action-form';
import { updateDateRule } from '@/app/actions';

/**
 * The date-rule editor.
 *
 * A rule is edited against a live preview computed by `evaluateDateRule` — the
 * same function the worker calls — so what an administrator sees before saving
 * cannot disagree with what the application will actually produce.
 *
 * Which facts a rule depends on, and the conditions its branches test, are not
 * editable here. A new fact needs a question a reviewer can answer, and those
 * live in the fact catalogue in code; offering a free-text fact name would let
 * someone create a deadline that can never be unblocked.
 */

const BASES: { value: DateRuleDefinition['base']; label: string }[] = [
  { value: 'YEAR_END', label: 'The fiscal or trust year-end' },
  { value: 'CALENDAR_YEAR_END', label: 'December 31 of the taxation year' },
  { value: 'DATE_SENT', label: 'The date the letter is sent' },
  { value: 'FILING_DEADLINE', label: 'The filing deadline this engagement already calculated' },
  { value: 'PAYMENT_DEADLINE', label: 'The payment deadline this engagement already calculated' },
  { value: 'CUSTOM_INPUT', label: 'A date supplied for this engagement' },
];

const OPERATIONS: { value: DateStep['op']; label: string; unit: string | null }[] = [
  { value: 'ADD_DAYS', label: 'Add days', unit: 'days' },
  { value: 'ADD_BUSINESS_DAYS', label: 'Add business days', unit: 'days' },
  { value: 'ADD_MONTHS', label: 'Add months', unit: 'months' },
  { value: 'ADD_YEARS', label: 'Add years', unit: 'years' },
  { value: 'END_OF_MONTH', label: 'Move to the end of that month', unit: null },
  { value: 'FIXED_MONTH_DAY', label: 'Move to a fixed month and day', unit: null },
];

function describeStep(step: DateStep): string {
  switch (step.op) {
    case 'ADD_DAYS':
      return `${step.days >= 0 ? 'Add' : 'Subtract'} ${Math.abs(step.days)} day(s)`;
    case 'ADD_BUSINESS_DAYS':
      return `${step.days >= 0 ? 'Add' : 'Subtract'} ${Math.abs(step.days)} business day(s)`;
    case 'ADD_MONTHS':
      return `${step.months >= 0 ? 'Add' : 'Subtract'} ${Math.abs(step.months)} month(s)`;
    case 'ADD_YEARS':
      return `${step.years >= 0 ? 'Add' : 'Subtract'} ${Math.abs(step.years)} year(s)`;
    case 'END_OF_MONTH':
      return 'Move to the end of that month';
    case 'FIXED_MONTH_DAY':
      return `Move to ${step.month}/${step.day}${step.yearOffset ? `, ${step.yearOffset} year(s) later` : ''}`;
    default:
      return 'Unknown step';
  }
}

/** The single number a step carries, if it carries one. */
function amountOf(step: DateStep): number | null {
  if (step.op === 'ADD_DAYS' || step.op === 'ADD_BUSINESS_DAYS') return step.days;
  if (step.op === 'ADD_MONTHS') return step.months;
  if (step.op === 'ADD_YEARS') return step.years;
  return null;
}

function withAmount(step: DateStep, amount: number): DateStep {
  switch (step.op) {
    case 'ADD_DAYS':
    case 'ADD_BUSINESS_DAYS':
      return { ...step, days: amount };
    case 'ADD_MONTHS':
      return { ...step, months: amount };
    case 'ADD_YEARS':
      return { ...step, years: amount };
    default:
      return step;
  }
}

function blankStep(op: DateStep['op']): DateStep {
  switch (op) {
    case 'ADD_DAYS':
    case 'ADD_BUSINESS_DAYS':
      return { op, days: 0 };
    case 'ADD_MONTHS':
      return { op, months: 0 };
    case 'ADD_YEARS':
      return { op, years: 0 };
    case 'END_OF_MONTH':
      return { op };
    case 'FIXED_MONTH_DAY':
      return { op, month: 1, day: 1, yearOffset: 0 };
    default:
      return { op: 'ADD_DAYS', days: 0 };
  }
}

function StepRows({
  steps,
  onChange,
  legend,
}: {
  steps: DateStep[];
  onChange: (steps: DateStep[]) => void;
  legend: string;
}): ReactNode {
  return (
    <fieldset>
      <legend className="label">{legend}</legend>
      <p className="field-note mb-2">Applied in order, each to the result of the one before it.</p>

      {steps.length === 0 ? <p className="text-sm text-slate-500">No steps yet.</p> : null}

      {steps.map((step, index) => {
        const operation = OPERATIONS.find((entry) => entry.value === step.op);
        const amount = amountOf(step);

        return (
          <div key={`${legend}-${index}`} className="mb-2 flex flex-wrap items-end gap-2">
            <div>
              <label className="sr-only" htmlFor={`${legend}-op-${index}`}>
                Step {index + 1} operation
              </label>
              <select
                id={`${legend}-op-${index}`}
                className="input"
                value={step.op}
                onChange={(event) => {
                  const next = [...steps];
                  next[index] = blankStep(event.target.value as DateStep['op']);
                  onChange(next);
                }}
              >
                {OPERATIONS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            {amount !== null ? (
              <div>
                <label className="sr-only" htmlFor={`${legend}-amount-${index}`}>
                  Step {index + 1} amount
                </label>
                <input
                  id={`${legend}-amount-${index}`}
                  type="number"
                  className="input w-28"
                  value={amount}
                  onChange={(event) => {
                    const next = [...steps];
                    next[index] = withAmount(step, Number(event.target.value));
                    onChange(next);
                  }}
                />
                <span className="ml-2 text-xs text-slate-500">{operation?.unit}</span>
              </div>
            ) : null}

            {step.op === 'FIXED_MONTH_DAY' ? (
              <>
                <div>
                  <label className="sr-only" htmlFor={`${legend}-month-${index}`}>
                    Step {index + 1} month
                  </label>
                  <input
                    id={`${legend}-month-${index}`}
                    type="number"
                    min={1}
                    max={12}
                    className="input w-24"
                    value={step.month}
                    onChange={(event) => {
                      const next = [...steps];
                      next[index] = { ...step, month: Number(event.target.value) };
                      onChange(next);
                    }}
                  />
                  <span className="ml-2 text-xs text-slate-500">month</span>
                </div>
                <div>
                  <label className="sr-only" htmlFor={`${legend}-day-${index}`}>
                    Step {index + 1} day
                  </label>
                  <input
                    id={`${legend}-day-${index}`}
                    type="number"
                    min={1}
                    max={31}
                    className="input w-24"
                    value={step.day}
                    onChange={(event) => {
                      const next = [...steps];
                      next[index] = { ...step, day: Number(event.target.value) };
                      onChange(next);
                    }}
                  />
                  <span className="ml-2 text-xs text-slate-500">day</span>
                </div>
                <div>
                  <label className="sr-only" htmlFor={`${legend}-offset-${index}`}>
                    Step {index + 1} year offset
                  </label>
                  <input
                    id={`${legend}-offset-${index}`}
                    type="number"
                    className="input w-24"
                    value={step.yearOffset ?? 0}
                    onChange={(event) => {
                      const next = [...steps];
                      next[index] = { ...step, yearOffset: Number(event.target.value) };
                      onChange(next);
                    }}
                  />
                  <span className="ml-2 text-xs text-slate-500">years later</span>
                </div>
              </>
            ) : null}

            <button
              type="button"
              className="btn-secondary"
              onClick={() => onChange(steps.filter((_, position) => position !== index))}
            >
              Remove
            </button>
          </div>
        );
      })}

      <button type="button" className="btn-secondary" onClick={() => onChange([...steps, blankStep('ADD_DAYS')])}>
        Add a step
      </button>
    </fieldset>
  );
}

export function DateRuleEditor({
  csrfToken,
  code,
  label: initialLabel,
  notes: initialNotes,
  isActive: initialIsActive,
  definition: initialDefinition,
  sample,
}: {
  csrfToken: string;
  code: string;
  label: string;
  notes: string | null;
  isActive: boolean;
  definition: DateRuleDefinition;
  sample: { yearEnd: string; taxYear: number };
}): ReactNode {
  const [label, setLabel] = useState(initialLabel);
  const [notes, setNotes] = useState(initialNotes ?? '');
  const [isActive, setIsActive] = useState(initialIsActive);
  const [definition, setDefinition] = useState<DateRuleDefinition>(initialDefinition);

  const [sampleYearEnd, setSampleYearEnd] = useState(sample.yearEnd);
  const [sampleFacts, setSampleFacts] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(definition.requiredFacts.map((fact) => [fact, false])),
  );

  // The same evaluator the worker uses, so the preview cannot lie about what
  // the saved rule will produce.
  const preview = useMemo(() => {
    const yearEnd = /^\d{4}-\d{2}-\d{2}$/.test(sampleYearEnd) ? new Date(`${sampleYearEnd}T00:00:00Z`) : null;

    return evaluateDateRule(code, definition, {
      yearEnd,
      taxYear: sample.taxYear,
      dateSent: new Date(),
      // Stand-ins so a rule built on another deadline still previews.
      filingDeadline: yearEnd ? new Date(yearEnd.getTime() + 180 * 86_400_000) : null,
      paymentDeadline: yearEnd ? new Date(yearEnd.getTime() + 60 * 86_400_000) : null,
      customInput: yearEnd,
      facts: sampleFacts,
    });
  }, [code, definition, sampleYearEnd, sample.taxYear, sampleFacts]);

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
      <div className="card">
        <div className="card-body">
          <ActionForm action={updateDateRule} csrfToken={csrfToken} submitLabel="Save this rule">
            <input type="hidden" name="code" value={code} />
            <input type="hidden" name="definition" value={JSON.stringify(definition)} />
            <input type="hidden" name="requiresConfirmation" value={definition.requiresConfirmation ? 'yes' : 'no'} />
            <input type="hidden" name="isActive" value={isActive ? 'yes' : 'no'} />

            <div>
              <label className="label" htmlFor="rule-label">
                Label
              </label>
              <input
                id="rule-label"
                name="label"
                className="input"
                required
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor="rule-base">
                Start from
              </label>
              <select
                id="rule-base"
                className="input"
                value={definition.base}
                onChange={(event) =>
                  setDefinition({ ...definition, base: event.target.value as DateRuleDefinition['base'] })
                }
              >
                {BASES.map((base) => (
                  <option key={base.value} value={base.value}>
                    {base.label}
                  </option>
                ))}
              </select>
            </div>

            <StepRows
              legend="Steps"
              steps={definition.steps}
              onChange={(steps) => setDefinition({ ...definition, steps })}
            />

            {definition.branches.length > 0 ? (
              <div className="rounded border border-slate-200 p-3">
                <p className="label">Conditional variations</p>
                <p className="field-note mb-2">
                  Applied instead of the steps above when the named fact is answered that way. The condition itself is
                  fixed in code, because a fact needs a question a reviewer can answer — the steps and the wording are
                  yours.
                </p>

                {definition.branches.map((branch, index) => (
                  <div key={branch.whenFact} className="mb-3 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
                    <p className="text-sm font-medium">
                      When <span className="font-mono text-xs">{branch.whenFact}</span> is{' '}
                      {branch.whenValue ? 'yes' : 'no'}
                    </p>

                    <StepRows
                      legend={`Steps when ${branch.whenFact} is ${branch.whenValue ? 'yes' : 'no'}`}
                      steps={branch.steps}
                      onChange={(steps) => {
                        const branches = [...definition.branches];
                        branches[index] = { ...branch, steps };
                        setDefinition({ ...definition, branches });
                      }}
                    />

                    <label className="label mt-2" htmlFor={`branch-assumption-${index}`}>
                      What a reviewer is told when this applies
                    </label>
                    <textarea
                      id={`branch-assumption-${index}`}
                      className="input"
                      rows={2}
                      value={branch.assumption}
                      onChange={(event) => {
                        const branches = [...definition.branches];
                        branches[index] = { ...branch, assumption: event.target.value };
                        setDefinition({ ...definition, branches });
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            <div>
              <label className="label" htmlFor="rule-assumption">
                What a reviewer is told about this date
              </label>
              <textarea
                id="rule-assumption"
                className="input"
                rows={2}
                value={definition.assumption ?? ''}
                onChange={(event) => setDefinition({ ...definition, assumption: event.target.value })}
              />
              <p className="field-note">Recorded against every date this rule produces.</p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={definition.rollToBusinessDay}
                onChange={(event) => setDefinition({ ...definition, rollToBusinessDay: event.target.checked })}
              />
              Roll forward to the next business day when it lands on a weekend or holiday
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={definition.requiresConfirmation}
                onChange={(event) => setDefinition({ ...definition, requiresConfirmation: event.target.checked })}
              />
              A reviewer must confirm each date this produces
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
              Active — an inactive rule produces no dates at all
            </label>

            <div>
              <label className="label" htmlFor="rule-notes">
                Notes
              </label>
              <textarea
                id="rule-notes"
                name="notes"
                className="input"
                rows={3}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
              <p className="field-note">Internal. Never printed in a client document.</p>
            </div>

            <div>
              <label className="label" htmlFor="rule-reason">
                Why are you changing this?
              </label>
              <textarea id="rule-reason" name="reason" className="input" rows={2} required minLength={10} />
              <p className="field-note">
                Recorded in the audit trail with the whole definition, before and after. This is a change to the firm&rsquo;s
                interpretation of a deadline.
              </p>
            </div>
          </ActionForm>
        </div>
      </div>

      <div>
        <section className="card mb-4">
          <div className="card-header">
            <h2 className="text-base font-semibold text-slate-900">Preview</h2>
            <p className="mt-1 text-sm text-slate-600">
              Computed by the same rule engine the worker uses, as you type.
            </p>
          </div>
          <div className="card-body">
            <label className="label" htmlFor="sample-year-end">
              Sample year-end
            </label>
            <input
              id="sample-year-end"
              type="date"
              className="input"
              value={sampleYearEnd}
              onChange={(event) => setSampleYearEnd(event.target.value)}
            />

            {definition.requiredFacts.map((fact) => (
              <label key={fact} className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={sampleFacts[fact] ?? false}
                  onChange={(event) => setSampleFacts({ ...sampleFacts, [fact]: event.target.checked })}
                />
                <span className="font-mono text-xs">{fact}</span>
              </label>
            ))}

            <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
              {preview.isBlocked ? (
                <p className="text-sm text-amber-800">{preview.blockedReason}</p>
              ) : (
                <p className="text-lg font-semibold text-slate-900">{preview.resultIso}</p>
              )}

              {preview.assumptions.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
                  {preview.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            <ol className="mt-3 space-y-1 text-xs text-slate-600">
              <li>Start from {BASES.find((base) => base.value === definition.base)?.label.toLowerCase()}</li>
              {definition.steps.map((step, index) => (
                <li key={`summary-${index}`}>{describeStep(step)}</li>
              ))}
            </ol>
          </div>
        </section>
      </div>
    </div>
  );
}
