import Link from 'next/link';
import { container } from '@/lib/container';
import { clientLabel } from '@/lib/client-name';
import { pageAccess, sessionCsrfToken } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { createEngagement } from '@/app/actions';
import type { EngagementType } from '@element/shared';
import type { ProposedEngagement } from '@element/services';

export const dynamic = 'force-dynamic';

/**
 * Creating an engagement from what the application already knows.
 *
 * The sibling page asks a person to type the client, the type, the year and the
 * year-end. All four are derivable — `rollForward` has derived them for the
 * Karbon trigger since it was written — but only ever by creating the
 * engagement at the same moment. There was no way to ask what would be created
 * and look first.
 *
 * So this renders `EngagementService.propose`, which is the **same derivation
 * the trigger uses** and writes nothing. That sharing is the whole design: a
 * preview computed by different code from the commit can disagree with it, and
 * over enough changes it will. The date-rule and pricing editors already work
 * this way for the same reason.
 *
 * ## What it does not do
 *
 * It proposes the engagement's *identity*, not the letter's *contents*. Fees,
 * dates, signers and the extracted client details come from preparation, which
 * needs an engagement to exist before it can run — so they are proposed after
 * confirming, and reviewed on the engagement itself, which already has the
 * screens for it.
 *
 * Nothing here is AI. Values come from the Karbon work item title, the previous
 * engagement, and the client record, and each says which.
 */

const TYPES: { value: EngagementType; label: string }[] = [
  { value: 'T2', label: 'T2 corporate' },
  { value: 'T1_JOINT', label: 'T1 joint taxpayers' },
  { value: 'T1_SINGLE', label: 'T1 single taxpayer' },
  { value: 'T3', label: 'T3 trust' },
];

/** Why a proposed value is what it is, in words rather than a code. */
const TAX_YEAR_BASIS: Record<ProposedEngagement['taxYearBasis'], string> = {
  WORK_ITEM_TITLE: 'read from the Karbon work item title',
  PRIOR_YEAR_PLUS_ONE: 'the year after their most recent engagement here',
  CURRENT_YEAR: 'the current calendar year — nothing here names one, so check it',
};

const YEAR_END_BASIS: Record<ProposedEngagement['yearEndBasis'], string> = {
  ROLLED_FROM_PRIOR_YEAR: 'rolled forward from last year',
  REQUIRED_FROM_YOU: 'needed from you — there is nothing to derive it from',
  NOT_APPLICABLE: 'not applicable — a T1 is always calendar-year',
};

