'use client';

import { useState, type ReactNode } from 'react';
import { ActionForm } from '@/components/action-form';
import type { DocumentVersionLinks } from '@/lib/document-links';
import {
  addComment,
  approveDocument,
  approveFee,
  approveWordingException,
  confirmCompilationSelection,
  confirmDate,
  confirmDateFact,
  confirmServiceSelection,
  generateCoverLetter,
  markReadyToSend,
  overrideFee,
  prepareEngagement,
  requestChanges,
  resolveConflict,
  sendForSignature,
  startGeneration,
  startReview,
  submitWordingException,
  updateStructuredField,
} from '@/app/actions';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The fifteen-tab review workspace.
 *
 * Structured editing is the default. Wording edits live behind their own tab
 * because they are exceptional: they need a reason and partner approval, and
 * they never modify the master template.
 */

const TABS = [
  'Overview',
  'Source Documents',
  'Client Information',
  'Dates and Deadlines',
  'Services',
  'Pricing',
  'Previous-Year Comparison',
  'Master-Template Comparison',
  'Document Preview',
  'Signers',
  'Approvals',
  'Karbon Activity',
  'Adobe Sign',
  'Version History',
  'Audit History',
] as const;

type Tab = (typeof TABS)[number];

/** A fact a date rule depends on, with the answer recorded so far. */
export interface DateFactPrompt {
  key: string;
  question: string;
  help: string;
  answer: boolean | null;
}

