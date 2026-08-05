import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function PricingRulesPage() {
  await requireUser();

  const [rules, threshold] = await Promise.all([
    container.prisma.feeRule.findMany({ orderBy: [{ level: 'asc' }, { createdAt: 'desc' }] }),
    container.settings.highIncreaseThresholdPercent(container.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT),
  ]);

  return (
    <>
      <PageHeader
        title="Pricing Rules"
        description="Rules apply most-specific-first: one-time override, client, partner or group, engagement type, then global."
      />

      <div className="card mb-4">
        <div className="card-body text-sm">
          <p>
            <strong>Rounding:</strong> every calculated fee is rounded upward to the next $5, including an exact target
            price, unless an administrator creates an explicit no-rounding exception.
          </p>
          <p className="mt-2">
            <strong>High-increase threshold:</strong> {threshold}% — increases above this require partner approval.
          </p>
          <p className="mt-2">
            <strong>Not auto-increased:</strong> retainers, hourly rates, additional-work rates and out-of-pocket
            expenses, unless a rule explicitly opts in.
          </p>
        </div>
      </div>

      {rules.length === 0 ? (
        <EmptyState message="No pricing rules are configured." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Pricing rules</caption>
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Engagement type</th>
                <th scope="col">Fee kind</th>
                <th scope="col">Method</th>
                <th scope="col">Value</th>
                <th scope="col">Rounding</th>
                <th scope="col">Active</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.level.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>{rule.engagementType ?? 'any'}</td>
                  <td>{rule.feeKind?.replace(/_/g, ' ').toLowerCase() ?? 'any'}</td>
                  <td>{rule.method.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>
                    {rule.percentage ? `${Number(rule.percentage)}%` : ''}
                    {rule.fixedAmount ? `$${Number(rule.fixedAmount).toFixed(2)}` : ''}
                    {rule.exactTarget ? `$${Number(rule.exactTarget).toFixed(2)}` : ''}
                    {!rule.percentage && !rule.fixedAmount && !rule.exactTarget ? '—' : ''}
                  </td>
                  <td>{rule.skipRounding ? 'no rounding (exception)' : 'up to next $5'}</td>
                  <td>{rule.isActive ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
