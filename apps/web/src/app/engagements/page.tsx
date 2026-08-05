import Link from 'next/link';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { EmptyState, PageHeader, StatusBadge } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function EngagementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;

  const engagements = await container.prisma.engagement.findMany({
    where: {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.type ? { engagementType: params.type as never } : {}),
      ...(params.year ? { taxYear: Number(params.year) } : {}),
    },
    include: { client: true, reviewer: true, feeCalculations: true },
    orderBy: [{ taxYear: 'desc' }, { updatedAt: 'desc' }],
    take: 200,
  });

  return (
    <>
      <PageHeader
        title="Engagements"
        description="Every engagement letter the application knows about, newest first."
      />

      <form method="get" className="card mb-4">
        <div className="card-body grid gap-3 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor="type">
              Engagement type
            </label>
            <select id="type" name="type" className="input" defaultValue={params.type ?? ''}>
              <option value="">All</option>
              <option value="T1_JOINT">T1 joint</option>
              <option value="T1_SINGLE">T1 single</option>
              <option value="T2">T2</option>
              <option value="T3">T3</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="year">
              Tax year
            </label>
            <input id="year" name="year" type="number" className="input" defaultValue={params.year ?? ''} />
          </div>
          <div>
            <label className="label" htmlFor="status">
              Status
            </label>
            <input id="status" name="status" className="input" defaultValue={params.status ?? ''} />
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-secondary">
              Apply filters
            </button>
          </div>
        </div>
      </form>

      {engagements.length === 0 ? (
        <EmptyState message="No engagements match these filters." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Engagements</caption>
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Type</th>
                <th scope="col">Year</th>
                <th scope="col">Status</th>
                <th scope="col">Proposed fee</th>
                <th scope="col">Reviewer</th>
              </tr>
            </thead>
            <tbody>
              {engagements.map((engagement) => {
                const primaryFee = engagement.feeCalculations.find((fee) => fee.feeKind !== 'CSRS_4200_COMPILATION');
                return (
                  <tr key={engagement.id}>
                    <td>
                      <Link className="text-brand-700 underline" href={`/engagements/${engagement.id}`}>
                        {engagement.client.legalName}
                      </Link>
                      {engagement.isTestMode ? (
                        <span className="badge ml-2 bg-amber-100 text-amber-800">test</span>
                      ) : null}
                    </td>
                    <td>{engagement.engagementType}</td>
                    <td>{engagement.taxYear}</td>
                    <td>
                      <StatusBadge status={engagement.status} />
                      {engagement.blockedReason ? (
                        <p className="mt-1 text-xs text-red-700">{engagement.blockedReason}</p>
                      ) : null}
                    </td>
                    <td>{primaryFee?.roundedFee ? `$${primaryFee.roundedFee.toFixed(2)}` : '—'}</td>
                    <td>{engagement.reviewer?.displayName ?? 'Unassigned'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