export function ReviewWorkspace({
  csrfToken,
  engagement,
  auditEvents,
  templateVersion,
  documentLinks,
  dateFacts,
  generationGate,
}: {
  csrfToken: string;
  engagement: any;
  auditEvents: any[];
  templateVersion: any;
  documentLinks: Record<string, DocumentVersionLinks>;
  dateFacts: DateFactPrompt[];
  generationGate: { ok: boolean; blockers: string[]; warnings: string[] };
}): ReactNode {
  const [tab, setTab] = useState<Tab>('Overview');

  return (
    <div>
      <div role="tablist" aria-label="Engagement review" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            type="button"
            id={`tab-${name.replace(/\s+/g, '-')}`}
            aria-selected={tab === name}
            aria-controls={`panel-${name.replace(/\s+/g, '-')}`}
            onClick={() => setTab(name)}
            className={
              tab === name
                ? 'border-b-2 border-brand-600 px-3 py-2 text-sm font-semibold text-brand-700'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900'
            }
          >
            {name}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab.replace(/\s+/g, '-')}`}
        aria-labelledby={`tab-${tab.replace(/\s+/g, '-')}`}
      >
        {tab === 'Overview' ? (
          <Overview csrfToken={csrfToken} engagement={engagement} generationGate={generationGate} />
        ) : null}
        {tab === 'Source Documents' ? <SourceDocuments engagement={engagement} /> : null}
        {tab === 'Client Information' ? <ClientInformation csrfToken={csrfToken} engagement={engagement} /> : null}
        {tab === 'Dates and Deadlines' ? (
          <Dates csrfToken={csrfToken} engagement={engagement} dateFacts={dateFacts} />
        ) : null}
        {tab === 'Services' ? <Services csrfToken={csrfToken} engagement={engagement} /> : null}
        {tab === 'Pricing' ? <Pricing csrfToken={csrfToken} engagement={engagement} /> : null}
        {tab === 'Previous-Year Comparison' ? <PreviousYear engagement={engagement} /> : null}
        {tab === 'Master-Template Comparison' ? (
          <MasterTemplate csrfToken={csrfToken} engagement={engagement} templateVersion={templateVersion} />
        ) : null}
        {tab === 'Document Preview' ? <Preview engagement={engagement} documentLinks={documentLinks} /> : null}
        {tab === 'Signers' ? <Signers engagement={engagement} /> : null}
        {tab === 'Approvals' ? <Approvals csrfToken={csrfToken} engagement={engagement} /> : null}
        {tab === 'Karbon Activity' ? <KarbonActivity engagement={engagement} /> : null}
        {tab === 'Adobe Sign' ? <AdobeSign csrfToken={csrfToken} engagement={engagement} /> : null}
        {tab === 'Version History' ? <Versions engagement={engagement} documentLinks={documentLinks} /> : null}
        {tab === 'Audit History' ? <AuditHistory auditEvents={auditEvents} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Card({ title, children, description }: { title: string; children: ReactNode; description?: string }): ReactNode {
  return (
    <section className="card mb-4">
      <div className="card-header">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

function Empty({ message }: { message: string }): ReactNode {
  return <p className="text-sm text-slate-500">{message}</p>;
}

function Overview({
  csrfToken,
  engagement,
  generationGate,
}: {
  csrfToken: string;
  engagement: any;
  generationGate: { ok: boolean; blockers: string[]; warnings: string[] };
}): ReactNode {
  const latest = engagement.documentVersions?.[0];
  const needsCompilationConfirmation = engagement.engagementType === 'T2' && engagement.compilationSelected === null;

  return (
    <>
      {needsCompilationConfirmation ? (
        <Card
          title="Confirm CSRS 4200 compilation services"
          description="The prior year's selection is only a suggestion. A reviewer must confirm the selection for the new year before the letter can be generated — section 3A is kept or removed entirely based on this answer."
        >
          <ActionForm action={confirmCompilationSelection} csrfToken={csrfToken} submitLabel="Confirm selection">
            <input type="hidden" name="engagementId" value={engagement.id} />
            <fieldset>
              <legend className="label">Are CSRS 4200 compilation services included this year?</legend>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="radio" name="selected" value="yes" required /> Yes, include section 3A and the compilation
                particulars
              </label>
              <label className="mt-1 flex items-center gap-2 text-sm">
                <input type="radio" name="selected" value="no" /> No, remove section 3A entirely
              </label>
            </fieldset>
          </ActionForm>
        </Card>
      ) : null}

      <Card title="Readiness">
        {generationGate.ok ? (
          <p className="text-sm text-emerald-700">Everything required to generate this document is in place.</p>
        ) : (
          <>
            <p className="text-sm text-slate-700">Generation is blocked until these are resolved:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700">
              {generationGate.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </>
        )}
        {generationGate.warnings.length > 0 ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-700">
            {generationGate.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title="Actions">
        <div className="grid gap-6 lg:grid-cols-2">
          <ActionForm action={prepareEngagement} csrfToken={csrfToken} submitLabel="Prepare" variant="secondary">
            <input type="hidden" name="engagementId" value={engagement.id} />
            <p className="text-sm text-slate-600">
              Records the current Karbon information, raises a conflict wherever it disagrees with the prior-year
              letter, seeds the service selections, calculates the fees and evaluates the deadline rules. Nothing you
              have already confirmed is overwritten, so this is safe to re-run.
            </p>
          </ActionForm>

          <ActionForm
            action={startGeneration}
            csrfToken={csrfToken}
            submitLabel="Generate draft"
            disabled={!generationGate.ok}
            disabledReason={generationGate.ok ? undefined : 'Resolve the blockers above first.'}
          >
            <input type="hidden" name="engagementId" value={engagement.id} />
            <p className="text-sm text-slate-600">
              Generates a new version from the approved master template. An existing draft is superseded, never
              overwritten.
            </p>
          </ActionForm>

          <ActionForm action={startReview} csrfToken={csrfToken} submitLabel="Start review" variant="secondary">
            <input type="hidden" name="engagementId" value={engagement.id} />
            <p className="text-sm text-slate-600">Moves the engagement into review and assigns it to you.</p>
          </ActionForm>
        </div>
      </Card>

      <Card title="Assignment">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">Preparer</dt>
            <dd className="font-medium">{engagement.preparer?.displayName ?? 'Unassigned'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Reviewer</dt>
            <dd className="font-medium">{engagement.reviewer?.displayName ?? 'Unassigned'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Final approver</dt>
            <dd className="font-medium">{engagement.finalApprover?.displayName ?? 'Unassigned'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Karbon work item</dt>
            <dd className="font-medium">{engagement.karbonWorkItem?.karbonKey ?? 'Not linked'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Latest version</dt>
            <dd className="font-medium">{latest ? `v${latest.versionNumber} (${latest.status})` : 'None yet'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Test mode engagement</dt>
            <dd className="font-medium">{engagement.isTestMode ? 'Yes' : 'No'}</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}

function SourceDocuments({ engagement }: { engagement: any }): ReactNode {
  return (
    <Card
      title="Source documents"
      description="A document is never trusted because of its filename. Each candidate is scored against the client, engagement type and year."
    >
      {engagement.sourceDocuments.length === 0 ? (
        <Empty message="No source documents have been located yet." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Kind</th>
              <th scope="col">Verification</th>
              <th scope="col">Confirmed</th>
              <th scope="col">In package</th>
            </tr>
          </thead>
          <tbody>
            {engagement.sourceDocuments.map((document: any) => (
              <tr key={document.id}>
                <td>{document.fileName}</td>
                <td>{document.kind.replace(/_/g, ' ').toLowerCase()}</td>
                <td>
                  {document.verificationScore === null
                    ? '—'
                    : `${Math.round(document.verificationScore * 100)}%`}
                  {document.verificationDetail?.disqualifiers?.length ? (
                    <ul className="mt-1 list-disc pl-4 text-xs text-red-700">
                      {document.verificationDetail.disqualifiers.map((reason: string) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td>{document.confirmedAt ? 'Yes' : 'No'}</td>
                <td>{document.includedInPackage ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ClientInformation({ csrfToken, engagement }: { csrfToken: string; engagement: any }): ReactNode {
  const unresolved = engagement.fieldConflicts.filter((conflict: any) => conflict.status === 'UNRESOLVED');

  return (
    <>
      {unresolved.length > 0 ? (
        <Card
          title="Conflicting values"
          description="Current Karbon information disagrees with the prior-year document. The current Karbon value is recommended, but a reviewer must confirm which is correct."
        >
          {unresolved.map((conflict: any) => (
            <div key={conflict.id} className="mb-4 rounded border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium">{conflict.token}</p>
              <ActionForm action={resolveConflict} csrfToken={csrfToken} submitLabel="Use this value">
                <input type="hidden" name="conflictId" value={conflict.id} />
                {(conflict.candidates ?? []).map((candidate: any) => (
                  <label key={`${candidate.source}-${candidate.value}`} className="mt-1 flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="chosenValue"
                      value={candidate.value}
                      defaultChecked={candidate.source === conflict.recommendedSource}
                      required
                    />
                    <span>
                      {candidate.value}
                      <span className="ml-2 text-xs text-slate-500">
                        from {candidate.source.replace(/_/g, ' ').toLowerCase()}
                        {candidate.source === conflict.recommendedSource ? ' (recommended)' : ''}
                      </span>
                    </span>
                    <input type="hidden" name="chosenSource" value={candidate.source} />
                  </label>
                ))}
              </ActionForm>
            </div>
          ))}
        </Card>
      ) : null}

      <Card
        title="Extracted values"
        description="Each value shows where it came from, how it was extracted and how confident that extraction was."
      >
        {engagement.extractedFields.length === 0 ? (
          <Empty message="No values have been extracted yet." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Value</th>
                <th scope="col">Source</th>
                <th scope="col">Method</th>
                <th scope="col">Confidence</th>
                <th scope="col">Evidence</th>
                <th scope="col">Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {engagement.extractedFields.map((field: any) => (
                <tr key={field.id}>
                  <td className="font-mono text-xs">{field.token}</td>
                  <td>{field.manualOverrideValue ?? field.value ?? '—'}</td>
                  <td>{field.source.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>{field.extractionMethod.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>{field.confidence === null ? '—' : `${Math.round(field.confidence * 100)}%`}</td>
                  <td className="max-w-xs">
                    {field.evidence?.length ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-brand-700">
                          {field.evidence.length} source citation(s)
                        </summary>
                        <ul className="mt-1 space-y-1 text-xs text-slate-600">
                          {field.evidence.map((item: any) => (
                            <li key={item.id}>
                              {item.pageNumber ? `Page ${item.pageNumber}: ` : ''}
                              {item.supportingText ?? 'No excerpt recorded'}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{field.manuallyConfirmed ? (field.confirmedBy?.displayName ?? 'Yes') : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Edit a structured field" description="Structured editing is available to any reviewer.">
        <ActionForm action={updateStructuredField} csrfToken={csrfToken} submitLabel="Save value">
          <input type="hidden" name="engagementId" value={engagement.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="field-token">
                Field token
              </label>
              <input id="field-token" name="token" className="input" required placeholder="corporation.legal_name" />
            </div>
            <div>
              <label className="label" htmlFor="field-value">
                Value
              </label>
              <input id="field-value" name="value" className="input" />
            </div>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}

function Dates({
  csrfToken,
  engagement,
  dateFacts,
}: {
  csrfToken: string;
  engagement: any;
  dateFacts: DateFactPrompt[];
}): ReactNode {
  const unanswered = dateFacts.filter((fact) => fact.answer === null);

  return (
    <>
      {dateFacts.length > 0 ? (
        <Card
          title="Information the deadlines depend on"
          description={
            unanswered.length > 0
              ? 'These deadlines stay blocked until each question is answered. The application will not assume the common case — a wrong legal deadline in a signed letter is not recoverable.'
              : 'Every fact these deadlines depend on has been answered. Change an answer to recalculate.'
          }
        >
          {dateFacts.map((fact) => (
            <div key={fact.key} className="mb-4 rounded border border-slate-200 p-3 last:mb-0">
              <p className="text-sm font-medium text-slate-900">{fact.question}</p>
              <p className="mt-1 text-xs text-slate-600">{fact.help}</p>
              <p className="mt-2 text-sm">
                Current answer:{' '}
                <strong>{fact.answer === null ? 'Not answered' : fact.answer ? 'Yes' : 'No'}</strong>
              </p>
              <ActionForm
                action={confirmDateFact}
                csrfToken={csrfToken}
                submitLabel={fact.answer === null ? 'Record answer' : 'Change answer'}
                variant="secondary"
              >
                <input type="hidden" name="engagementId" value={engagement.id} />
                <input type="hidden" name="factKey" value={fact.key} />
                <fieldset className="mt-1">
                  <legend className="sr-only">{fact.question}</legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="answer" value="yes" defaultChecked={fact.answer === true} required /> Yes
                  </label>
                  <label className="mt-1 flex items-center gap-2 text-sm">
                    <input type="radio" name="answer" value="no" defaultChecked={fact.answer === false} /> No
                  </label>
                </fieldset>
              </ActionForm>
            </div>
          ))}
        </Card>
      ) : null}

      <DateTable csrfToken={csrfToken} engagement={engagement} />
    </>
  );
}

function DateTable({ csrfToken, engagement }: { csrfToken: string; engagement: any }): ReactNode {
  return (
    <Card
      title="Dates and deadlines"
      description="Every date records the rule used, its input, its assumptions and who confirmed it. The application is not the final authority on a legal deadline — a reviewer confirms each one."
    >
      {engagement.calculatedDates.length === 0 ? (
        <Empty message="No dates have been calculated yet." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Result</th>
              <th scope="col">Rule</th>
              <th scope="col">Assumptions</th>
              <th scope="col">Confirmed</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {engagement.calculatedDates.map((date: any) => (
              <tr key={date.id}>
                <td className="font-mono text-xs">{date.token}</td>
                <td>
                  {date.manualOverride?.slice(0, 10) ?? date.result?.slice(0, 10) ?? '—'}
                  {date.isBlocked ? <p className="mt-1 text-xs text-red-700">{date.blockedReason}</p> : null}
                </td>
                <td className="text-xs">{date.ruleCode ?? date.dateRule?.code ?? '—'}</td>
                <td className="text-xs text-slate-600">
                  {(date.assumptions ?? []).length > 0 ? (date.assumptions as string[]).join(' ') : '—'}
                </td>
                <td>{date.confirmedAt ? (date.confirmedBy?.displayName ?? 'Yes') : 'No'}</td>
                <td>
                  {!date.confirmedAt && !date.isBlocked ? (
                    <ActionForm action={confirmDate} csrfToken={csrfToken} submitLabel="Confirm" variant="secondary">
                      <input type="hidden" name="calculatedDateId" value={date.id} />
                    </ActionForm>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Services({ csrfToken, engagement }: { csrfToken: string; engagement: any }): ReactNode {
  return (
    <>
      <Card
        title="Selected services"
        description="Last year's selection is carried forward as a suggestion only. Each service is confirmed for the new year before the letter can be generated."
      >
        {engagement.serviceSelections.length === 0 ? (
          <Empty message="No services have been recorded yet. Run Prepare on the Overview tab." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">This year</th>
                <th scope="col">Last year</th>
                <th scope="col">Confirmed</th>
                <th scope="col">Set for this year</th>
              </tr>
            </thead>
            <tbody>
              {engagement.serviceSelections.map((service: any) => (
                <tr key={service.id}>
                  <td>{service.label}</td>
                  <td>{service.isSelected ? 'Included' : 'Not included'}</td>
                  <td>
                    {service.priorYearSelected === null
                      ? '—'
                      : service.priorYearSelected
                        ? 'Included (suggestion only)'
                        : 'Not included'}
                  </td>
                  <td>{service.confirmed ? 'Yes' : <span className="text-amber-700">No</span>}</td>
                  <td>
                    <div className="flex gap-2">
                      <ActionForm
                        action={confirmServiceSelection}
                        csrfToken={csrfToken}
                        submitLabel="Include"
                        variant="secondary"
                      >
                        <input type="hidden" name="engagementId" value={engagement.id} />
                        <input type="hidden" name="serviceCode" value={service.serviceCode} />
                        <input type="hidden" name="selected" value="yes" />
                      </ActionForm>
                      <ActionForm
                        action={confirmServiceSelection}
                        csrfToken={csrfToken}
                        submitLabel="Exclude"
                        variant="secondary"
                      >
                        <input type="hidden" name="engagementId" value={engagement.id} />
                        <input type="hidden" name="serviceCode" value={service.serviceCode} />
                        <input type="hidden" name="selected" value="no" />
                      </ActionForm>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {engagement.engagementType === 'T2' ? (
        <Card
          title="CSRS 4200 compilation"
          description="Section 3A and the Schedule A compilation particulars are included or removed entirely based on this confirmed selection."
        >
          <p className="mb-3 text-sm">
            Current selection:{' '}
            <strong>
              {engagement.compilationSelected === null
                ? 'Not yet confirmed'
                : engagement.compilationSelected
                  ? 'Included'
                  : 'Not included'}
            </strong>
          </p>
          <ActionForm action={confirmCompilationSelection} csrfToken={csrfToken} submitLabel="Update selection">
            <input type="hidden" name="engagementId" value={engagement.id} />
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="selected" value="yes" required /> Included
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="selected" value="no" /> Not included
            </label>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}

function Pricing({ csrfToken, engagement }: { csrfToken: string; engagement: any }): ReactNode {
  return (
    <>
      <Card
        title="Fee derivation"
        description="Fees are quoted before GST. Every calculated fee is rounded upward to the next $5."
      >
        {engagement.feeCalculations.length === 0 ? (
          <Empty message="No fees have been calculated yet." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Fee</th>
                <th scope="col">Previous</th>
                <th scope="col">Method</th>
                <th scope="col">Unrounded</th>
                <th scope="col">Rounded</th>
                <th scope="col">Increase</th>
                <th scope="col">Approval</th>
              </tr>
            </thead>
            <tbody>
              {engagement.feeCalculations.map((fee: any) => (
                <tr key={fee.id}>
                  <td>{fee.feeKind.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>
                    {fee.previousFee ? `$${Number(fee.previousFee).toFixed(2)}` : '—'}
                    {fee.previousFeeSource ? (
                      <p className="text-xs text-slate-500">{fee.previousFeeSource.replace(/_/g, ' ').toLowerCase()}</p>
                    ) : null}
                  </td>
                  <td>
                    {fee.method.replace(/_/g, ' ').toLowerCase()}
                    {fee.percentage ? ` ${Number(fee.percentage)}%` : ''}
                    {fee.fixedAmount ? ` $${Number(fee.fixedAmount).toFixed(2)}` : ''}
                  </td>
                  <td>{fee.unroundedFee ? `$${Number(fee.unroundedFee).toFixed(2)}` : '—'}</td>
                  <td className="font-semibold">{fee.roundedFee ? `$${Number(fee.roundedFee).toFixed(2)}` : '—'}</td>
                  <td>
                    {fee.increaseAmount ? `$${Number(fee.increaseAmount).toFixed(2)}` : '—'}
                    {fee.effectivePercentage ? (
                      <p className="text-xs text-slate-500">{Number(fee.effectivePercentage).toFixed(2)}% effective</p>
                    ) : null}
                  </td>
                  <td>
                    {fee.isBlocked ? <span className="text-xs text-red-700">{fee.blockedReason}</span> : null}
                    {fee.requiresApprovalType && !fee.approvedAt ? (
                      <ActionForm action={approveFee} csrfToken={csrfToken} submitLabel="Approve" variant="secondary">
                        <input type="hidden" name="engagementId" value={engagement.id} />
                        <input type="hidden" name="feeKind" value={fee.feeKind} />
                        <span className="text-xs text-amber-700">{fee.requiresApprovalType.replace(/_/g, ' ')}</span>
                      </ActionForm>
                    ) : fee.approvedAt ? (
                      <span className="text-xs text-emerald-700">Approved</span>
                    ) : (
                      <span className="text-xs text-slate-500">Not required</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {engagement.feeCalculations.some((fee: any) => (fee.warnings ?? []).length > 0) ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-700">
            {engagement.feeCalculations.flatMap((fee: any) =>
              (fee.warnings ?? []).map((warning: any) => <li key={`${fee.id}-${warning.code}`}>{warning.message}</li>),
            )}
          </ul>
        ) : null}
      </Card>

      <Card title="Override a fee" description="An override needs a written reason. A decrease or a large increase also needs partner approval.">
        <ActionForm action={overrideFee} csrfToken={csrfToken} submitLabel="Apply override">
          <input type="hidden" name="engagementId" value={engagement.id} />
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="fee-kind">
                Fee
              </label>
              <select id="fee-kind" name="feeKind" className="input" required>
                <option value="T2_PREPARATION">T2 preparation</option>
                <option value="CSRS_4200_COMPILATION">CSRS 4200 compilation</option>
                <option value="T1_PREPARATION">T1 preparation</option>
                <option value="T3_PREPARATION">T3 preparation</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="fee-amount">
                Amount before GST
              </label>
              <input id="fee-amount" name="amount" className="input" inputMode="decimal" required />
              <p className="field-note">Rounded upward to the next $5.</p>
            </div>
            <div>
              <label className="label" htmlFor="fee-reason">
                Reason
              </label>
              <input id="fee-reason" name="reason" className="input" required />
            </div>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}

function PreviousYear({ engagement }: { engagement: any }): ReactNode {
  const priorYearValues = engagement.extractedFields.filter((field: any) => field.source === 'PRIOR_YEAR_DOCUMENT');

  return (
    <Card
      title="Previous-year comparison"
      description="Values taken from the prior-year letter, alongside the value proposed for this year. Prior-year custom legal wording is never carried forward automatically."
    >
      {priorYearValues.length === 0 ? (
        <Empty message="No prior-year values have been extracted." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Prior year</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {priorYearValues.map((field: any) => (
              <tr key={field.id}>
                <td className="font-mono text-xs">{field.token}</td>
                <td>{field.value ?? '—'}</td>
                <td className="text-xs text-slate-600">
                  {field.evidence?.[0]?.supportingText ?? 'No excerpt recorded'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function MasterTemplate({
  csrfToken,
  engagement,
  templateVersion,
}: {
  csrfToken: string;
  engagement: any;
  templateVersion: any;
}): ReactNode {
  const latest = engagement.documentVersions?.[0];

  return (
    <>
      <Card
        title="Approved master template"
        description="The current approved master template controls all standard legal wording. Every paragraph is locked by default."
      >
        {templateVersion ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Source file</dt>
              <dd className="font-medium">{templateVersion.sourceFileName}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Version</dt>
              <dd className="font-medium">v{templateVersion.versionNumber} ({templateVersion.status})</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-500">Source hash</dt>
              <dd className="break-all font-mono text-xs">{templateVersion.sourceFileHash}</dd>
            </div>
          </dl>
        ) : (
          <Empty message="No template version is linked to this engagement yet." />
        )}
      </Card>

      <Card title="Wording changes awaiting approval">
        {engagement.wordingExceptions.length === 0 ? (
          <Empty message="No wording changes have been requested." />
        ) : (
          engagement.wordingExceptions.map((exception: any) => (
            <div key={exception.id} className="mb-4 rounded border border-slate-200 p-3">
              <p className="text-sm font-medium">{exception.sectionAnchor}</p>
              <p className="mt-1 text-xs text-slate-500">
                Requested by {exception.author?.displayName} — {exception.reason}
              </p>
              <div className="mt-2 grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold text-slate-500">Approved wording</p>
                  <p className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{exception.originalWording}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-500">Proposed wording</p>
                  <p className="mt-1 whitespace-pre-wrap rounded bg-amber-50 p-2 text-xs">{exception.revisedWording}</p>
                </div>
              </div>
              {exception.approvedAt ? (
                <p className="mt-2 text-xs text-emerald-700">Approved by {exception.approver?.displayName}</p>
              ) : (
                <div className="mt-2">
                  <ActionForm
                    action={approveWordingException}
                    csrfToken={csrfToken}
                    submitLabel="Approve wording change"
                    variant="secondary"
                  >
                    <input type="hidden" name="exceptionId" value={exception.id} />
                    <input type="hidden" name="engagementId" value={engagement.id} />
                  </ActionForm>
                </div>
              )}
            </div>
          ))
        )}
      </Card>

      <Card
        title="Request an exceptional wording change"
        description="Applies to this document version only. It never modifies the master template, and it requires partner approval."
      >
        <ActionForm action={submitWordingException} csrfToken={csrfToken} submitLabel="Submit for partner approval">
          <input type="hidden" name="engagementId" value={engagement.id} />
          <input type="hidden" name="documentVersionId" value={latest?.id ?? ''} />
          <div>
            <label className="label" htmlFor="section-anchor">
              Section
            </label>
            <input id="section-anchor" name="sectionAnchor" className="input" required />
          </div>
          <div>
            <label className="label" htmlFor="original-wording">
              Approved wording
            </label>
            <textarea id="original-wording" name="originalWording" className="input" rows={3} required />
          </div>
          <div>
            <label className="label" htmlFor="revised-wording">
              Revised wording
            </label>
            <textarea id="revised-wording" name="revisedWording" className="input" rows={3} required />
          </div>
          <div>
            <label className="label" htmlFor="wording-reason">
              Reason
            </label>
            <input id="wording-reason" name="reason" className="input" required />
          </div>
        </ActionForm>
      </Card>
    </>
  );
}

function Preview({
  engagement,
  documentLinks,
}: {
  engagement: any;
  documentLinks: Record<string, DocumentVersionLinks>;
}): ReactNode {
  const latest = engagement.documentVersions?.[0];
  const links = latest ? documentLinks[latest.id] : undefined;

  return (
    <Card title="Document preview">
      {!latest ? (
        <Empty message="No document has been generated yet." />
      ) : (
        <>
          <p className="text-sm text-slate-600">
            Version {latest.versionNumber} · {latest.pageCount ?? '?'} pages · status {latest.status}
          </p>

          <div className="mt-3 flex flex-wrap gap-3">
            {links?.pdf ? (
              <a className="btn-secondary" href={links.pdf.url} target="_blank" rel="noreferrer">
                Open PDF in a new tab
              </a>
            ) : null}
            {links?.docx ? (
              <a className="btn-secondary" href={links.docx.url} download>
                Download Word working copy
              </a>
            ) : null}
          </div>

          {links?.pdf ? (
            <iframe
              title={`Engagement letter version ${latest.versionNumber}`}
              src={links.pdf.url}
              className="mt-3 h-[70vh] w-full rounded border border-slate-300 bg-slate-50"
            />
          ) : (
            <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              This version has no PDF working copy to display. It may not have been converted yet, or the temporary
              copy may have passed its retention period — regenerate it, or open the copy held in Karbon. Do not
              approve a version you cannot read.
            </p>
          )}

          {latest.validationReport ? (
            <div className="mt-3">
              <p className="text-sm font-medium">
                Validation: {latest.validationReport.errorCount} error(s), {latest.validationReport.warningCount}{' '}
                warning(s)
              </p>
              {(latest.validationReport.issues ?? []).length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {latest.validationReport.issues.map((issue: any, index: number) => (
                    <li key={`${issue.code}-${index}`} className={issue.severity === 'ERROR' ? 'text-red-700' : 'text-amber-700'}>
                      <strong>{issue.code}</strong>: {issue.message}
                      {issue.detail ? <span className="text-slate-600"> — {issue.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-emerald-700">
                  No unresolved placeholders, no internal checklist, no placeholder highlighting.
                </p>
              )}
            </div>
          ) : null}
          <p className="mt-4 text-xs text-slate-500">
            Word and PDF working copies are held in temporary storage and served through short-lived signed links.
            Karbon holds the authoritative copy.
          </p>
        </>
      )}
    </Card>
  );
}

function Signers({ engagement }: { engagement: any }): ReactNode {
  return (
    <Card
      title="Signers"
      description="Signers sharing an order sign in parallel. A firm signer signs after the client when one is required. A signature or signed date is never prefilled."
    >
      {engagement.participants.length === 0 ? (
        <Empty message="No participants have been recorded." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Order</th>
              <th scope="col">Signer</th>
              <th scope="col">Confirmed</th>
            </tr>
          </thead>
          <tbody>
            {engagement.participants.map((participant: any) => (
              <tr key={participant.id}>
                <td>{participant.role.replace(/_/g, ' ').toLowerCase()}</td>
                <td>{participant.fullLegalName}</td>
                <td>{participant.email ?? '—'}</td>
                <td>{participant.signingOrder}</td>
                <td>{participant.isSigner ? 'Yes' : 'No'}</td>
                <td>{participant.contactConfirmed ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Approvals({ csrfToken, engagement }: { csrfToken: string; engagement: any }): ReactNode {
  const latest = engagement.documentVersions?.[0];

  return (
    <>
      <Card title="Review decisions">
        <div className="grid gap-6 lg:grid-cols-2">
          <ActionForm action={requestChanges} csrfToken={csrfToken} submitLabel="Request changes" variant="secondary">
            <input type="hidden" name="engagementId" value={engagement.id} />
            <div>
              <label className="label" htmlFor="changes-reason">
                What needs to change?
              </label>
              <textarea id="changes-reason" name="reason" className="input" rows={3} required />
            </div>
          </ActionForm>

          <ActionForm
            action={approveDocument}
            csrfToken={csrfToken}
            submitLabel="Approve document"
            confirm="Approving records your name against this exact file. Continue?"
            disabled={!latest}
          >
            <input type="hidden" name="engagementId" value={engagement.id} />
            <input type="hidden" name="documentVersionId" value={latest?.id ?? ''} />
            <div>
              <label className="label" htmlFor="approval-comment">
                Comment (optional)
              </label>
              <input id="approval-comment" name="comment" className="input" />
            </div>
            <p className="text-xs text-slate-500">You cannot approve a draft you generated yourself.</p>
          </ActionForm>
        </div>
      </Card>

      <Card title="Approval history">
        {engagement.approvals.length === 0 ? (
          <Empty message="No approvals have been recorded." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Decision</th>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Document hash</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {engagement.approvals.map((approval: any) => (
                <tr key={approval.id}>
                  <td>{approval.type.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>{approval.decision.toLowerCase()}</td>
                  <td>{approval.user?.displayName}</td>
                  <td className="text-xs">{approval.actingRole}</td>
                  <td className="max-w-[10rem] truncate font-mono text-xs">{approval.documentHash ?? '—'}</td>
                  <td className="text-xs">{new Date(approval.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Reviewer comments">
        <ActionForm action={addComment} csrfToken={csrfToken} submitLabel="Add comment" variant="secondary">
          <input type="hidden" name="engagementId" value={engagement.id} />
          <input type="hidden" name="documentVersionId" value={latest?.id ?? ''} />
          <div>
            <label className="label" htmlFor="comment-body">
              Internal comment
            </label>
            <textarea id="comment-body" name="body" className="input" rows={2} required />
          </div>
        </ActionForm>

        <ul className="mt-4 space-y-2">
          {engagement.reviewComments.map((comment: any) => (
            <li key={comment.id} className="rounded border border-slate-200 p-2 text-sm">
              <p className="text-xs text-slate-500">
                {comment.user?.displayName} · {new Date(comment.createdAt).toISOString().slice(0, 16).replace('T', ' ')}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Cover letter">
        <ActionForm action={generateCoverLetter} csrfToken={csrfToken} submitLabel="Generate cover letter" variant="secondary">
          <input type="hidden" name="engagementId" value={engagement.id} />
          <p className="text-sm text-slate-600">
            Requires all final source documents, a completed internal approval, and the READY_FOR_COVER_LETTER status.
          </p>
        </ActionForm>
      </Card>
    </>
  );
}

function KarbonActivity({ engagement }: { engagement: any }): ReactNode {
  return (
    <Card title="Karbon activity" description="Every upload, note and task this application attempted, and what happened.">
      {engagement.karbonActivities.length === 0 ? (
        <Empty message="Nothing has been sent to Karbon yet." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Outcome</th>
              <th scope="col">Work item</th>
              <th scope="col">Karbon object</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {engagement.karbonActivities.map((activity: any) => (
              <tr key={activity.id}>
                <td>{activity.type.replace(/_/g, ' ').toLowerCase()}</td>
                <td className={activity.outcome === 'SUCCEEDED' ? 'text-emerald-700' : 'text-amber-700'}>
                  {activity.outcome.replace(/_/g, ' ').toLowerCase()}
                </td>
                <td className="font-mono text-xs">{activity.karbonWorkItemKey ?? '—'}</td>
                <td className="font-mono text-xs">{activity.karbonObjectId ?? '—'}</td>
                <td className="text-xs">{new Date(activity.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function AdobeSign({ csrfToken, engagement }: { csrfToken: string; engagement: any }): ReactNode {
  const latest = engagement.documentVersions?.[0];
  const approved = engagement.documentVersions?.find((version: any) => version.status === 'APPROVED');

  return (
    <>
      <Card title="Send for signature" description="Sending requires an approved PDF, confirmed signers and an explicit internal approval.">
        <div className="grid gap-6 lg:grid-cols-2">
          <ActionForm action={markReadyToSend} csrfToken={csrfToken} submitLabel="Authorise for sending" variant="secondary">
            <input type="hidden" name="engagementId" value={engagement.id} />
          </ActionForm>

          <ActionForm
            action={sendForSignature}
            csrfToken={csrfToken}
            submitLabel="Send for signature"
            confirm="This creates an Adobe Sign agreement. Continue?"
            disabled={!approved}
            disabledReason={approved ? undefined : 'An approved version is required.'}
          >
            <input type="hidden" name="engagementId" value={engagement.id} />
            <input type="hidden" name="documentVersionId" value={approved?.id ?? latest?.id ?? ''} />
          </ActionForm>
        </div>
      </Card>

      <Card title="Agreements">
        {engagement.adobeAgreements.length === 0 ? (
          <Empty message="No agreement has been created." />
        ) : (
          engagement.adobeAgreements.map((agreement: any) => (
            <div key={agreement.id} className="mb-4 rounded border border-slate-200 p-3">
              <p className="text-sm font-medium">
                {agreement.title} — {agreement.status.replace(/_/g, ' ').toLowerCase()}
                {agreement.isTestMode ? <span className="badge ml-2 bg-amber-100 text-amber-800">test</span> : null}
              </p>
              <p className="mt-1 font-mono text-xs text-slate-500">{agreement.agreementId ?? 'not yet created'}</p>

              <table className="table mt-2">
                <thead>
                  <tr>
                    <th scope="col">Signer</th>
                    <th scope="col">Order</th>
                    <th scope="col">Status</th>
                    <th scope="col">Signed</th>
                  </tr>
                </thead>
                <tbody>
                  {agreement.signers.map((signer: any) => (
                    <tr key={signer.id}>
                      <td>
                        {signer.name}
                        <p className="text-xs text-slate-500">{signer.email}</p>
                      </td>
                      <td>{signer.signingOrder}</td>
                      <td>{signer.status.replace(/_/g, ' ').toLowerCase()}</td>
                      <td className="text-xs">{signer.signedAt ? new Date(signer.signedAt).toISOString().slice(0, 10) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {agreement.declineReason ? (
                <p className="mt-2 text-sm text-red-700">Declined: {agreement.declineReason}</p>
              ) : null}

              <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Signed PDF in Karbon</dt>
                  <dd>{agreement.signedPdfKarbonDocumentId ?? 'Not yet uploaded'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Signing certificate in Karbon</dt>
                  <dd>{agreement.certificateKarbonDocumentId ?? 'Not yet uploaded'}</dd>
                </div>
              </dl>
            </div>
          ))
        )}
      </Card>
    </>
  );
}

function Versions({
  engagement,
  documentLinks,
}: {
  engagement: any;
  documentLinks: Record<string, DocumentVersionLinks>;
}): ReactNode {
  return (
    <Card title="Version history" description="Every saved edit creates a new version. Approved and signed versions are immutable.">
      {engagement.documentVersions.length === 0 ? (
        <Empty message="No versions have been generated." />
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Created by</th>
                <th scope="col">Approved by</th>
                <th scope="col">PDF hash</th>
                <th scope="col">Working copies</th>
              </tr>
            </thead>
            <tbody>
              {engagement.documentVersions.map((version: any) => {
                const links = documentLinks[version.id];
                return (
                  <tr key={version.id}>
                    <td>v{version.versionNumber}</td>
                    <td className="text-xs">{version.documentType.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>{version.status.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>{version.creator?.displayName ?? '—'}</td>
                    <td>{version.approver?.displayName ?? '—'}</td>
                    <td className="max-w-[10rem] truncate font-mono text-xs">{version.pdfHash ?? '—'}</td>
                    <td className="text-xs">
                      {links?.pdf ? (
                        <a className="text-brand-700 underline" href={links.pdf.url} target="_blank" rel="noreferrer">
                          PDF
                        </a>
                      ) : null}
                      {links?.pdf && links?.docx ? <span className="px-1 text-slate-400">·</span> : null}
                      {links?.docx ? (
                        <a className="text-brand-700 underline" href={links.docx.url} download>
                          Word
                        </a>
                      ) : null}
                      {!links?.pdf && !links?.docx ? 'Expired' : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-slate-500">
            Working copies are temporary and expire; Karbon holds the authoritative copy. Links are signed and valid
            for fifteen minutes.
          </p>
        </>
      )}
    </Card>
  );
}

function AuditHistory({ auditEvents }: { auditEvents: any[] }): ReactNode {
  return (
    <Card title="Audit history" description="Immutable. The database rejects any attempt to update or delete an audit event.">
      {auditEvents.length === 0 ? (
        <Empty message="No audit events recorded." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Object</th>
              <th scope="col">User</th>
              <th scope="col">Reason</th>
              <th scope="col">Correlation</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {auditEvents.map((event) => (
              <tr key={event.id}>
                <td className="text-xs font-medium">{event.eventType}</td>
                <td className="text-xs">{event.objectType}</td>
                <td className="text-xs">{event.userDisplayName ?? 'system'}</td>
                <td className="max-w-xs text-xs">{event.reason ?? '—'}</td>
                <td className="max-w-[8rem] truncate font-mono text-xs">{event.correlationId ?? '—'}</td>
                <td className="text-xs">{new Date(event.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
