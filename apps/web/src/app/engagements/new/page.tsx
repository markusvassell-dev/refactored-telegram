import Link from 'next/link';
import { container } from '@/lib/container';
import { pageAccess, sessionCsrfToken } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { createEngagement } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * Starting an engagement by hand.
 *
 * The rest of the application assumes engagements already exist — they arrive
 * from Karbon, or from the seed. Until the Karbon connection is verified
 * against a live tenant, this is the only way to begin real work.
 */
export default async function NewEngagementPage() {
  const access = await pageAccess('engagement:create');
  if (!access.allowed) return <AccessDenied permission="engagement:create" user={access.user} what="Starting an engagement" />;

  const csrfToken = (await sessionCsrfToken()) ?? '';

  const [clients, reviewers, templates, testMode] = await Promise.all([
    container.prisma.client.findMany({
      orderBy: { legalName: 'asc' },
      select: { id: true, legalName: true, isTestFixture: true },
      take: 500,
    }),
    container.prisma.user.findMany({
      where: { isActive: true, userRoles: { some: { role: { in: ['REVIEWER', 'PARTNER_OR_FINAL_APPROVER'] } } } },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true },
    }),
    container.prisma.documentTemplate.findMany({
      include: { versions: { where: { status: 'ACTIVE' }, take: 1, select: { id: true } } },
    }),
    container.testModeState(),
  ]);

  // Only offer a type that could actually produce a document. A type with no
  // approved template is listed as unavailable rather than silently missing.
  const activeByDocumentType = new Set(
    templates.filter((template) => template.versions.length > 0).map((template) => template.documentType),
  );

  const types = [
    { value: 'T2', label: 'T2 corporate', documentType: 'T2_ENGAGEMENT_LETTER' },
    { value: 'T1_JOINT', label: 'T1 joint taxpayers', documentType: 'T1_JOINT_ENGAGEMENT_LETTER' },
    { value: 'T1_SINGLE', label: 'T1 single taxpayer', documentType: 'T1_SINGLE_ENGAGEMENT_LETTER' },
    { value: 'T3', label: 'T3 trust', documentType: 'T3_ENGAGEMENT_LETTER' },
  ] as const;

  const currentYear = new Date().getUTCFullYear();

  return (
    <>
      <PageHeader
        title="Start an engagement"
        description="Creates the engagement and assigns it to you. Nothing is generated or sent — the next step is Prepare, on the engagement itself."
        actions={
          <Link className="btn-secondary" href="/engagements">
            Back to engagements
          </Link>
        }
      />

      <div className="card">
        <div className="card-body">
          <ActionForm action={createEngagement} csrfToken={csrfToken} submitLabel="Create engagement">
            <fieldset>
              <legend className="label">Client</legend>
              <p className="field-note mb-2">
                Choose an existing client, or name a new one. Naming one that already exists is refused rather than
                creating a second record for the same firm.
              </p>

              <label className="label" htmlFor="clientId">
                Existing client
              </label>
              <select id="clientId" name="clientId" className="input" defaultValue="">
                <option value="">— none, I am naming a new one below —</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.legalName}
                    {client.isTestFixture ? ' (test fixture)' : ''}
                  </option>
                ))}
              </select>

              <label className="label mt-3" htmlFor="newClientName">
                Or a new client&rsquo;s full legal name
              </label>
              <input id="newClientName" name="newClientName" className="input" autoComplete="off" />
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="engagementType">
                  Engagement type
                </label>
                <select id="engagementType" name="engagementType" className="input" required defaultValue="T2">
                  {types.map((type) => {
                    const available = activeByDocumentType.has(type.documentType);
                    return (
                      <option key={type.value} value={type.value} disabled={!available}>
                        {type.label}
                        {available ? '' : ' — no approved template yet'}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="taxYear">
                  Tax year
                </label>
                <input
                  id="taxYear"
                  name="taxYear"
                  type="number"
                  className="input"
                  required
                  defaultValue={currentYear}
                  min={2000}
                  max={currentYear + 2}
                />
              </div>

              <div>
                <label className="label" htmlFor="yearEnd">
                  Year-end
                </label>
                <input id="yearEnd" name="yearEnd" type="date" className="input" />
                <p className="field-note">
                  Required for T2 and T3 — the filing and balance-due dates are calculated from it. A T1 is always
                  calendar-year, so leave it empty.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="karbonWorkItemKey">
                  Karbon work item key (optional)
                </label>
                <input id="karbonWorkItemKey" name="karbonWorkItemKey" className="input" autoComplete="off" />
                <p className="field-note">
                  Linked if this work item is already known here. An unknown key is left unlinked rather than invented.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="assignedReviewerId">
                  Reviewer (optional)
                </label>
                <select id="assignedReviewerId" name="assignedReviewerId" className="input" defaultValue="">
                  <option value="">— assign later —</option>
                  {reviewers.map((reviewer) => (
                    <option key={reviewer.id} value={reviewer.id}>
                      {reviewer.displayName}
                    </option>
                  ))}
                </select>
                <p className="field-note">You are assigned as the preparer. A preparer cannot approve their own draft.</p>
              </div>
            </div>

            {testMode.testMode ? (
              <p className="text-sm text-amber-800">
                Test Mode is on, so this engagement will be marked as a test engagement wherever it appears.
              </p>
            ) : null}
          </ActionForm>
        </div>
      </div>
    </>
  );
}
