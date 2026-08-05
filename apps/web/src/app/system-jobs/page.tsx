import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { retryJob } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function SystemJobsPage() {
  await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';

  const [counts, jobs] = await Promise.all([
    container.queue.countByStatus(),
    container.prisma.backgroundJob.findMany({ orderBy: { updatedAt: 'desc' }, take: 100 }),
  ]);

  return (
    <>
      <PageHeader
        title="System Jobs"
        description="Every job carries a deterministic idempotency key, so retrying can never duplicate a document, an upload, or an Adobe Sign agreement."
      />

      <div className="mb-4 flex flex-wrap gap-3">
        {Object.entries(counts).map(([status, count]) => (
          <div key={status} className="card px-4 py-2">
            <span className="text-xs uppercase text-slate-500">{status.replace(/_/g, ' ').toLowerCase()}</span>
            <span className="ml-2 text-lg font-semibold">{count}</span>
          </div>
        ))}
      </div>

      {jobs.length === 0 ? (
        <EmptyState message="No jobs have run yet." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Background jobs</caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Status</th>
                <th scope="col">Attempt</th>
                <th scope="col">Correlation</th>
                <th scope="col">Message</th>
                <th scope="col">Updated</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td className="text-xs font-medium">{job.jobType}</td>
                  <td>
                    <span
                      className={
                        job.status === 'SUCCEEDED'
                          ? 'badge bg-emerald-100 text-emerald-800'
                          : job.status === 'DEAD_LETTER' || job.status === 'FAILED'
                            ? 'badge bg-red-100 text-red-800'
                            : 'badge bg-slate-100 text-slate-700'
                      }
                    >
                      {job.status.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </td>
                  <td>{job.attempt}/{job.maxAttempts}</td>
                  <td className="max-w-[8rem] truncate font-mono text-xs">{job.correlationId}</td>
                  <td className="max-w-md text-xs">{job.userMessage ?? job.failureReason ?? '—'}</td>
                  <td className="whitespace-nowrap text-xs">
                    {job.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </td>
                  <td>
                    {job.status === 'DEAD_LETTER' ? (
                      <ActionForm action={retryJob} csrfToken={csrfToken} submitLabel="Retry" variant="secondary">
                        <input type="hidden" name="jobId" value={job.id} />
                      </ActionForm>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
