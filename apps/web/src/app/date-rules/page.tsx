import Link from 'next/link';
import { can } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function DateRulesPage() {
  const user = await requireUser();
  const rules = await container.dateRules.list();
  const editable = can(user, 'date_rule:manage');

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
                <th scope="col">Depends on</th>
                <th scope="col">Requires confirmation</th>
                <th scope="col">Active</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="font-mono text-xs">
                    {editable ? (
                      <Link className="text-brand-700 underline" href={`/date-rules/${encodeURIComponent(rule.code)}`}>
                        {rule.code}
                      </Link>
                    ) : (
                      rule.code
                    )}
                  </td>
                  <td>
                    {rule.label}
                    {rule.definitionError ? (
                      <p className="mt-1 text-xs text-red-700">
                        This rule is not valid and produces no dates: {rule.definitionError}
                      </p>
                    ) : null}
                  </td>
                  <td>{rule.engagementType ?? 'all'}</td>
                  <td className="text-xs">
                    {rule.definition && rule.definition.requiredFacts.length > 0
                      ? rule.definition.requiredFacts.join(', ')
                      : '—'}
                  </td>
                  <td>{rule.requiresConfirmation ? 'Yes' : 'No'}</td>
                  <td>{rule.isActive ? 'Yes' : <span className="text-amber-700">No</span>}</td>
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
