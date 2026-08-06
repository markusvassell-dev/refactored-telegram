import { can } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { activateTemplateVersion, discardTemplateDraft, uploadTemplateVersion } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const canUpload = can(user, 'template:manage');
  const canPublish = can(user, 'template:publish');

  const templates = await container.prisma.documentTemplate.findMany({
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
    orderBy: { documentType: 'asc' },
  });

  // `createdBy` is a plain column rather than a foreign key, so the uploader is
  // resolved here. It is who a second administrator is being asked *not* to be,
  // which makes it worth showing by name rather than as an id.
  const uploaderIds = templates.flatMap((template) =>
    template.versions.map((version) => version.createdBy).filter((id): id is string => id !== null),
  );
  const uploaders = new Map(
    (
      await container.prisma.user.findMany({
        where: { id: { in: [...new Set(uploaderIds)] } },
        select: { id: true, displayName: true },
      })
    ).map((row) => [row.id, row.displayName]),
  );

  return (
    <>
      <PageHeader
        title="Templates"
        description="The approved master template controls all standard legal wording. Published versions are immutable — revising a template creates a new version, and the one it replaces is retired rather than overwritten."
      />

      {canUpload ? (
        <div role="note" className="mb-4 rounded border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <p>
            <strong className="font-semibold">Uploading does not publish.</strong> A new file is normalised, checked
            against the placeholders this document type expects, and stored as a draft. A{' '}
            <em>different</em> administrator then activates it — the same rule the application applies to any wording
            change, and a template version is a wording change to every future engagement at once.
          </p>
          <p className="mt-2">
            Documents already generated are never affected: each records the version it was rendered from.
          </p>
        </div>
      ) : null}

      {templates.length === 0 ? (
        <EmptyState message="No templates are registered. Run the template normalisation and seed steps." />
      ) : (
        templates.map((template) => {
          const active = template.versions.find((version) => version.status === 'ACTIVE');
          const drafts = template.versions.filter((version) => version.status === 'DRAFT');
          const retired = template.versions.filter((version) => version.status === 'RETIRED');

          return (
            <section key={template.id} className="card mb-4">
              <div className="card-header flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">{template.documentType.replace(/_/g, ' ').toLowerCase()}</h2>
                {template.isProductionSupported ? (
                  <span className="badge bg-emerald-100 text-emerald-800">available</span>
                ) : (
                  <span className="badge bg-slate-100 text-slate-700">awaiting approved template</span>
                )}
              </div>

              <div className="card-body space-y-4">
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">Active version</dt>
                    <dd className="font-medium">{active ? `v${active.versionNumber}` : 'None'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Source file</dt>
                    <dd className="break-all">{active?.sourceFileName ?? '—'}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-slate-500">Source hash</dt>
                    <dd className="break-all font-mono text-xs">{active?.sourceFileHash ?? '—'}</dd>
                  </div>
                </dl>

                {drafts.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-semibold">Drafts waiting to be activated</h3>
                    <ul className="mt-2 space-y-3">
                      {drafts.map((draft) => {
                        const uploadedBySelf = draft.createdBy === user.id;

                        return (
                          <li key={draft.id} className="rounded border border-slate-200 px-3 py-2">
                            <p className="text-sm">
                              <span className="font-medium">v{draft.versionNumber}</span> — {draft.sourceFileName}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Uploaded by {(draft.createdBy && uploaders.get(draft.createdBy)) ?? 'an unknown user'} on{' '}
                              {draft.createdAt.toISOString().slice(0, 10)}
                            </p>
                            {draft.notes ? <p className="mt-1 text-sm text-slate-700">{draft.notes}</p> : null}
                            <p className="mt-1 break-all font-mono text-xs text-slate-500">{draft.sourceFileHash}</p>

                            <div className="mt-2 flex flex-wrap gap-2">
                              {canPublish ? (
                                uploadedBySelf ? (
                                  <p className="text-sm text-amber-800">
                                    You uploaded this version, so somebody else must activate it.
                                  </p>
                                ) : (
                                  <ActionForm
                                    action={activateTemplateVersion}
                                    csrfToken={csrfToken}
                                    submitLabel={`Activate v${draft.versionNumber}`}
                                    confirm={
                                      active
                                        ? `This makes v${draft.versionNumber} the wording for every document generated from now on, and retires v${active.versionNumber}. Continue?`
                                        : 'This makes the document type generatable using this wording. Continue?'
                                    }
                                  >
                                    <input type="hidden" name="templateVersionId" value={draft.id} />
                                  </ActionForm>
                                )
                              ) : null}

                              {canUpload ? (
                                <ActionForm
                                  action={discardTemplateDraft}
                                  csrfToken={csrfToken}
                                  submitLabel="Discard"
                                  variant="secondary"
                                >
                                  <input type="hidden" name="templateVersionId" value={draft.id} />
                                  <div>
                                    <label className="label" htmlFor={`discard-${draft.id}`}>
                                      Reason
                                    </label>
                                    <input id={`discard-${draft.id}`} name="reason" className="input" required />
                                  </div>
                                </ActionForm>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}

                {canUpload ? (
                  <ActionForm
                    action={uploadTemplateVersion}
                    csrfToken={csrfToken}
                    submitLabel="Upload a revised template"
                    variant="secondary"
                  >
                    <input type="hidden" name="documentType" value={template.documentType} />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="label" htmlFor={`file-${template.id}`}>
                          Approved source .docx
                        </label>
                        <input
                          id={`file-${template.id}`}
                          name="file"
                          type="file"
                          accept=".docx"
                          className="input"
                          required
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor={`notes-${template.id}`}>
                          What changed
                        </label>
                        <input id={`notes-${template.id}`} name="notes" className="input" />
                      </div>
                    </div>
                  </ActionForm>
                ) : null}

                {retired.length > 0 ? (
                  <details>
                    <summary className="cursor-pointer text-sm text-slate-600">
                      {retired.length} retired version(s)
                    </summary>
                    <ul className="mt-2 space-y-1 text-xs text-slate-600">
                      {retired.map((version) => (
                        <li key={version.id}>
                          v{version.versionNumber} — {version.sourceFileName} — retired{' '}
                          {version.retiredAt?.toISOString().slice(0, 10) ?? 'unknown'}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            </section>
          );
        })
      )}

      <p className="mt-4 max-w-3xl text-sm text-slate-600">
        A document type marked &ldquo;awaiting approved template&rdquo; cannot be generated. The application will not
        invent legal wording for it. Adding a document type it has never seen is a code change, because a manifest says
        which paragraphs are legal wording, which are conditional and where a signature goes — a judgement about the
        document rather than a transformation of it.
      </p>
    </>
  );
}
