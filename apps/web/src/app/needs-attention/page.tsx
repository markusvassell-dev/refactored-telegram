import Link from 'next/link';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { EmptyState, PageHeader, StatusBadge } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function NeedsAttentionPage() {
  await requireUser();

  const [engagements, deadJobs, declined, expired, stale] = await Promise.all([
    container.prisma.engagement.findMany({
      where: { OR: [{ status: 'NEEDS_ATTENTION' }, { blockedReason: { not: null } }] },
      include: { client: true },
      orderBy: { updatedAt: 'desc' },
    }),
    container.prisma.backgroundJob.findMany({
      where: { status: 'DEAD_LETTER' },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    container.prisma.adobeAgreement.findMany({
      where: { status: 'DECLINED' },
      include: { engagement: { include: { client: true } } },
    }),
    container.prisma.adobeAgreement.findMany({
      where: { status: 'EXPIRED' },
      include: { engagement: { include: { client: true } } },
    }),
    container.prisma.coverLetterPackage.findMany({
      where: { status: 'STALE' },
      include: { engagement: { include: { client: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Needs Attention"
        description="Blocked engagements, exhausted retries, declined and expired agreements, and cover letters invalidated by a changed source document."
      />

      <Section title="Blocked engagements">
        {engagements.length === 0 ? <EmptyState message="Nothing is blocked." /> : (
          <ul className="space-y-2">
            {engagements.map((engagement) => (
              <li key={engagement.id} className="card">
                <div className="card-body">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link className="font-medium text-brand-700 underline" href={`/engagements/${engagement.id}`}>
                      {engagement.client.legalName} — {engagement.engagementType} {engagement.taxYear}
                    </Link>
                    <StatusBadge status={engagement.status} />
                  </div>
                  {engagement.blockedReason ? (
                    <p className="mt-2 text-sm text-red-700">{engagement.blockedReason}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Declined agreements">
        {declined.length === 0 ? <EmptyState message="None." /> : (
          <ul className="space-y-2 text-sm">
            {declined.map((agreement) => (
              <li key={agreement.id} className="card">
                <div className="card-body">
                  <Link className="text-brand-700 underline" href={`/engagements/${agreement.engagementId}`}>
                    {agreement.engagement.client.legalName}
                  </Link>
                  <p className="mt-1 text-red-700">{agreement.declineReason ?? 'A signer declined the agreement.'}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Expired agreements">
        {expired.length === 0 ? <EmptyState message="None." /> : (
          <ul className="space-y-2 text-sm">
            {expired.map((agreement) => (
              <li key={agreement.id} className="card">
                <div className="card-body">
                  <Link className="text-brand-700 underline" href={`/engagements/${agreement.engagementId}`}>
                    {agreement.engagement.client.legalName}
                  </Link>
                  <p className="mt-1 text-slate-600">
                    Expired agreements are never resent automatically. Renew it deliberately from the Adobe Sign tab.
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Stale cover letters">
        {stale.length === 0 ? <EmptyState message="None." /> : (
          <ul className="space-y-2 text-sm">
            {stale.map((record) => (
              <li key={record.id} className="card">
                <div className="card-body">
                  <Link className="text-brand-700 underline" href={`/engagements/${record.engagementId}`}>
                    {record.engagement.client.legalName}
                  </Link>
                  <p className="mt-1 text-amber-700">{record.staleReason}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Failed jobs">
        {deadJobs.length === 0 ? <EmptyState message="No jobs have exhausted their retries." /> : (
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">What went wrong</th>
                </tr>
              </thead>
              <tbody>
                {deadJobs.map((job) => (
                  <tr key={job.id}>
                    <td className="text-xs">{job.jobType}</td>
                    <td>{job.attempt}/{job.maxAttempts}</td>
                    <td className="text-sm">{job.userMessage ?? job.failureReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}
