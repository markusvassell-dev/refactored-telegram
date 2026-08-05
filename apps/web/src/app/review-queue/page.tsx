import Link from 'next/link';
import { REVIEW_QUEUE_STATUSES } from '@element/workflows';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { EmptyState, PageHeader, StatusBadge } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function ReviewQueuePage() {
  const user = await requireUser();

  const engagements = await container.prisma.engagement.findMany({
    where: { status: { in: [...REVIEW_QUEUE_STATUSES] } },
    include: { client: true, reviewer: true, documentVersions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    orderBy: { updatedAt: 'asc' },
  });

  const mine = engagements.filter((engagement) => engagement.assignedReviewerId === user.id);
  const others = engagements.filter((engagement) => engagement.assignedReviewerId !== user.id);

  return (
    <>
      <PageHeader
        title="Review Queue"
        description="Drafts and cover letters waiting on a person. Nothing leaves this queue without an explicit approval."
      />
      <Queue title="Assigned to you" engagements={mine} />
      <Queue title="Everything else" engagements={others} />
    </>
  );
}

interface QueueRow {
  id: string;
  engagementType: string;
  taxYear: number;
  status: string;
  assignedReviewerId: string | null;
  client: { legalName: string };
  documentVersions: { versionNumber: number; validationReport: unknown }[];
}

function Queue({ title, engagements }: { title: string; engagements: QueueRow[] }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">{title}</h2>
      {engagements.length === 0 ? (
        <EmptyState message="Nothing here." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Type</th>
                <th scope="col">Year</th>
                <th scope="col">Status</th>
                <th scope="col">Version</th>
                <th scope="col">Validation</th>
              </tr>
            </thead>
            <tbody>
              {engagements.map((engagement) => {
                const version = engagement.documentVersions[0];
                const report = version?.validationReport as { errorCount?: number } | null;
                return (
                  <tr key={engagement.id}>
                    <td>
                      <Link className="text-brand-700 underline" href={`/engagements/${engagement.id}`}>
                        {engagement.client.legalName}
                      </Link>
                    </td>
                    <td>{engagement.engagementType}</td>
                    <td>{engagement.taxYear}</td>
                    <td><StatusBadge status={engagement.status} /></td>
                    <td>{version ? `v${version.versionNumber}` : '—'}</td>
                    <td className={report?.errorCount ? 'text-red-700' : 'text-emerald-700'}>
                      {report ? `${report.errorCount ?? 0} error(s)` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
