import Link from 'next/link';
import { can } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';
import { Pagination, PageOutOfRange } from '@/components/pagination';
import { ActionForm } from '@/components/action-form';
import { boundedCount, parsePageRequest, toPage, withStableOrder } from '@/lib/pagination';
import { importClientsFromKarbon } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * How deep into Karbon's work items an import looks.
 *
 * Clients are not read from a client list — they are the distinct clients named
 * on work items — so this decides how much of the firm's book can be seen at
 * all. It was fixed at 200, and the import reported when that ceiling bound
 * without offering any way to answer the report.
 *
 * Deeper is not simply better: each distinct client costs a request against a
 * rate-limited API. Importing runs in the worker now, so depth no longer risks
 * the page — but it still spends a shared Karbon allowance, so the choices stay
 * coarse and the default stays where it was.
 */
function WorkItemDepth({ id }: { id: string }) {
  return (
    <>
      <label className="label" htmlFor={`${id}-source`}>
        Where to look
      </label>
      <select id={`${id}-source`} name="source" className="input" defaultValue="CLIENT_LIST">
        <option value="CLIENT_LIST">Karbon&rsquo;s client list — every organisation and contact</option>
        <option value="WORK_ITEMS">Recent work items — only clients with work open</option>
      </select>
      <p className="field-note">
        The client list is what Karbon holds under Organisations and Contacts. Work items find only clients somebody has
        opened work for, so a new or dormant client will not appear — which is why a count from it can look short
        against your own list.
      </p>

      <label className="label mt-4" htmlFor={id}>
        Records to examine
      </label>
      <select id={id} name="limit" className="input" defaultValue="200">
        <option value="200">200 (fastest)</option>
        <option value="500">500</option>
        <option value="1000">1,000</option>
        <option value="2500">2,500</option>
        <option value="5000">5,000 — as deep as it goes (slowest)</option>
      </select>
      <p className="field-note">
        Preview first: it says whether the supply ran out before the limit did, which is how you know the list is
        complete rather than merely long. Previewing is cheap at any depth — it reads the list, not each client.
      </p>
      <p className="field-note">
        Importing runs in the background, because each client added costs one Karbon request and Karbon allows about
        120 a minute — several hundred takes a few minutes. Reload this page to watch them arrive, or open System Jobs
        for the summary when it finishes. Running it again is safe: nothing is duplicated and it continues where it
        stopped.
      </p>

      <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" name="includeAllContactTypes" value="true" className="mt-0.5" />
        <span>
          Include every contact type
          <span className="field-note mt-0.5 block">
            Entries Karbon marks <strong>Inactive</strong> or <strong>Dissolved</strong> are skipped by default, and
            the result says how many. Tick this to import them too — useful when a current client has been left
            mislabelled in Karbon.
          </span>
        </span>
      </label>
    </>
  );
}