export default async function CreateEngagementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await pageAccess('engagement:create');
  if (!access.allowed) {
    return <AccessDenied permission="engagement:create" user={access.user} what="Creating an engagement" />;
  }

  const params = await searchParams;
  const csrfToken = (await sessionCsrfToken()) ?? '';

  const clientId = params.clientId ?? '';
  const engagementType = (TYPES.find((type) => type.value === params.engagementType)?.value ?? 'T2') as EngagementType;

  const [clients, reviewers, templates, testMode] = await Promise.all([
    container.prisma.client.findMany({
      orderBy: { legalName: 'asc' },
      select: {
        id: true,
        legalName: true,
        displayName: true,
        karbonFullName: true,
        karbonEntityKey: true,
        isTestFixture: true,
      },
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

  // Recomputed on every render from the query string rather than held in state.
  // Nothing is written, so there is no cost to it and nothing to desynchronise
  // — the same shape the bulk rollout preview uses.
  const proposal = clientId ? await container.engagements.propose({ clientId, engagementType }) : null;

  const hasTemplate = templates.some(
    (template) =>
      template.versions.length > 0 &&
      template.documentType ===
        { T2: 'T2_ENGAGEMENT_LETTER', T1_JOINT: 'T1_JOINT_ENGAGEMENT_LETTER', T1_SINGLE: 'T1_SINGLE_ENGAGEMENT_LETTER', T3: 'T3_ENGAGEMENT_LETTER' }[
          engagementType
        ],
  );

  return (
    <>
      <PageHeader
        title="Create an engagement"
        description="Works out the year, the year-end and who worked on it last time, and says where each answer came from. Nothing is created until you confirm."
        actions={
          <Link className="btn-secondary" href="/engagements">
            Back to engagements
          </Link>
        }
      />

      <div className="card mb-6">
        <div className="card-header">
          <h2 className="text-base font-semibold">Which client, and what kind of engagement?</h2>
        </div>
        <div className="card-body">
          {/* A GET form: choosing recomputes the proposal by reloading, so
              "redo it" is the same gesture as "choose again". */}
          <form method="get" className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="clientId">
                Client
              </label>
              <select id="clientId" name="clientId" className="input" defaultValue={clientId}>
                <option value="">— choose a client —</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {`${clientLabel(client)}${client.isTestFixture ? ' (test fixture)' : ''}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="engagementType">
                Engagement type
              </label>
              <select id="engagementType" name="engagementType" className="input" defaultValue={engagementType}>
                {TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button type="submit" className="btn-secondary">
                {proposal ? 'Work it out again' : 'Work it out'}
              </button>
            </div>
          </form>

          <p className="field-note mt-3">
            Prefer to type it all in yourself? <Link className="text-brand-700 underline" href="/engagements/new">Start an engagement</Link> asks
            for every field and proposes nothing.
          </p>
        </div>
      </div>

      {proposal ? (
        <Proposal
          proposal={proposal}
          csrfToken={csrfToken}
          reviewers={reviewers}
          hasTemplate={hasTemplate}
          testMode={testMode.testMode}
        />
      ) : null}
    </>
  );
}

function Proposal({
  proposal,
  csrfToken,
  reviewers,
  hasTemplate,
  testMode,
}: {
  proposal: ProposedEngagement;
  csrfToken: string;
  reviewers: { id: string; displayName: string }[];
  hasTemplate: boolean;
  testMode: boolean;
}) {
  if (proposal.blockers.length > 0) {
    return (
      <div role="alert" className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
        <p className="font-semibold">Nothing can be proposed for this client yet.</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {proposal.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (proposal.alreadyExistsId) {
    return (
      <div role="status" className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-semibold">This engagement already exists.</p>
        <p className="mt-1">
          {proposal.clientLegalName} already has a {proposal.taxYear}{' '}
          {proposal.engagementType.replace(/_/g, ' ').toLowerCase()} engagement here, so there is nothing to create.
        </p>
        <Link className="btn-secondary mt-3 inline-block" href={`/engagements/${proposal.alreadyExistsId}`}>
          Open it
        </Link>
      </div>
    );
  }

  const needsYearEnd = proposal.yearEndBasis === 'REQUIRED_FROM_YOU';

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="text-base font-semibold">What would be created</h2>
        <p className="mt-1 text-sm text-slate-600">
          Every value below can be corrected before confirming — reviewing and changing are the same form. Nothing is
          written until you press the button.
        </p>
      </div>
      <div className="card-body">
        {proposal.notes.length > 0 ? (
          <ul className="mb-4 space-y-1 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {proposal.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        <ActionForm
          action={createEngagement}
          csrfToken={csrfToken}
          submitLabel="Create this engagement"
          disabled={!hasTemplate}
          disabledReason={hasTemplate ? undefined : 'This engagement type has no approved template yet.'}
        >
          <input type="hidden" name="clientId" value={proposal.clientId} />
          <input type="hidden" name="engagementType" value={proposal.engagementType} />

          <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-2">
            <Derived label="Client" value={proposal.clientLegalName} basis="the client you chose" />
            <Derived
              label="Engagement type"
              value={TYPES.find((type) => type.value === proposal.engagementType)?.label ?? proposal.engagementType}
              basis="the type you chose"
            />
            {proposal.priorYearFee ? (
              <Derived
                label="Last year's fee"
                value={`$${proposal.priorYearFee}`}
                basis="for context — this year's fee is priced after the letter is prepared"
              />
            ) : null}
          </dl>

          <div className="grid gap-3 sm:grid-cols-2">
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
                defaultValue={proposal.taxYear}
              />
              <p className="field-note">{TAX_YEAR_BASIS[proposal.taxYearBasis]}</p>
            </div>

            <div>
              <label className="label" htmlFor="yearEnd">
                Year-end
              </label>
              <input
                id="yearEnd"
                name="yearEnd"
                type="date"
                className="input"
                defaultValue={proposal.yearEnd ?? ''}
                required={needsYearEnd}
              />
              <p className={needsYearEnd ? 'field-note text-amber-800' : 'field-note'}>
                {YEAR_END_BASIS[proposal.yearEndBasis]}
              </p>
            </div>

            <div>
              <label className="label" htmlFor="assignedReviewerId">
                Reviewer
              </label>
              <select
                id="assignedReviewerId"
                name="assignedReviewerId"
                className="input"
                defaultValue={proposal.assignedReviewerId ?? ''}
              >
                <option value="">— assign later —</option>
                {reviewers.map((reviewer) => (
                  <option key={reviewer.id} value={reviewer.id}>
                    {reviewer.displayName}
                  </option>
                ))}
              </select>
              <p className="field-note">
                {proposal.assignedReviewerId
                  ? 'carried forward from their last engagement'
                  : 'nobody reviewed their last engagement here'}
              </p>
            </div>

            <div>
              <label className="label" htmlFor="karbonWorkItemKey">
                Karbon work item key (optional)
              </label>
              <input id="karbonWorkItemKey" name="karbonWorkItemKey" className="input" autoComplete="off" />
              <p className="field-note">Linked if this work item is already known here.</p>
            </div>
          </div>

          <p className="mt-3 text-sm text-slate-600">
            Confirming creates the engagement, prepares it from last year&rsquo;s letter, and generates the draft. The
            draft still goes to a reviewer, still needs a second person&rsquo;s approval, and can still only be sent by
            a partner.
          </p>

          {testMode ? (
            <p className="text-sm text-amber-800">
              Test Mode is on, so this engagement will be marked as a test engagement wherever it appears.
            </p>
          ) : null}
        </ActionForm>
      </div>
    </div>
  );
}

function Derived({ label, value, basis }: { label: string; value: string; basis: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
      <dd className="field-note">{basis}</dd>
    </div>
  );
}
