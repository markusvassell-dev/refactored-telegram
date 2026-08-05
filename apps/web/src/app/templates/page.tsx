import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  await requireUser();

  const templates = await container.prisma.documentTemplate.findMany({
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
    orderBy: { documentType: 'asc' },
  });

  return (
    <>
      <PageHeader
        title="Templates"
        description="The approved master template controls all standard legal wording. Published versions are immutable — updating a template creates a new version."
      />

      {templates.length === 0 ? (
        <EmptyState message="No templates are registered. Run the template normalisation and seed steps." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Document templates</caption>
            <thead>
              <tr>
                <th scope="col">Document type</th>
                <th scope="col">Production supported</th>
                <th scope="col">Active version</th>
                <th scope="col">Source file</th>
                <th scope="col">Source hash</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => {
                const active = template.versions.find((version) => version.status === 'ACTIVE');
                return (
                  <tr key={template.id}>
                    <td className="font-medium">{template.documentType.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>
                      {template.isProductionSupported ? (
                        <span className="badge bg-emerald-100 text-emerald-800">available</span>
                      ) : (
                        <span className="badge bg-slate-100 text-slate-700">awaiting approved template</span>
                      )}
                    </td>
                    <td>{active ? `v${active.versionNumber}` : '—'}</td>
                    <td className="text-xs">{active?.sourceFileName ?? '—'}</td>
                    <td className="max-w-[12rem] truncate font-mono text-xs">{active?.sourceFileHash ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 max-w-3xl text-sm text-slate-600">
        A document type marked &ldquo;awaiting approved template&rdquo; cannot be generated. The application will not
        invent legal wording for it; an administrator must upload and activate an approved template first.
      </p>
    </>
  );
}
