import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { syncClientDocuments } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * One client, and everything Karbon holds for them.
 *
 * A client of any age has years of documents in Karbon — prior returns, working
 * papers, signed letters, notices of assessment. Until this screen existed the
 * application could see one at a time, and only where it already knew to look,
 * so preparing an engagement meant leaving for Karbon, finding the file, and
 * uploading it back into a form.
 */

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '—';
}

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';

  const client = await container.prisma.client.findUnique({
    where: { id },
    include: {
      contacts: true,
      _count: { select: { engagements: true, karbonDocuments: true } },
    },
  });

  if (!client) notFound();

  const [documents, lastSync] = await Promise.all([
    container.prisma.karbonClientDocument.findMany({
      where: { clientId: client.id },
      // Documents filed in one batch share an `uploadedAt` to the millisecond,
      // so without the tiebreaker the 500 shown are not a stable 500.
      orderBy: [{ uploadedAt: 'desc' }, { fileName: 'asc' }, { id: 'desc' }],
      take: 500,
    }),
    container.prisma.karbonLibrarySync.findFirst({
      where: { clientId: client.id },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    }),
  ]);

  const canSync = can(user, 'source_document:select');
  const failures = (lastSync?.failureDetail ?? []) as { label: string; reason: string }[];

  return (
    <>
      {/*
        The legal name is the title because it is what prints on the letter, and
        the trading name sits beneath it because it is the one anybody at the
        firm would recognise. A page headed only "2140071 Alberta Ltd." is not
        identifiable by the person checking whether the import got it right.
      */}
      <PageHeader
        title={client.legalName}
        description={[
          client.displayName && client.displayName !== client.legalName ? `Trading as ${client.displayName}` : null,
          client.karbonEntityKey
            ? `Karbon ${client.karbonEntityType ?? 'entity'} ${client.karbonEntityKey}`
            : 'Not linked to Karbon.',
        ]
          .filter((part): part is string => part !== null)
          .join(' · ')}
      />

      <section className="card mb-6">
        <div className="card-header">
          <h2 className="text-base font-semibold">Documents in Karbon</h2>
          <p className="mt-1 text-sm text-slate-600">
            Karbon has no single list of a client&rsquo;s documents — its own Documents tab is an aggregate of the
            client&rsquo;s file area, each contact&rsquo;s, and every work item ever raised for them. This reads all of
            those and catalogues what it finds.
          </p>
        </div>
        <div className="card-body">
          {!client.karbonEntityKey ? (
            <p className="text-sm text-slate-600">
              This client is not linked to Karbon, so there is no document area to read. Import the client from Karbon
              to link it.
            </p>
          ) : (
            <>
              <dl className="mb-4 grid gap-4 sm:grid-cols-4">
                <div>
                  <dt className="text-xs uppercase text-slate-500">Catalogued</dt>
                  <dd className="text-2xl font-semibold">{client._count.karbonDocuments}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase text-slate-500">Places read</dt>
                  <dd className="text-2xl font-semibold">{lastSync?.scopesRead ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase text-slate-500">Last read</dt>
                  <dd className="text-sm">{lastSync ? formatDate(lastSync.startedAt) : 'never'}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase text-slate-500">Complete</dt>
                  <dd className="text-sm">
                    {!lastSync ? (
                      '—'
                    ) : lastSync.complete ? (
                      <span className="badge bg-green-100 text-green-800">yes</span>
                    ) : (
                      <span className="badge bg-amber-100 text-amber-800">no</span>
                    )}
                  </dd>
                </div>
              </dl>

              {/*
                An incomplete read is stated plainly rather than shown as a count.
                A reviewer who cannot find last year's letter needs to know
                whether it is absent from Karbon or merely absent from this list.
              */}
              {lastSync && !lastSync.complete ? (
                <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
                  <p className="font-medium text-amber-900">
                    This list may be missing documents. {lastSync.scopesFailed} of{' '}
                    {lastSync.scopesRead + lastSync.scopesFailed} places could not be read.
                  </p>
                  {failures.length > 0 ? (
                    <ul className="mt-2 list-disc pl-5 text-amber-900">
                      {failures.slice(0, 5).map((failure, index) => (
                        <li key={`${failure.label}-${index}`}>
                          <span className="font-medium">{failure.label}:</span> {failure.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-2 text-amber-900">
                    A document not shown here has not been shown to be absent from Karbon. Read it again before
                    concluding one is missing.
                  </p>
                </div>
              ) : null}

              {canSync ? (
                <ActionForm
                  action={syncClientDocuments}
                  csrfToken={csrfToken}
                  submitLabel={lastSync ? 'Read them again' : 'Read from Karbon'}
                  variant="secondary"
                >
                  <input type="hidden" name="clientId" value={client.id} />
                  <p className="text-sm text-slate-600">
                    Work items are read one at a time against a rate-limited API, so a long-standing client takes a
                    minute. Nothing in Karbon is changed by reading it.
                  </p>
                </ActionForm>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="text-base font-semibold">Catalogue</h2>
          <p className="mt-1 text-sm text-slate-600">
            Names and locations only — the files stay in Karbon. Attach one to an engagement from that
            engagement&rsquo;s source documents tab, which fetches it fresh and scores its contents.
          </p>
        </div>
        <div className="card-body overflow-x-auto">
          {documents.length === 0 ? (
            <EmptyState
              message={
                lastSync
                  ? 'Karbon returned no documents for this client.'
                  : 'Not read yet. Use “Read from Karbon” above.'
              }
            />
          ) : (
            <table className="table">
              <caption className="sr-only">Documents Karbon holds for {client.legalName}</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Filed under</th>
                  <th scope="col">Year</th>
                  <th scope="col">Size</th>
                  <th scope="col">Added</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td className="font-medium">{document.fileName}</td>
                    <td className="text-xs">
                      {document.sourceLabel}
                      <span className="ml-2 text-slate-500">{document.sourceEntityType}</span>
                    </td>
                    {/* Blank, not a guess: a year read wrong files a document against the wrong engagement. */}
                    <td className="text-xs">{document.inferredTaxYear ?? '—'}</td>
                    <td className="text-xs">{formatBytes(document.byteSize)}</td>
                    <td className="text-xs">{formatDate(document.uploadedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <p className="mt-6 text-sm">
        <Link className="underline" href="/clients">
          Back to clients
        </Link>
        {client._count.engagements > 0 ? (
          <>
            {' · '}
            <Link className="underline" href={`/engagements?client=${client.id}`}>
              {client._count.engagements} engagement(s)
            </Link>
          </>
        ) : null}
      </p>
    </>
  );
}
