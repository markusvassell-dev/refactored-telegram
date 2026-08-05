import { KARBON_CAPABILITY_MATRIX } from '@element/integrations';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  await requireUser();

  const [connections, providers, state] = await Promise.all([
    container.prisma.integrationConnection.findMany({ orderBy: { provider: 'asc' } }),
    container.providers(),
    container.testModeState(),
  ]);

  return (
    <>
      <PageHeader
        title="Integrations"
        description="What this deployment is actually connected to right now. A mock adapter is always labelled as one."
      />

      <section className="card mb-6">
        <div className="card-header"><h2 className="text-base font-semibold">Active adapters</h2></div>
        <div className="card-body">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Karbon</dt>
              <dd className="font-medium">{providers.description.karbon}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Adobe Acrobat Sign</dt>
              <dd className="font-medium">{providers.description.adobeSign}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Test Mode</dt>
              <dd className="font-medium">{state.testMode ? 'On' : 'Off'}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="card mb-6">
        <div className="card-header"><h2 className="text-base font-semibold">Connections</h2></div>
        <div className="card-body overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Integration connections</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Enabled</th>
                <th scope="col">Environment</th>
                <th scope="col">Credentials</th>
                <th scope="col">Last check</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id}>
                  <td className="font-medium">{connection.displayName}</td>
                  <td>{connection.isEnabled ? 'Yes' : 'No'}</td>
                  <td>{connection.isSandbox ? 'Sandbox' : 'Production'}</td>
                  <td>{connection.encryptedCredentials ? 'Stored (encrypted)' : 'Not configured'}</td>
                  <td className="text-xs">
                    {connection.lastCheckedAt
                      ? `${connection.lastCheckedAt.toISOString().slice(0, 16).replace('T', ' ')} — ${connection.lastCheckOk ? 'ok' : connection.lastCheckError ?? 'failed'}`
                      : 'Never checked'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="text-base font-semibold">Karbon capability matrix</h2>
          <p className="mt-1 text-sm text-slate-600">
            &ldquo;Unverified&rdquo; means implemented against the published API but not yet exercised against a live
            tenant from this project. Nothing is claimed to work merely because it compiles.
          </p>
        </div>
        <div className="card-body overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Karbon capability matrix</caption>
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Support</th>
                <th scope="col">API method</th>
                <th scope="col">Fallback</th>
                <th scope="col">Known limitation</th>
              </tr>
            </thead>
            <tbody>
              {KARBON_CAPABILITY_MATRIX.map((entry) => (
                <tr key={entry.capability}>
                  <td className="font-medium">{entry.capability.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>
                    <span
                      className={
                        entry.support === 'SUPPORTED'
                          ? 'badge bg-emerald-100 text-emerald-800'
                          : entry.support === 'UNVERIFIED'
                            ? 'badge bg-amber-100 text-amber-800'
                            : 'badge bg-red-100 text-red-800'
                      }
                    >
                      {entry.support.toLowerCase()}
                    </span>
                  </td>
                  <td className="text-xs">{entry.operation ?? '—'}</td>
                  <td className="max-w-sm text-xs">{entry.fallback ?? '—'}</td>
                  <td className="max-w-sm text-xs text-slate-600">{entry.limitation ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
