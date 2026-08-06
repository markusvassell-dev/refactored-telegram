import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, type DocumentType } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { activateTemplateVersion, uploadTemplateVersion } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * Reading one approved master template.
 *
 * The list says which version governs a document type; this says what it
 * actually contains. That matters most for a draft: activating one changes the
 * wording of every document generated afterwards, and the second administrator
 * was previously asked to approve that on the strength of a file name and a
 * hash.
 *
 * Read-only by construction. Revising the wording means uploading a new
 * version — a published version is immutable, and the database enforces it.
 */
export default async function TemplateReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ documentType: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const { documentType } = await params;
  const query = await searchParams;

  const template = await container.prisma.documentTemplate.findUnique({
    where: { documentType: decodeURIComponent(documentType).toUpperCase() as DocumentType },
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
  });

  if (!template) notFound();

  const canUpload = can(user, 'template:manage');
  const canPublish = can(user, 'template:publish');

  const active = template.versions.find((version) => version.status === 'ACTIVE') ?? null;
  // The version being read: whichever was asked for, else the active one, else
  // the newest — a document type awaiting an approved template has no active
  // version but may well have a draft somebody needs to read.
  const selected =
    template.versions.find((version) => version.id === query.version) ?? active ?? template.versions[0] ?? null;

  const fields = selected
    ? await container.prisma.templateFieldDefinition.findMany({
        where: { templateVersionId: selected.id },
        orderBy: [{ displayGroup: 'asc' }, { displayOrder: 'asc' }],
      })
    : [];

  const title = template.documentType.replace(/_/g, ' ').toLowerCase();

  return (
    <>
      <PageHeader
        title={title}
        description="The approved wording, exactly as it will be rendered. Placeholders appear as the tokens that will be replaced when a document is generated."
        actions={<Link href="/templates" className="btn-secondary">All templates</Link>}
      />

      {template.versions.length === 0 ? (
        <div className="card">
          <div className="card-body text-sm text-slate-600">
            <p>
              No template has been supplied for this document type, so it cannot be generated. The application will not
              invent legal wording for it.
            </p>
            {canUpload ? <p className="mt-2">Upload an approved source below to begin.</p> : null}
          </div>
        </div>
      ) : null}

      {template.versions.length > 1 ? (
        <nav aria-label="Template versions" className="mb-4 flex flex-wrap gap-2">
          {template.versions.map((version) => {
            const isSelected = version.id === selected?.id;
            return (
              <Link
                key={version.id}
                href={`/templates/${template.documentType}?version=${version.id}`}
                aria-current={isSelected ? 'page' : undefined}
                className={
                  isSelected
                    ? 'badge bg-brand-100 text-brand-800 ring-1 ring-brand-400'
                    : 'badge bg-slate-100 text-slate-700 hover:bg-slate-200'
                }
              >
                v{version.versionNumber} — {version.status.toLowerCase()}
              </Link>
            );
          })}
        </nav>
      ) : null}

      {selected ? (
        <>
          <section className="card mb-4">
            <div className="card-header flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">
                v{selected.versionNumber} — {selected.status.toLowerCase()}
              </h2>
              <div className="flex flex-wrap gap-2">
                <a className="btn-secondary" href={`/api/templates/${selected.id}?format=pdf`} target="_blank" rel="noreferrer">
                  Open PDF in a new tab
                </a>
                <a className="btn-secondary" href={`/api/templates/${selected.id}?format=docx`} download>
                  Download Word source
                </a>
              </div>
            </div>

            <div className="card-body">
              <dl className="mb-3 grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-slate-500">Source file</dt>
                  <dd className="break-all">{selected.sourceFileName}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Activated</dt>
                  <dd>{selected.activatedAt?.toISOString().slice(0, 10) ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Retired</dt>
                  <dd>{selected.retiredAt?.toISOString().slice(0, 10) ?? '—'}</dd>
                </div>
                <div className="sm:col-span-3">
                  <dt className="text-slate-500">Source hash</dt>
                  <dd className="break-all font-mono text-xs">{selected.sourceFileHash}</dd>
                </div>
                {selected.notes ? (
                  <div className="sm:col-span-3">
                    <dt className="text-slate-500">What changed</dt>
                    <dd>{selected.notes}</dd>
                  </div>
                ) : null}
              </dl>

              <iframe
                title={`${title} version ${selected.versionNumber}`}
                src={`/api/templates/${selected.id}?format=pdf`}
                className="h-[75vh] w-full rounded border border-slate-300 bg-slate-50"
              />
              <p className="mt-2 text-xs text-slate-500">
                Converted for reading. The Word source above is what a revision starts from — this application never
                edits an approved template.
              </p>
            </div>
          </section>

          {selected.status === 'DRAFT' && canPublish ? (
            <section className="card mb-4">
              <div className="card-header">
                <h2 className="text-base font-semibold">Activate this version</h2>
              </div>
              <div className="card-body">
                {selected.createdBy === user.id ? (
                  <p className="text-sm text-amber-800">
                    You uploaded this version, so somebody else must read it and activate it.
                  </p>
                ) : (
                  <ActionForm
                    action={activateTemplateVersion}
                    csrfToken={csrfToken}
                    submitLabel={`Activate v${selected.versionNumber}`}
                    confirm={
                      active
                        ? `This makes v${selected.versionNumber} the wording for every document generated from now on, and retires v${active.versionNumber}. Continue?`
                        : 'This makes the document type generatable using this wording. Continue?'
                    }
                  >
                    <input type="hidden" name="templateVersionId" value={selected.id} />
                    <p className="mb-2 text-sm text-slate-600">
                      Documents already generated are unaffected: each records the version it was rendered from.
                    </p>
                  </ActionForm>
                )}
              </div>
            </section>
          ) : null}

          <section className="card mb-4">
            <div className="card-header">
              <h2 className="text-base font-semibold">What gets filled in ({fields.length})</h2>
            </div>
            <div className="card-body overflow-x-auto">
              {fields.length === 0 ? (
                <p className="text-sm text-slate-600">This version declares no merge fields.</p>
              ) : (
                <table className="table">
                  <caption className="sr-only">Merge fields declared by this template version</caption>
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Token</th>
                      <th scope="col">In the letter</th>
                      <th scope="col">Type</th>
                      <th scope="col">Required</th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((field) => (
                      <tr key={field.id}>
                        <td className="text-sm">{field.label}</td>
                        <td className="font-mono text-xs">{field.token}</td>
                        <td className="text-xs text-slate-600">{field.sourcePlaceholder ?? '—'}</td>
                        <td className="text-xs">{field.dataType.toLowerCase()}</td>
                        <td className="text-xs">{field.isRequired ? 'yes' : 'no'}</td>
                        <td className="text-xs">{field.isAutoPopulatable ? 'proposed' : 'entered by hand'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      ) : null}

      {canUpload ? (
        <section className="card">
          <div className="card-header">
            <h2 className="text-base font-semibold">Revise this template</h2>
          </div>
          <div className="card-body">
            <p className="mb-3 text-sm text-slate-600">
              Download the Word source, make the change, and upload it here. The upload is normalised, checked against
              the placeholders this document type expects, and stored as a draft — a <em>different</em> administrator
              reads it and activates it.
            </p>
            <ActionForm
              action={uploadTemplateVersion}
              csrfToken={csrfToken}
              submitLabel="Upload a revised template"
              variant="secondary"
            >
              <input type="hidden" name="documentType" value={template.documentType} />
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="file">
                    Approved source .docx
                  </label>
                  <input id="file" name="file" type="file" accept=".docx" className="input" required />
                </div>
                <div>
                  <label className="label" htmlFor="notes">
                    What changed
                  </label>
                  <input id="notes" name="notes" className="input" />
                </div>
              </div>
            </ActionForm>
          </div>
        </section>
      ) : null}
    </>
  );
}