/**
 * The firm's clients.
 *
 * There was no such screen, which meant there was also no way to see whether
 * the application knew about a client at all — and no route from "Karbon holds
 * the client list" to "this application can start an engagement for them"
 * except typing each one into a form. For a firm with hundreds of T1s that is
 * the task that never gets done, and an application nobody finishes populating
 * is one nobody uses.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const params = await searchParams;
  const request = parsePageRequest(params);

  const [rows, total, providers] = await Promise.all([
    container.prisma.client.findMany({
      // A bulk import creates hundreds in one pass, so `legalName` ties and
      // identical timestamps are the normal case. Without the tiebreaker the
      // order between tied rows is undefined and paging would drop clients
      // from a list that reports itself complete.
      orderBy: withStableOrder([{ legalName: 'asc' as const }]),
      include: { _count: { select: { engagements: true, contacts: true, karbonDocuments: true } } },
      skip: request.skip,
      take: request.take,
    }),
    boundedCount((limit) => container.prisma.client.count({ take: limit })),
    container.providers(),
  ]);

  const page = toPage(rows, request);
  const clients = page.items;
  const canImport = can(user, 'engagement:create');
  const karbonIsMock = providers.karbon.isMock;

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every client this application knows about. Karbon remains the firm's client list; these are the ones an engagement can be started for."
      />

      {canImport ? (
        <section className="card mb-6">
          <div className="card-header">
            <h2 className="text-base font-semibold">Import from Karbon</h2>
            <p className="mt-1 text-sm text-slate-600">
              Reads Karbon&rsquo;s client list and adds the ones not already here. A client already here is never
              overwritten — Karbon is the system of record for documents, not for the details that go into a legal
              document, and somebody may have corrected those on purpose. Differences are reported so you can decide.
            </p>
          </div>
          <div className="card-body">
            {karbonIsMock ? (
              <p className="text-sm text-slate-600">
                Karbon is not connected, so there is nothing to import. The mock adapter would add fictional sample
                clients to this list, where nothing would distinguish them from the firm&rsquo;s own.
              </p>
            ) : (
              <div className="grid gap-6 lg:grid-cols-2">
                <ActionForm
                  action={importClientsFromKarbon}
                  csrfToken={csrfToken}
                  submitLabel="Preview the import"
                  variant="secondary"
                >
                  <input type="hidden" name="dryRun" value="true" />
                  <WorkItemDepth id="preview-limit" />
                  <p className="text-sm text-slate-600">Reports what would happen and changes nothing.</p>
                </ActionForm>

                <ActionForm
                  action={importClientsFromKarbon}
                  csrfToken={csrfToken}
                  submitLabel="Import them"
                  confirm="This adds the clients Karbon knows about to this application. Continue?"
                >
                  <input type="hidden" name="dryRun" value="false" />
                  <WorkItemDepth id="import-limit" />
                  <p className="text-sm text-slate-600">
                    Adds the new ones in the background. Existing clients are left alone.
                  </p>
                </ActionForm>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {clients.length === 0 ? (
        page.page > 1 ? (
          <PageOutOfRange pathname="/clients" params={params} pluralNoun="clients" />
        ) : (
          <EmptyState message="No clients yet. Import them from Karbon above, or start an engagement, which creates one." />
        )
      ) : (
        <section className="card">
          <div className="card-body overflow-x-auto">
            <table className="table">
              <caption className="sr-only">Clients</caption>
              <thead>
                <tr>
                  <th scope="col">Legal name</th>
                  <th scope="col">Karbon</th>
                  <th scope="col">Business number</th>
                  <th scope="col">Contacts</th>
                  <th scope="col">Documents</th>
                  <th scope="col">Engagements</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id}>
                    <td className="font-medium">
                      <Link className="underline" href={`/clients/${client.id}`}>
                        {client.legalName}
                      </Link>
                      {client.isTestFixture ? (
                        <span className="badge ml-2 bg-amber-100 text-amber-800">test fixture</span>
                      ) : null}
                    </td>
                    <td className="font-mono text-xs">
                      {client.karbonEntityKey ? (
                        <>
                          {client.karbonEntityKey}
                          <span className="ml-2 text-slate-500">{client.karbonEntityType}</span>
                        </>
                      ) : (
                        <span className="text-slate-500">not linked</span>
                      )}
                    </td>
                    <td className="text-xs">{client.businessNumber ?? '—'}</td>
                    <td className="text-xs">{client._count.contacts}</td>
                    <td className="text-xs">
                      {client._count.karbonDocuments > 0 ? (
                        <Link className="underline" href={`/clients/${client.id}`}>
                          {client._count.karbonDocuments}
                        </Link>
                      ) : (
                        <span className="text-slate-500">not read</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {client._count.engagements > 0 ? (
                        <Link className="underline" href={`/engagements?client=${client.id}`}>
                          {client._count.engagements}
                        </Link>
                      ) : (
                        '0'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Pagination
        page={page}
        total={total}
        noun="client"
        pathname="/clients"
        params={params}
        label="Clients pagination"
      />
    </>
  );
}
