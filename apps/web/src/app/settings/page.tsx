import { env } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { setProductionSending, setTestMode } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const configuration = env();

  const [state, settings] = await Promise.all([
    container.testModeState(),
    container.prisma.systemSetting.findMany({ orderBy: { key: 'asc' } }),
  ]);

  const isAdministrator = user.roles.includes('ADMINISTRATOR');

  return (
    <>
      <PageHeader
        title="Settings"
        description="Test Mode defaults to on. Production sending must be armed separately, by an administrator, and only when Test Mode is off."
      />

      <section className="card mb-6">
        <div className="card-header"><h2 className="text-base font-semibold">Test Mode</h2></div>
        <div className="card-body space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Current state</dt>
              <dd className="font-medium">{state.testMode ? 'Test Mode is ON' : 'Test Mode is OFF'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Production sending</dt>
              <dd className="font-medium">{state.productionSendingEnabled ? 'Armed' : 'Disabled'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Deployment floor</dt>
              <dd className="font-medium">
                {configuration.TEST_MODE ? 'TEST_MODE is set in the environment' : 'Not forced by the environment'}
              </dd>
            </div>
          </dl>

          <p className="text-sm text-slate-600">
            When Test Mode is on: no real client is emailed, no production Adobe Sign agreement is created, nothing is
            uploaded to a production Karbon work item, and every generated file is prefixed with TEST.
          </p>

          {isAdministrator ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <ActionForm
                action={setTestMode}
                csrfToken={csrfToken}
                submitLabel={state.testMode ? 'Turn Test Mode off' : 'Turn Test Mode on'}
                variant={state.testMode ? 'danger' : 'secondary'}
                confirm={state.testMode ? 'Turning Test Mode off allows real production writes once sending is armed. Continue?' : undefined}
              >
                <input type="hidden" name="enabled" value={state.testMode ? 'false' : 'true'} />
              </ActionForm>

              <ActionForm
                action={setProductionSending}
                csrfToken={csrfToken}
                submitLabel={state.productionSendingEnabled ? 'Disable production sending' : 'Arm production sending'}
                variant={state.productionSendingEnabled ? 'secondary' : 'danger'}
                confirm={state.productionSendingEnabled ? undefined : 'This allows agreements to be sent to real clients. Continue?'}
                disabled={configuration.TEST_MODE}
                disabledReason={configuration.TEST_MODE ? 'The environment sets TEST_MODE, which cannot be overridden here.' : undefined}
              >
                <input type="hidden" name="enabled" value={state.productionSendingEnabled ? 'false' : 'true'} />
              </ActionForm>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Only an administrator can change these.</p>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-header"><h2 className="text-base font-semibold">System settings</h2></div>
        <div className="card-body overflow-x-auto">
          <table className="table">
            <caption className="sr-only">System settings</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Value</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {settings.map((setting) => (
                <tr key={setting.key}>
                  <td className="font-mono text-xs">{setting.key}</td>
                  <td className="max-w-md break-all text-xs">{JSON.stringify(setting.value)}</td>
                  <td className="text-xs text-slate-600">{setting.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
