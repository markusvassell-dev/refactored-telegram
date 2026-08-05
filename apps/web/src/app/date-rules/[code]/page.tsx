import Link from 'next/link';
import { notFound } from 'next/navigation';
import { dateFactQuestion } from '@element/dates';
import { container } from '@/lib/container';
import { requirePermission, sessionCsrfToken } from '@/lib/session';
import { PageHeader } from '@/components/shell';
import { DateRuleEditor } from './editor';

export const dynamic = 'force-dynamic';

/**
 * Editing one date rule.
 *
 * A rule is the firm's interpretation of a statutory deadline. Changing it is
 * an administrator action with a written reason, and what it will and will not
 * affect is stated before the change rather than discovered afterwards.
 */
export default async function DateRulePage({ params }: { params: Promise<{ code: string }> }) {
  await requirePermission('date_rule:manage');
  const { code } = await params;
  const csrfToken = (await sessionCsrfToken()) ?? '';

  const rule = await container.dateRules.get(decodeURIComponent(code)).catch(() => null);
  if (!rule) notFound();

  const impact = await container.dateRules.impactOf(rule.code);
  const currentYear = new Date().getUTCFullYear();

  return (
    <>
      <PageHeader
        title={rule.label}
        description={`${rule.code} · applies to ${rule.engagementType ?? 'every engagement type'}`}
        actions={
          <Link className="btn-secondary" href="/date-rules">
            Back to date rules
          </Link>
        }
      />

      <div
        role="note"
        className="mb-4 rounded border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700"
      >
        <p>
          <strong className="font-semibold">What changing this affects.</strong> {impact.pendingRecalculation}{' '}
          unconfirmed date(s) from this rule will be recalculated the next time their engagement is prepared.{' '}
          {impact.confirmed} date(s) a reviewer already confirmed are left exactly as they are — a confirmation is a
          decision, and this application does not revisit one on its own.
        </p>
        <p className="mt-2">
          Nothing already generated, approved or signed changes. This application is not the final authority on a legal
          deadline; every date it proposes is still confirmed by a person.
        </p>
      </div>

      {rule.definitionError ? (
        <div role="alert" className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong className="font-semibold">This rule is not valid and produces no dates:</strong>{' '}
          {rule.definitionError}
        </div>
      ) : null}

      {rule.definition ? (
        <>
          {rule.definition.requiredFacts.length > 0 ? (
            <section className="card mb-4">
              <div className="card-header">
                <h2 className="text-base font-semibold text-slate-900">What this deadline depends on</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Until each is answered on the engagement, this deadline is blocked rather than guessed.
                </p>
              </div>
              <div className="card-body">
                <ul className="space-y-2 text-sm">
                  {rule.definition.requiredFacts.map((fact) => (
                    <li key={fact}>
                      <p className="font-medium">{dateFactQuestion(fact).question}</p>
                      <p className="text-xs text-slate-600">{dateFactQuestion(fact).help}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <DateRuleEditor
            csrfToken={csrfToken}
            code={rule.code}
            label={rule.label}
            notes={rule.notes}
            isActive={rule.isActive}
            definition={rule.definition}
            sample={{ yearEnd: `${currentYear}-03-31`, taxYear: currentYear }}
          />
        </>
      ) : null}
    </>
  );
}
