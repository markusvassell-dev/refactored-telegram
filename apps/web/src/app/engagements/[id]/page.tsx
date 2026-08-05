import { notFound } from 'next/navigation';
import { formatMoney } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { PageHeader, StatusBadge } from '@/components/shell';
import { ReviewWorkspace } from './workspace';

export const dynamic = 'force-dynamic';

/**
 * The engagement review workspace.
 *
 * All fifteen review tabs are served from real persisted data: extracted values
 * with their source and confidence, conflicts awaiting a decision, the fee
 * derivation, calculated dates with their rule and assumptions, versions,
 * approvals, Karbon activity, Adobe status, and the audit trail.
 */
export default async function EngagementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const csrfToken = (await sessionCsrfToken()) ?? '';

  const engagement = await container.prisma.engagement.findUnique({
    where: { id },
    include: {
      client: { include: { contacts: true } },
      karbonWorkItem: true,
      preparer: true,
      reviewer: true,
      finalApprover: true,
      participants: { orderBy: { signingOrder: 'asc' } },
      sourceDocuments: { orderBy: { verificationScore: 'desc' } },
      documentVersions: {
        orderBy: { versionNumber: 'desc' },
        include: { approver: true, creator: true, templateVersion: true },
      },
      extractedFields: { include: { evidence: true, confirmedBy: true } },
      fieldConflicts: true,
      serviceSelections: { orderBy: { displayOrder: 'asc' } },
      feeCalculations: true,
      calculatedDates: { include: { dateRule: true, confirmedBy: true } },
      reviewComments: { include: { user: true }, orderBy: { createdAt: 'desc' } },
      approvals: { include: { user: true }, orderBy: { createdAt: 'desc' } },
      wordingExceptions: { include: { author: true, approver: true } },
      adobeAgreements: { include: { signers: true, events: { orderBy: { receivedAt: 'desc' }, take: 20 } } },
      coverLetters: { include: { documentVersions: true } },
      karbonActivities: { orderBy: { createdAt: 'desc' }, take: 50 },
      workflowEvents: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });

  if (!engagement) notFound();

  const [auditEvents, templateVersion, gate] = await Promise.all([
    container.prisma.auditEvent.findMany({
      where: { engagementId: id },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    engagement.templateVersionId
      ? container.prisma.templateVersion.findUnique({ where: { id: engagement.templateVersionId } })
      : null,
    container.generation
      .evaluateGate(id, documentTypeFor(engagement.engagementType))
      .catch(() => ({ ok: false, blockers: ['The generation gate could not be evaluated.'], warnings: [] })),
  ]);

  const primaryFee = engagement.feeCalculations.find((fee) => fee.feeKind !== 'CSRS_4200_COMPILATION');

  return (
    <>
      <PageHeader
        title={engagement.client.legalName}
        description={`${engagement.engagementType} · ${engagement.taxYear}${
          engagement.yearEnd ? ` · year-end ${engagement.yearEnd.toISOString().slice(0, 10)}` : ''
        }`}
        actions={
          <div className="flex items-center gap-3">
            <StatusBadge status={engagement.status} />
            {primaryFee?.roundedFee ? (
              <span className="text-sm text-slate-600">
                Proposed fee {formatMoney(primaryFee.roundedFee.toString())}
              </span>
            ) : null}
          </div>
        }
      />

      {engagement.blockedReason ? (
        <div role="alert" className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong className="font-semibold">Blocked:</strong> {engagement.blockedReason}
        </div>
      ) : null}

      <ReviewWorkspace
        csrfToken={csrfToken}
        engagement={JSON.parse(JSON.stringify(engagement))}
        auditEvents={JSON.parse(JSON.stringify(auditEvents))}
        templateVersion={JSON.parse(JSON.stringify(templateVersion))}
        generationGate={gate}
      />
    </>
  );
}

function documentTypeFor(engagementType: string) {
  switch (engagementType) {
    case 'T1_JOINT':
      return 'T1_JOINT_ENGAGEMENT_LETTER' as const;
    case 'T1_SINGLE':
      return 'T1_SINGLE_ENGAGEMENT_LETTER' as const;
    case 'T3':
      return 'T3_ENGAGEMENT_LETTER' as const;
    default:
      return 'T2_ENGAGEMENT_LETTER' as const;
  }
}
