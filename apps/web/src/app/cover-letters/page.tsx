import Link from 'next/link';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { approveCoverLetter, markCoverLetterReady } from '@/app/actions';
import { NarrativeEditor, type NarrativeSectionView } from './narrative-editor';
import { can } from '@element/shared';

export const dynamic = 'force-dynamic';

export default async function CoverLettersPage() {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';

  const packages = await container.prisma.coverLetterPackage.findMany({
    include: {
      engagement: { include: { client: true } },
      participant: true,
      documentVersions: { orderBy: { versionNumber: 'desc' } },
      extractedFields: { include: { evidence: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // The editable sections come from the approved template, so a letter whose
  // template declares none simply has no editor — nothing here decides what may
  // be rewritten. A template that has drifted from its manifest raises, and the
  // reason is shown rather than the section quietly disappearing.
  const narrativesByPackage = new Map<string, { sections: NarrativeSectionView[] } | { error: string }>();
  for (const record of packages) {
    try {
      const sections = await container.coverLetterNarratives.sectionsFor(record.id);
      narrativesByPackage.set(record.id, {
        sections: sections
          .filter((section) => section.editLevel === 'ORDINARY')
          .map((section) => ({
            key: section.key,
            label: section.label,
            originalText: section.originalText,
            effectiveText: section.effectiveText,
            edit: section.edit
              ? {
                  editedText: section.edit.editedText,
                  reason: section.edit.reason,
                  authorName: section.edit.authorName,
                  createdAt: section.edit.createdAt.toISOString().slice(0, 10),
                  fromSupersededTemplate: section.edit.fromSupersededTemplate,
                }
              : null,
          })),
      });
    } catch (error) {
      narrativesByPackage.set(record.id, {
        error: error instanceof Error ? error.message : 'The narrative could not be read from the template.',
      });
    }
  }

  return (
    <>
      <PageHeader
        title="Cover Letters"
        description="Every completion cover letter is reviewed and approved by a person. There is no automatic approval path, and none is sent through Adobe Sign by default."
      />

      {packages.length === 0 ? (
        <EmptyState message="No cover letters have been generated." />
      ) : (
        packages.map((record) => {
          const latest = record.documentVersions[0];
          const unconfirmed = record.extractedFields.filter((field) => !field.manuallyConfirmed);

          return (
            <section key={record.id} className="card mb-4">
              <div className="card-header flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">
                    <Link className="text-brand-700 underline" href={`/engagements/${record.engagementId}`}>
                      {record.engagement.client.legalName}
                    </Link>
                    {record.participant ? ` — ${record.participant.fullLegalName}` : ''}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {record.documentType.replace(/_/g, ' ').toLowerCase()} · {record.engagement.taxYear}
                  </p>
                </div>
                <span className="badge bg-slate-100 text-slate-700">{record.status.replace(/_/g, ' ').toLowerCase()}</span>
              </div>

              <div className="card-body space-y-4">
                {record.blockedReason ? <p className="text-sm text-red-700">{record.blockedReason}</p> : null}
                {record.staleReason ? <p className="text-sm text-amber-700">{record.staleReason}</p> : null}

                <div>
                  <h3 className="text-sm font-semibold">Enclosures included</h3>
                  {((record.enclosures ?? []) as { code: string; label: string }[]).length === 0 ? (
                    <p className="text-sm text-slate-500">None selected. Nothing is listed unless the document is present.</p>
                  ) : (
                    <ul className="mt-1 list-disc pl-5 text-sm">
                      {((record.enclosures ?? []) as { code: string; label: string }[]).map((enclosure) => (
                        <li key={enclosure.code}>{enclosure.label}</li>
                      ))}
                    </ul>
                  )}
                </div>

                {(() => {
                  const narrative = narrativesByPackage.get(record.id);
                  if (!narrative) return null;

                  if ('error' in narrative) {
                    return (
                      <p role="note" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        The narrative cannot be edited: {narrative.error}
                      </p>
                    );
                  }

                  return narrative.sections.map((section) => (
                    <NarrativeEditor
                      key={section.key}
                      coverLetterPackageId={record.id}
                      section={section}
                      csrfToken={csrfToken}
                      canEdit={can(user, 'cover_letter:edit')}
                    />
                  ));
                })()}

                {unconfirmed.length > 0 ? (
                  <p className="text-sm text-amber-700">
                    {unconfirmed.length} extracted value(s) still need confirmation before approval.
                  </p>
                ) : null}

                {latest && record.status !== 'APPROVED' && record.status !== 'READY_FOR_DELIVERY' ? (
                  <ActionForm
                    action={approveCoverLetter}
                    csrfToken={csrfToken}
                    submitLabel="Approve cover letter"
                    confirm="Approving records your name against this exact file and its source documents. Continue?"
                  >
                    <input type="hidden" name="coverLetterPackageId" value={record.id} />
                    <input type="hidden" name="documentVersionId" value={latest.id} />
                    <div>
                      <label className="label" htmlFor={`comment-${record.id}`}>Comment (optional)</label>
                      <input id={`comment-${record.id}`} name="comment" className="input" />
                    </div>
                  </ActionForm>
                ) : null}

                {record.status === 'APPROVED' ? (
                  <ActionForm action={markCoverLetterReady} csrfToken={csrfToken} submitLabel="Mark ready for delivery" variant="secondary">
                    <input type="hidden" name="coverLetterPackageId" value={record.id} />
                  </ActionForm>
                ) : null}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}
