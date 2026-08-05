'use client';

import { useActionState, useState, type ReactNode } from 'react';
import type { BulkPreviewRow } from '@element/services';
import { runBulkRollout, type ActionResult } from '@/app/actions';

/**
 * The rollout selection table.
 *
 * A rollout is the only action here that touches many clients at once, so the
 * control says exactly how many drafts it will produce, asks for confirmation
 * naming that number, and offers a dry run first. A blocked row cannot be
 * selected — and the server re-checks anyway, because a disabled checkbox is a
 * courtesy, not a control.
 */

const INITIAL: ActionResult | null = null;

export function RolloutSelection({
  csrfToken,
  batchId,
  rows,
  canGenerate,
}: {
  csrfToken: string;
  batchId: string;
  rows: BulkPreviewRow[];
  canGenerate: boolean;
}): ReactNode {
  const selectable = rows.filter((row) => !row.blocked);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectable.filter((row) => row.included).map((row) => row.engagementId)),
  );
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => runBulkRollout(formData),
    INITIAL,
  );

  function toggle(engagementId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(engagementId)) next.delete(engagementId);
      else next.add(engagementId);
      return next;
    });
  }

  const count = selected.size;

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        // A dry run changes nothing, so it needs no confirmation. The real one
        // touches many clients at once and says how many before it does.
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === 'yes') return;

        const question =
          `Generate ${count} draft${count === 1 ? '' : 's'}? ` +
          'Nothing is sent to Adobe Sign, and each draft still needs individual review and approval.';
        if (!window.confirm(question)) event.preventDefault();
      }}
    >
      <input type="hidden" name="csrf" value={csrfToken} />
      {/* Carried from the preview so submitting the same page twice is a no-op. */}
      <input type="hidden" name="batchId" value={batchId} />
      {[...selected].map((engagementId) => (
        <input key={engagementId} type="hidden" name="engagementId" value={engagementId} />
      ))}

      <div className="card mb-4">
        <div className="card-body flex flex-wrap items-center gap-3">
          {/*
            Two submit buttons rather than a mode toggle. The dry run is a
            separate deliberate act, and the value travels with the submission
            instead of living in state a form reset could desynchronise.
          */}
          <button
            type="submit"
            name="dryRun"
            value="yes"
            className="btn-secondary"
            disabled={pending || count === 0 || !canGenerate}
          >
            Dry run for {count} engagement{count === 1 ? '' : 's'}
          </button>

          <button type="submit" className="btn-primary" disabled={pending || count === 0 || !canGenerate}>
            {pending ? 'Working…' : `Generate ${count} draft${count === 1 ? '' : 's'}`}
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={() => setSelected(new Set(selectable.map((row) => row.engagementId)))}
            disabled={selectable.length === 0}
          >
            Select all ready ({selectable.length})
          </button>

          <button type="button" className="btn-secondary" onClick={() => setSelected(new Set())} disabled={count === 0}>
            Clear
          </button>

          {!canGenerate ? (
            <span className="text-xs text-slate-500">Your role does not permit starting generation.</span>
          ) : null}
        </div>

        {state ? (
          <div
            role="status"
            aria-live="polite"
            className={
              state.ok
                ? 'border-t border-emerald-200 bg-emerald-50 px-5 py-3 text-sm text-emerald-800'
                : 'border-t border-red-200 bg-red-50 px-5 py-3 text-sm text-red-800'
            }
          >
            <p>{state.message}</p>
            {state.blockers && state.blockers.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {state.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <caption className="sr-only">Bulk rollout preview</caption>
          <thead>
            <tr>
              <th scope="col">Include</th>
              <th scope="col">Client</th>
              <th scope="col">Type</th>
              <th scope="col">Prior-year document</th>
              <th scope="col">Prior fee</th>
              <th scope="col">Method</th>
              <th scope="col">Unrounded</th>
              <th scope="col">Rounded</th>
              <th scope="col">Compilation</th>
              <th scope="col">Missing / warnings</th>
              <th scope="col">Reviewer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.engagementId}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(row.engagementId)}
                    disabled={row.blocked}
                    onChange={() => toggle(row.engagementId)}
                    aria-label={`Include ${row.clientName}`}
                  />
                </td>
                <td className="font-medium">{row.clientName}</td>
                <td>{row.engagementType}</td>
                <td className="text-xs">{row.priorYearDocument ?? '—'}</td>
                <td>{row.priorYearFee ? `$${Number(row.priorYearFee).toFixed(2)}` : '—'}</td>
                <td className="text-xs">{row.increaseMethod.replace(/_/g, ' ').toLowerCase()}</td>
                <td>{row.proposedUnroundedFee ? `$${row.proposedUnroundedFee}` : '—'}</td>
                <td className="font-semibold">{row.proposedRoundedFee ? `$${row.proposedRoundedFee}` : '—'}</td>
                <td>{row.compilationSelected === null ? 'unconfirmed' : row.compilationSelected ? 'yes' : 'no'}</td>
                <td className="max-w-sm text-xs">
                  {row.blockedReason ? <p className="text-red-700">{row.blockedReason}</p> : null}
                  {row.missingFields.length > 0 ? (
                    <p className="text-red-700">Missing: {row.missingFields.join(', ')}</p>
                  ) : null}
                  {row.warnings.map((warning) => (
                    <p key={warning} className="text-amber-700">
                      {warning}
                    </p>
                  ))}
                </td>
                <td className="text-xs">{row.assignedReviewer ?? 'Unassigned'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </form>
  );
}
