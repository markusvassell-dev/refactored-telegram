import { can } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';
import { RolloutSelection } from './selection';

export const dynamic = 'force-dynamic';

export default async function BulkRolloutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const params = await searchParams;

  const taxYear = Number(params.taxYear ?? new Date().getUTCFullYear());
  const threshold = await container.settings.highIncreaseThresholdPercent(
    container.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT,
  );

  const preview = await container.bulk.preview(
    {
      taxYear,
      ...(params.engagementType ? { engagementType: params.engagementType as never } : {}),
      ...(params.priorYearLetter ? { priorYearLetter: params.priorYearLetter as never } : {}),
      ...(params.previousFee ? { previousFee: params.previousFee as never } : {}),
      ...(params.compilation ? { compilation: params.compilation as never } : {}),
      ...(params.readiness ? { readiness: params.readiness as never } : {}),
    },
    { highIncreaseThresholdPercent: threshold },
  );

  return (
    <>
      <PageHeader
        title="Bulk Rollout"
        description="Preview first, then generate drafts. Bulk generation never sends anything to Adobe Sign — every document still goes through individual review and approval."
      />

      <form method="get" className="card mb-4">
        <div className="card-body grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="label" htmlFor="taxYear">Tax year</label>
            <input id="taxYear" name="taxYear" type="number" className="input" defaultValue={taxYear} />
          </div>
          <div>
            <label className="label" htmlFor="engagementType">Type</label>
            <select id="engagementType" name="engagementType" className="input" defaultValue={params.engagementType ?? ''}>
              <option value="">All</option>
              <option value="T1_JOINT">T1 joint</option>
              <option value="T2">T2</option>
              <option value="T3">T3</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="priorYearLetter">Prior-year letter</label>
            <select id="priorYearLetter" name="priorYearLetter" className="input" defaultValue={params.priorYearLetter ?? ''}>
              <option value="">Any</option>
              <option value="FOUND">Found</option>
              <option value="MISSING">Missing</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="previousFee">Previous fee</label>
            <select id="previousFee" name="previousFee" className="input" defaultValue={params.previousFee ?? ''}>
              <option value="">Any</option>
              <option value="FOUND">Found</option>
              <option value="MISSING">Missing</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="readiness">Readiness</label>
            <select id="readiness" name="readiness" className="input" defaultValue={params.readiness ?? ''}>
              <option value="">Any</option>
              <option value="READY">Ready</option>
              <option value="BLOCKED">Blocked</option>
            </select>
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-secondary">Preview</button>
          </div>
        </div>
      </form>

      <p className="mb-3 text-sm text-slate-600">
        {preview.summary.total} engagement(s) · {preview.summary.ready} ready · {preview.summary.blocked} blocked
      </p>

      {preview.rows.length === 0 ? (
        <EmptyState message="No engagements match these filters." />
      ) : (
        <RolloutSelection
          csrfToken={csrfToken}
          batchId={preview.batchId}
          rows={preview.rows}
          canGenerate={can(user, 'generation:start')}
        />
      )}
    </>
  );
}
