import { notFound } from 'next/navigation';
import { dateFactQuestion, dateRuleDefinitionSchema } from '@element/dates';
import { FACT_TOKEN_PREFIX, type FieldForm } from '@element/services';
import { formatMoney } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { linksForAll } from '@/lib/document-links';
import { boundedCount, withStableOrder } from '@/lib/pagination';
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
      adobeAgreements: {
        include: {
          signers: true,
          // `id` last so "the twenty most recent" is a defined twenty: signing
          // events arriving in one webhook batch share a `receivedAt`.
          events: { orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 20 },
          _count: { select: { events: true } },
        },
      },
      coverLetters: { include: { documentVersions: true } },
      karbonActivities: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 },
      // `workflowEvents` was fetched here and rendered nowhere — a join on every
      // page view for data no screen showed. The status history it holds is in
      // the audit trail as STATUS_CHANGED events, which the audit tab links to
      // in full, so it is not fetched rather than shown twice.
      _count: { select: { karbonActivities: true } },
    },
  });

  if (!engagement) notFound();

  const [auditEvents, auditEventCount, templateVersion, gate] = await Promise.all([
    container.prisma.auditEvent.findMany({
      where: { engagementId: id },
      // Every audit event written by one transaction shares a `createdAt` to
      // the microsecond, so the tiebreaker is what makes "the hundred most
      // recent" mean anything.
      orderBy: withStableOrder([{ createdAt: 'desc' as const }]),
      take: 100,
    }),
    boundedCount((limit) => container.prisma.auditEvent.count({ where: { engagementId: id }, take: limit })),
    engagement.templateVersionId
      ? container.prisma.templateVersion.findUnique({ where: { id: engagement.templateVersionId } })
      : null,
    container.generation
      .evaluateGate(id, documentTypeFor(engagement.engagementType))
      .catch(() => ({ ok: false, blockers: ['The generation gate could not be evaluated.'], warnings: [] })),
  ]);

  // audit_event has no foreign keys, so history survives the deletion of the
  // records it describes. Names are joined here for display.
  const auditUsers = await container.prisma.user.findMany({
    where: { id: { in: [...new Set(auditEvents.map((event) => event.userId).filter(Boolean))] as string[] } },
    select: { id: true, displayName: true },
  });
  const auditUserNames = new Map(auditUsers.map((user) => [user.id, user.displayName]));
  const auditEventsForDisplay = auditEvents.map((event) => ({
    ...event,
    userDisplayName: event.userId ? (auditUserNames.get(event.userId) ?? null) : null,
  }));

  // Signed, short-lived links so a reviewer can actually read what they are
  // approving. Generated per request; they expire in fifteen minutes.
  const documentLinks = linksForAll(engagement.documentVersions);

  // Which facts do this engagement's date rules actually depend on? Read from
  // the rules themselves rather than a hard-coded list, so an administrator who
  // edits a rule gets the matching question without a code change.
  const requiredFactKeys = new Set<string>();
  for (const date of engagement.calculatedDates) {
    const parsed = dateRuleDefinitionSchema.safeParse(date.dateRule?.definition);
    if (!parsed.success) continue;
    for (const key of parsed.data.requiredFacts) requiredFactKeys.add(key);
  }

  const factAnswers = new Map(
    engagement.extractedFields
      .filter((field) => field.token.startsWith(FACT_TOKEN_PREFIX))
      .map((field) => [field.token.slice(FACT_TOKEN_PREFIX.length), field.valueBoolean]),
  );

  const dateFacts = [...requiredFactKeys].sort().map((key) => ({
    ...dateFactQuestion(key),
    answer: factAnswers.get(key) ?? null,
  }));

  // The editable form, built from the approved template's own field
  // definitions rather than from a hand-maintained list in the UI.
  // A broken manifest must not take the whole review workspace down with it —
  // the reviewer still needs the conflicts, approvals and audit trail.
  const fieldForm: FieldForm = await container.fields.formFor(id).catch(() => ({
    templateVersionId: null,
    documentType: documentTypeFor(engagement.engagementType),
    groups: [],
    outstandingRequired: [],
    totalRequired: 0,
  }));

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
        auditEvents={JSON.parse(JSON.stringify(auditEventsForDisplay))}
        auditEventCount={auditEventCount}
        templateVersion={JSON.parse(JSON.stringify(templateVersion))}
        documentLinks={documentLinks}
        dateFacts={dateFacts}
        fieldForm={fieldForm}
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
