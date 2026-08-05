import Link from 'next/link';
import { REVIEW_QUEUE_STATUSES } from '@element/workflows';
import { container } from '@/lib/container';
import { currentUser } from '@/lib/session';
import { EmptyState, PageHeader, StatusBadge } from '@/components/shell';

export const dynamic = 'force-dynamic';

interface Widget {
  label: string;
  count: number;
  href: string;
  tone: 'neutral' | 'warn' | 'danger' | 'good';
  description: string;
}

export default async function DashboardPage() {
  const user = await currentUser();

  if (!user) {
    return (
      <div className="mx-auto max-w-lg">
        <PageHeader
          title="Sign in required"
          description="This application handles confidential client tax information. Please sign in to continue."
        />
        <Link href="/sign-in" className="btn-primary">
          Go to sign in
        </Link>
      </div>
    );
  }

  const { prisma } = container;

  const [
    draftsAwaitingReview,
    approvedNotSent,
    awaitingSignature,
    partiallySigned,
    declined,
    expired,
    signedNotReturned,
    coverLettersAwaitingReview,
    blocked,
    failedJobs,
    upcomingDeadlines,
    recent,
    bulkProgress,
  ] = await Promise.all([
    prisma.engagement.count({ where: { status: { in: ['DRAFT_READY', 'REVIEW_REQUIRED', 'IN_REVIEW'] } } }),
    prisma.engagement.count({ where: { status: { in: ['APPROVED', 'READY_TO_SEND'] } } }),
    prisma.adobeAgreement.count({ where: { status: 'OUT_FOR_SIGNATURE' } }),
    prisma.adobeAgreement.count({ where: { status: 'PARTIALLY_SIGNED' } }),
    prisma.adobeAgreement.count({ where: { status: 'DECLINED' } }),
    prisma.adobeAgreement.count({ where: { status: 'EXPIRED' } }),
    prisma.adobeAgreement.count({
      where: { status: { in: ['SIGNED', 'COMPLETED'] }, signedPdfKarbonDocumentId: null },
    }),
    prisma.coverLetterPackage.count({
      where: { status: { in: ['REVIEW_REQUIRED', 'IN_REVIEW', 'CHANGES_REQUESTED'] } },
    }),
    prisma.engagement.count({ where: { OR: [{ blockedReason: { not: null } }, { status: 'NEEDS_ATTENTION' }] } }),
    prisma.backgroundJob.count({ where: { status: 'DEAD_LETTER' } }),
    prisma.calculatedDate.count({
      where: {
        token: { in: ['dates.filing_due', 'dates.filing_deadline'] },
        result: { gte: new Date(), lte: new Date(Date.now() + 30 * 86_400_000) },
      },
    }),
    prisma.engagement.findMany({
      where: { status: { in: [...REVIEW_QUEUE_STATUSES] } },
      include: { client: true },
      orderBy: { updatedAt: 'desc' },
      take: 8,
    }),
    prisma.backgroundJob.groupBy({
      by: ['status'],
      where: { jobType: 'GENERATE_ENGAGEMENT_LETTER' },
      _count: { _all: true },
    }),
  ]);

  const widgets: Widget[] = [
    {
      label: 'Drafts awaiting review',
      count: draftsAwaitingReview,
      href: '/review-queue',
      tone: 'warn',
      description: 'Generated and waiting for a reviewer',
    },
    {
      label: 'Approved but not sent',
      count: approvedNotSent,
      href: '/engagements?status=APPROVED',
      tone: 'neutral',
      description: 'Approved letters not yet sent for signature',
    },
    {
      label: 'Awaiting signature',
      count: awaitingSignature,
      href: '/engagements?status=SENT_FOR_SIGNATURE',
      tone: 'neutral',
      description: 'Adobe agreements out for signature',
    },
    {
      label: 'Partially signed',
      count: partiallySigned,
      href: '/engagements?status=PARTIALLY_SIGNED',
      tone: 'warn',
      description: 'Some signers are still outstanding',
    },
    {
      label: 'Declined',
      count: declined,
      href: '/needs-attention',
      tone: 'danger',
      description: 'A signer declined; needs a decision',
    },
    {
      label: 'Expired',
      count: expired,
      href: '/needs-attention',
      tone: 'danger',
      description: 'Expired agreements are never resent automatically',
    },
    {
      label: 'Signed, not yet in Karbon',
      count: signedNotReturned,
      href: '/system-jobs',
      tone: 'warn',
      description: 'Signed PDF and certificate still to upload',
    },
    {
      label: 'Cover letters awaiting review',
      count: coverLettersAwaitingReview,
      href: '/cover-letters',
      tone: 'warn',
      description: 'Every cover letter needs a person',
    },
    {
      label: 'Blocked engagements',
      count: blocked,
      href: '/needs-attention',
      tone: 'danger',
      description: 'Missing information or a failed step',
    },
    {
      label: 'Failed jobs',
      count: failedJobs,
      href: '/system-jobs',
      tone: 'danger',
      description: 'Retries exhausted; safe to retry manually',
    },
    {
      label: 'Deadlines within 30 days',
      count: upcomingDeadlines,
      href: '/engagements',
      tone: 'neutral',
      description: 'Confirmed filing deadlines approaching',
    },
    {
      label: 'Bulk rollout in progress',
      count: bulkProgress.find((row) => row.status === 'PENDING')?._count._all ?? 0,
      href: '/bulk-rollout',
      tone: 'neutral',
      description: 'Generation jobs still queued',
    },
  ];

  const toneClass: Record<Widget['tone'], string> = {
    neutral: 'border-slate-200',
    warn: 'border-amber-300',
    danger: 'border-red-300',
    good: 'border-emerald-300',
  };

  return (
    <>
      <PageHeader title="Dashboard" description={`Signed in as ${user.displayName}.`} />

      <section aria-labelledby="widgets-heading">
        <h2 id="widgets-heading" className="sr-only">
          Status widgets
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {widgets.map((widget) => (
            <li key={widget.label}>
              <Link
                href={widget.href}
                className={`block rounded-lg border-l-4 bg-white p-4 shadow-sm hover:shadow ${toneClass[widget.tone]}`}
              >
                <span className="block text-3xl font-semibold text-slate-900">{widget.count}</span>
                <span className="mt-1 block text-sm font-medium text-slate-800">{widget.label}</span>
                <span className="mt-1 block text-xs text-slate-500">{widget.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="queue-heading" className="mt-8">
        <h2 id="queue-heading" className="mb-3 text-lg font-semibold text-slate-900">
          Waiting on a person
        </h2>

        {recent.length === 0 ? (
          <EmptyState message="Nothing is waiting for review right now." />
        ) : (
          <div className="card overflow-x-auto">
            <table className="table">
              <caption className="sr-only">Engagements currently waiting on a person</caption>
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Type</th>
                  <th scope="col">Year</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((engagement) => (
                  <tr key={engagement.id}>
                    <td>
                      <Link className="text-brand-700 underline" href={`/engagements/${engagement.id}`}>
                        {engagement.client.legalName}
                      </Link>
                    </td>
                    <td>{engagement.engagementType}</td>
                    <td>{engagement.taxYear}</td>
                    <td>
                      <StatusBadge status={engagement.status} />
                    </td>
                    <td>{engagement.updatedAt.toISOString().slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
