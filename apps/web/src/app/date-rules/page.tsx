import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function DateRulesPage() {
  await requireUser();
  const rules = await container.prisma.dateRule.findMany({ orderBy: { code: 'asc' } });

  return (
    <>
      <PageHeader
        title="Date Rules"
        description="Deadlines are calculated from configurable rules, not by adding a year to last year's date. Each result records its rule, input and assumptions, and a reviewer confirms it before anything is sent."
      />

      {rules.length === 0 ? (
        <EmptyState message="No date rules are configured." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Date rules</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Label</th>
                <th scope="col">Applies to</th>
                <th scope="col">Requires confirmation</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="font-mono text-xs">{rule.code}</td>
                  <td>{rule.label}</td>
                  <td>{rule.engagementType ?? 'all'}</td>
                  <td>{rule.requiresConfirmation ? 'Yes' : 'No'}</td>
                  <td className="max-w-md text-xs text-slate-600">{rule.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
