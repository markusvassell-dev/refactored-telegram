import { KARBON_CAPABILITY_MATRIX } from '@element/integrations';
import { can } from '@element/shared';
import type { ConnectionView } from '@element/services';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import {
  checkIntegrationConnection,
  clearIntegrationCredentials,
  saveIntegrationConnection,
} from '@/app/actions';

export const dynamic = 'force-dynamic';

const BASE_URL_HELP: Record<string, string> = {
  KARBON: 'Usually https://api.karbonhq.com/v3. Leave blank to use that default.',
  ADOBE_SIGN: 'Region-specific, and required — for example https://api.na1.adobesign.com.',
};

export default async function IntegrationsPage() {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const canManage = can(user, 'integration:manage');

  const [connections, providers, state] = await Promise.all([
    container.integrations.list(),
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
        <div className="card-header">
          <h2 className="text-base font-semibold">Active adapters</h2>
        </div>
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

          {state.testMode ? (
            <p className="mt-3 text-sm text-slate-600">
              While Test Mode is on, only a connection marked <strong>sandbox</strong> is used. A production connection
              is replaced by an adapter that cannot reach the vendor at all — which is why nothing here can turn itself
              into production while Test Mode is on.
            </p>
          ) : null}
        </div>
      </section>

      {connections.map((connection) => (
        <ConnectionCard
          key={connection.provider}
          connection={connection}
          csrfToken={csrfToken}
          canManage={canManage}
          testMode={state.testMode}
        />
      ))}

      <section className="card">
        <div className="card-header">
          <h2 className="text-base font-semibold">Karbon capability matrix</h2>
          <p className="mt-1 text-sm text-slate-600">
            &ldquo;Unverified&rdquo; means implemented against the published API but not yet exercised against a live
            tenant from this project. Nothing is claimed to work merely because it compiles. Running the connection
            check above proves the credentials and the base URL; it does not promote any row below, which only a real
            exercise against a sandbox work item can do.
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

function ConnectionCard({
  connection,
  csrfToken,
  canManage,
  testMode,
}: {
  connection: ConnectionView;
  csrfToken: string;
  canManage: boolean;
  testMode: boolean;
}) {
  const { provider } = connection;

  return (
    <section className="card mb-6">
      <div className="card-header flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{connection.displayName}</h2>
        <div className="flex flex-wrap gap-2">
          <span className={connection.isSandbox ? 'badge bg-blue-100 text-blue-800' : 'badge bg-red-100 text-red-800'}>
            {connection.isSandbox ? 'sandbox' : 'production'}
          </span>
          <span
            className={connection.isEnabled ? 'badge bg-emerald-100 text-emerald-800' : 'badge bg-slate-100 text-slate-700'}
          >
            {connection.isEnabled ? 'enabled' : 'disabled'}
          </span>
        </div>
      </div>

      <div className="card-body space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Credentials</dt>
            <dd>
              {connection.credentials.every((field) => !field.stored) ? (
                'None stored'
              ) : (
                <ul className="space-y-1">
                  {connection.credentials.map((field) => (
                    <li key={field.key} className="flex flex-wrap items-center gap-2">
                      <span>{field.label}</span>
                      {field.stored ? (
                        <>
                          <span className="badge bg-emerald-100 text-emerald-800">stored</span>
                          {/* Six characters of a hash. Enough to tell two tokens
                              apart while rotating, useless to anyone else. */}
                          <span className="font-mono text-xs text-slate-500">#{field.fingerprint}</span>
                        </>
                      ) : (
                        <span className="badge bg-slate-100 text-slate-700">
                          {field.required ? 'required, not set' : 'not set'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Last connection check</dt>
            <dd>
              {connection.lastCheckedAt ? (
                <>
                  <span className={connection.lastCheckOk ? 'text-emerald-800' : 'text-red-700'}>
                    {connection.lastCheckOk ? 'Succeeded' : 'Failed'}
                  </span>{' '}
                  <span className="text-xs text-slate-500">
                    {connection.lastCheckedAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                  {connection.lastCheckError ? (
                    <p className="mt-1 break-words text-xs text-red-700">{connection.lastCheckError}</p>
                  ) : null}
                </>
              ) : (
                'Never checked'
              )}
              {connection.rotatedAt ? (
                <p className="mt-1 text-xs text-slate-500">
                  Credentials last changed {connection.rotatedAt.toISOString().slice(0, 10)}.
                </p>
              ) : null}
            </dd>
          </div>
        </dl>

        {!canManage ? (
          // Silence here reads as a missing feature. Somebody who arrives to
          // connect Karbon and finds a page with no form has no way to tell
          // "you may not do this" from "this was never built".
          <p className="field-note" role="note">
            You do not have permission to change this connection, so it is shown read-only. It needs{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">integration:manage</code>, which the
            ADMINISTRATOR role carries. An administrator can grant it under Users and Roles.
          </p>
        ) : (
          <>
            <ActionForm
              action={saveIntegrationConnection}
              csrfToken={csrfToken}
              submitLabel="Save connection"
              variant="secondary"
            >
              <input type="hidden" name="provider" value={provider} />

              <p className="text-sm text-slate-600">
                A credential you leave blank keeps what is already stored, so you can rotate one without re-entering the
                others. Stored values are never shown again — this application keeps them encrypted, it does not display
                them.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                {connection.credentials.map((field) => (
                  <div key={field.key}>
                    <label className="label" htmlFor={`${provider}-${field.key}`}>
                      {field.label}
                      {field.stored ? <span className="ml-2 text-xs text-slate-500">(stored — blank to keep)</span> : null}
                    </label>
                    <input
                      id={`${provider}-${field.key}`}
                      name={field.key}
                      type="password"
                      autoComplete="off"
                      className="input font-mono"
                      placeholder={field.stored ? '••••••••' : ''}
                    />
                  </div>
                ))}

                <div>
                  <label className="label" htmlFor={`${provider}-baseUrl`}>
                    API base URL
                  </label>
                  <input
                    id={`${provider}-baseUrl`}
                    name="baseUrl"
                    className="input"
                    defaultValue={connection.baseUrl ?? ''}
                  />
                  <p className="mt-1 text-xs text-slate-500">{BASE_URL_HELP[provider]}</p>
                </div>

                <div>
                  <label className="label" htmlFor={`${provider}-isSandbox`}>
                    Environment
                  </label>
                  {/* Keyed on the stored value. These are uncontrolled selects,
                      and React resets a form once its action completes — but
                      `defaultValue` is only applied on mount, so a reset put
                      the old choice back and the screen then contradicted the
                      database. Re-keying remounts the select when the stored
                      value changes, which is the only way an uncontrolled one
                      picks up a new default. */}
                  <select
                    key={`sandbox-${connection.isSandbox}`}
                    id={`${provider}-isSandbox`}
                    name="isSandbox"
                    className="input"
                    defaultValue={connection.isSandbox ? 'true' : 'false'}
                  >
                    <option value="true">Sandbox</option>
                    <option value="false">Production</option>
                  </select>
                  {testMode ? (
                    <p className="mt-1 text-xs text-slate-500">
                      Production cannot be selected while Test Mode is on.
                    </p>
                  ) : null}
                </div>

                <div>
                  <label className="label" htmlFor={`${provider}-isEnabled`}>
                    Use this connection
                  </label>
                  <select
                    key={`enabled-${connection.isEnabled}`}
                    id={`${provider}-isEnabled`}
                    name="isEnabled"
                    className="input"
                    defaultValue={connection.isEnabled ? 'true' : 'false'}
                  >
                    <option value="false">No — use the mock adapter</option>
                    <option value="true">Yes</option>
                  </select>
                </div>
              </div>
            </ActionForm>

            <div className="flex flex-wrap gap-2">
              {connection.isComplete ? (
                <ActionForm
                  action={checkIntegrationConnection}
                  csrfToken={csrfToken}
                  submitLabel="Check connection"
                >
                  <input type="hidden" name="provider" value={provider} />
                </ActionForm>
              ) : (
                <p className="text-sm text-slate-600">
                  Set every required credential before checking the connection.
                </p>
              )}

              {connection.credentials.some((field) => field.stored) ? (
                <ActionForm
                  action={clearIntegrationCredentials}
                  csrfToken={csrfToken}
                  submitLabel="Remove credentials"
                  variant="secondary"
                  confirm="This deletes the stored credentials and disables the connection, which falls back to the mock adapter. Continue?"
                >
                  <input type="hidden" name="provider" value={provider} />
                  <div>
                    <label className="label" htmlFor={`${provider}-clear-reason`}>
                      Reason
                    </label>
                    <input id={`${provider}-clear-reason`} name="reason" className="input" required />
                  </div>
                </ActionForm>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
