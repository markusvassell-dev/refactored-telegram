import Link from 'next/link';
import { notFound } from 'next/navigation';
import { container } from '@/lib/container';
import { pageAccess, sessionCsrfToken } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { PageHeader } from '@/components/shell';
import { FeeRuleEditor, type FeeRuleFormValues } from './editor';

export const dynamic = 'force-dynamic';

/** `new` opens the same editor with an empty rule rather than a separate page. */
const NEW = 'new';

export default async function PricingRulePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await pageAccess('pricing_rule:manage');
  if (!access.allowed) return <AccessDenied permission="pricing_rule:manage" user={access.user} what="Editing a pricing rule" />;

  const { id } = await params;
  const csrfToken = (await sessionCsrfToken()) ?? '';

  const [clients, partners, threshold] = await Promise.all([
    container.prisma.client.findMany({
      orderBy: { legalName: 'asc' },
      select: { id: true, legalName: true },
      take: 500,
    }),
    container.prisma.user.findMany({
      where: { isActive: true, userRoles: { some: { role: 'PARTNER_OR_FINAL_APPROVER' } } },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true },
    }),
    container.settings.highIncreaseThresholdPercent(container.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  if (id === NEW) {
    const blank: FeeRuleFormValues = {
      id: null,
      level: 'ENGAGEMENT_TYPE',
      engagementType: '',
      feeKind: '',
      clientId: '',
      clientGroup: '',
      partnerUserId: '',
      method: 'PERCENTAGE',
      percentage: '3',
      fixedAmount: '',
      exactTarget: '',
      skipRounding: false,
      appliesToAncillaryCharges: false,
      effectiveFrom: today,
      effectiveTo: '',
      isActive: true,
      description: '',
    };

    return (
      <>
        <PageHeader
          title="New pricing rule"
          description="A more specific rule always wins over a broader one, so adding a client rule does not require changing the global one."
          actions={
            <Link className="btn-secondary" href="/pricing-rules">
              Back to pricing rules
            </Link>
          }
        />
        <FeeRuleEditor
          csrfToken={csrfToken}
          initial={blank}
          clients={clients}
          partners={partners}
          highIncreaseThresholdPercent={threshold}
        />
      </>
    );
  }

  const rule = await container.feeRules.get(id).catch(() => null);
  if (!rule) notFound();

  const impact = await container.feeRules.impactOf(rule.id);

  const initial: FeeRuleFormValues = {
    id: rule.id,
    level: rule.level,
    engagementType: rule.engagementType ?? '',
    feeKind: rule.feeKind ?? '',
    clientId: rule.clientId ?? '',
    clientGroup: rule.clientGroup ?? '',
    partnerUserId: rule.partnerUserId ?? '',
    method: rule.method,
    percentage: rule.percentage ? String(Number(rule.percentage)) : '',
    fixedAmount: rule.fixedAmount ? String(Number(rule.fixedAmount)) : '',
    exactTarget: rule.exactTarget ? String(Number(rule.exactTarget)) : '',
    skipRounding: rule.skipRounding,
    appliesToAncillaryCharges: rule.appliesToAncillaryCharges,
    effectiveFrom: rule.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: rule.effectiveTo?.toISOString().slice(0, 10) ?? '',
    isActive: rule.isActive,
    description: rule.description ?? '',
  };

  const scope =
    rule.clientName ??
    rule.partnerName ??
    rule.clientGroup ??
    rule.engagementType ??
    'every engagement';

  return (
    <>
      <PageHeader
        title={rule.description ?? `${rule.level.replace(/_/g, ' ').toLowerCase()} rule`}
        description={`Applies to ${scope} · ${rule.feeKind?.replace(/_/g, ' ').toLowerCase() ?? 'any fee'}`}
        actions={
          <Link className="btn-secondary" href="/pricing-rules">
            Back to pricing rules
          </Link>
        }
      />

      <div
        role="note"
        className="mb-4 rounded border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700"
      >
        <p>
          <strong className="font-semibold">What changing this affects.</strong> {impact.pendingRecalculation}{' '}
          unapproved fee(s) calculated under this rule will be recalculated the next time their engagement is prepared.{' '}
          {impact.approved} approved fee(s) are left exactly as they are — an approval is a decision about a specific
          number, not about the rule that produced it.
        </p>
        <p className="mt-2">
          Nothing already generated, approved or signed changes, and no fee reaches a client without a reviewer seeing
          the derivation behind it.
        </p>
      </div>

      <FeeRuleEditor
        csrfToken={csrfToken}
        initial={initial}
        clients={clients}
        partners={partners}
        highIncreaseThresholdPercent={threshold}
      />
    </>
  );
}
