import Link from 'next/link';
import type { ReactNode } from 'react';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { EmptyState, PageHeader, StatusBadge } from '@/components/shell';
import { boundedCount, formatTotal, type BoundedCount } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

/**
 * Needs Attention is a worklist, not an archive.
 *
 * Every section shows the most recent few and says how many there are, rather
 * than either loading everything — four of these queries had no limit at all,
 * which is fine until the year the firm has three hundred blocked engagements —
 * or stopping at a fixed number in silence. Where a full, paged list of the same
 * thing exists, the section links to it rather than growing a pager of its own.
 */

const PREVIEW = 10;

const BLOCKED = { OR: [{ status: 'NEEDS_ATTENTION' as const }, { blockedReason: { not: null } }] };

export default async function NeedsAttentionPage() {
  await requireUser();

  const [
    engagements,
    engagementCount,
    deadJobs,
    deadJobCount,
    declined,
    declinedCount,
    expired,
    expiredCount,
    stale,
    staleCount,
  ] = await Promise.all([
    container.prisma.engagement.findMany({
      where: BLOCKED,
      include: { client: true },
      // `id` last so the order is total: rows updated in one batch share an
      // `updatedAt`, and "the ten most recent" is otherwise an ambiguous ten.
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: PREVIEW,
    }),
    boundedCount((limit) => container.prisma.engagement.count({ where: BLOCKED, take: limit })),

    container.prisma.backgroundJob.findMany({
      where: { status: 'DEAD_LETTER' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: PREVIEW,
    }),
    boundedCount((limit) => container.prisma.backgroundJob.count({ where: { status: 'DEAD_LETTER' }, take: limit })),

    container.prisma.adobeAgreement.findMany({
      where: { status: 'DECLINED' },
      include: { engagement: { include: { client: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: PREVIEW,
    }),
    boundedCount((limit) => container.prisma.adobeAgreement.count({ where: { status: 'DECLINED' }, take: limit })),

    container.prisma.adobeAgreement.findMany({
      where: { status: 'EXPIRED' },
      include: { engagement: { include: { client: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: PREVIEW,
    }),
    boundedCount((limit) => container.prisma.adobeAgreement.count({ where: { status: 'EXPIRED' }, take: limit })),

    container.prisma.coverLetterPackage.findMany({
      where: { status: 'STALE' },
      include: { engagement: { include: { client: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: PREVIEW,
    }),
    boundedCount((limit) => container.prisma.coverLetterPackage.count({ where: { status: 'STALE' }, take: limit })),
  ]);

  return (
    <>
      <PageHeader
        title="Needs Attention"
        description="Blocked engagements, exhausted retries, declined and expired agreements, and cover letters invalidated by a changed source document."
      />

      <Section
        title="Blocked engagements"
        shown={engagements.length}
        total={engagementCount}
        noun="engagement"
        seeAll={{ href: '/engagements?status=NEEDS_ATTENTION', label: 'See all blocked engagements' }}
      >
        {engagements.length === 0 ? (
          <EmptyState message="Nothing is blocked." />
        ) : (
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

      <Section title="Declined agreements" shown={declined.length} total={declinedCount} noun="agreement">
        {declined.length === 0 ? (
          <EmptyState message="None." />
        ) : (
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

      <Section title="Expired agreements" shown={expired.length} total={expiredCount} noun="agreement">
        {expired.length === 0 ? (
          <EmptyState message="None." />
        ) : (
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

      <Section
        title="Stale cover letters"
        shown={stale.length}
        total={staleCount}
        noun="cover letter"
        pluralNoun="cover letters"
        seeAll={{ href: '/cover-letters', label: 'See all cover letters' }}
      >
        {stale.length === 0 ? (
          <EmptyState message="None." />
        ) : (
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

      <Section
        title="Failed jobs"
        shown={deadJobs.length}
        total={deadJobCount}
        noun="job"
        seeAll={{ href: '/system-jobs?status=DEAD_LETTER', label: 'See all failed jobs' }}
      >
        {deadJobs.length === 0 ? (
          <EmptyState message="No jobs have exhausted their retries." />
        ) : (
          <div className="card overflow-x-auto">
            <table className="table">
              <caption className="sr-only">Failed jobs</caption>
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
                    <td>
                      {job.attempt}/{job.maxAttempts}
                    </td>
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

function Section({
  title,
  shown,
  total,
  noun,
  pluralNoun,
  seeAll,
  children,
}: {
  title: string;
  shown: number;
  total: BoundedCount;
  noun: string;
  pluralNoun?: string;
  seeAll?: { href: string; label: string };
  children: ReactNode;
}): ReactNode {
  const truncated = total.isLowerBound || total.value > shown;

  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">
          {title}
          {total.value > 0 ? (
            <span className="ml-2 text-sm font-normal text-slate-600">{formatTotal(total, noun, pluralNoun)}</span>
          ) : null}
        </h2>

        {/* Said out loud rather than left to be inferred from a list that simply
            ends: this page is where somebody decides what to work on next. */}
        {truncated ? (
          <p className="text-sm text-slate-600">
            Showing the {shown} most recent.
            {seeAll ? (
              <>
                {' '}
                <Link className="text-brand-700 underline" href={seeAll.href}>
                  {seeAll.label}
                </Link>
                .
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
