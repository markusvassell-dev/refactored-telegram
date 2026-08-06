import Link from 'next/link';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { Pagination, PageOutOfRange } from '@/components/pagination';
import { boundedCount, parsePageRequest, toPage, withStableOrder } from '@/lib/pagination';
import { retryJob } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function SystemJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const params = await searchParams;
  const request = parsePageRequest(params);

  const where = params.status ? { status: params.status as never } : {};

  const [counts, rows, total] = await Promise.all([
    container.queue.countByStatus(),
    container.prisma.backgroundJob.findMany({
      where,
      // Jobs enqueued or completed together share an `updatedAt`, so the order
      // is not total without the tiebreaker and paging over it would drop rows.
      orderBy: withStableOrder([{ updatedAt: 'desc' as const }]),
      skip: request.skip,
      take: request.take,
    }),
    boundedCount((limit) => container.prisma.backgroundJob.count({ where, take: limit })),
  ]);

  const page = toPage(rows, request);
  const jobs = page.items;

  return (
    <>
      <PageHeader
        title="System Jobs"
        description="Every job carries a deterministic idempotency key, so retrying can never duplicate a document, an upload, or an Adobe Sign agreement."
      />

      {/* Each count is a link, so a number worth investigating is one click from
          the jobs behind it rather than a figure to read and act on elsewhere. */}
      <div className="mb-4 flex flex-wrap gap-3">
        {Object.entries(counts).map(([status, count]) => (
          <Link
            key={status}
            href={`/system-jobs?status=${status}`}
            className={
              params.status === status
                ? 'card border-brand-500 px-4 py-2 ring-1 ring-brand-500'
                : 'card px-4 py-2 hover:border-slate-400'
            }
          >
            <span className="text-xs uppercase text-slate-500">{status.replace(/_/g, ' ').toLowerCase()}</span>
            <span className="ml-2 text-lg font-semibold">{count}</span>
          </Link>
        ))}
        {params.status ? (
          <Link href="/system-jobs" className="btn-secondary self-center">
            Clear filter
          </Link>
        ) : null}
      </div>

      {jobs.length === 0 ? (
        page.page > 1 ? (
          <PageOutOfRange pathname="/system-jobs" params={params} pluralNoun="jobs" />
        ) : (
          <EmptyState message={params.status ? 'No jobs have that status.' : 'No jobs have run yet.'} />
        )
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

          <div className="px-4 pb-3">
            <Pagination
              page={page}
              total={total}
              noun="job"
              pathname="/system-jobs"
              params={params}
              label="System jobs pagination"
            />
          </div>
        </div>
      )}
    </>
  );
}
