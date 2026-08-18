import { env, inspectStorageDurability } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { setFirmSigner, setProductionSending, setTestMode } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const configuration = env();

  const [state, settings, storage, unfiledSignatures, activeUsers] = await Promise.all([
    container.testModeState(),
    container.prisma.systemSetting.findMany({ orderBy: { key: 'asc' } }),
    // The deploy log said this too, once, and then scrolled away. Somebody
    // wondering where a document went needs to be able to find out now.
    inspectStorageDurability(configuration.DOCUMENT_STORAGE_DIRECTORY),
    // A signed letter with no Karbon document id exists in exactly one place.
    // A warning that can count them is one somebody acts on; "documents may be
    // lost" is one they read past.
    container.prisma.externalSignature.count({ where: { karbonDocumentId: null } }),
    // Candidates for the firm signer, and whoever currently holds it.
    container.prisma.user.findMany({
      where: { isActive: true },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true, email: true },
    }),
  ]);

  const firmSignerId = settings.find((setting) => setting.key === 'firm_signer_user_id')?.value;
  const currentFirmSigner = typeof firmSignerId === 'string' ? firmSignerId : '';

  const isAdministrator = user.roles.includes('ADMINISTRATOR');

  return (
    <>
      <PageHeader
        title="Settings"
        description="Test Mode defaults to on. Production sending must be armed separately, by an administrator, and only when Test Mode is off."
      />

      {/*
        The count, stated quietly and always.

        The banner below appears only when something is wrong, which is right for
        a warning and wrong as the only place the number lives. Deciding whether a
        Railway volume can be detached needs to know how many files are on it —
        and that decision is taken precisely when nothing is wrong, so the warning
        is silent and the operator has nowhere to look but a boot log that has
        already scrolled away. Railway deletes a volume's contents with no undo,
        so "I think it was empty" is not good enough to act on.
      */}
      <p className="mb-6 text-sm text-slate-600">
        <span className="font-medium text-slate-900">Document storage:</span>{' '}
        {storage.moreFiles ? 'at least ' : ''}
        {storage.filesOnDisk} file{storage.filesOnDisk === 1 ? '' : 's'} on disk at{' '}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{storage.directory}</code>
        {storage.durability === 'UNKNOWN'
          ? ', durability unknown'
          : storage.durability === 'DURABLE'
            ? ', on a mounted volume'
            : ", on the container's own filesystem"}
        .{' '}
        {storage.filesOnDisk === 0
          ? 'Every document is a database row, so this path holds nothing and a volume here is optional.'
          : 'These predate the move to database storage; everything written since is a row.'}
      </p>

      {storage.atRisk ? (
        <div
          role="note"
          className="mb-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          <p>
            <strong className="font-semibold">
              {storage.filesOnDisk} document file(s) will not survive the next deploy.
            </strong>{' '}
            {storage.detail}
          </p>
          <p className="mt-2">
            Attach a volume to keep them, or let them go if they are drafts that can be regenerated. Everything written
            since storage moved into the database is a row and is unaffected either way.
          </p>
        </div>
      ) : null}

      {/* Worth saying even when nothing on disk is at risk: a signature that
          never reaches Karbon is one the firm cannot produce from its own system
          of record, whatever the disk does. */}
      {!storage.atRisk && unfiledSignatures > 0 ? (
        <div role="note" className="mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            <strong className="font-semibold">
              {unfiledSignatures} signed engagement letter{unfiledSignatures === 1 ? '' : 's'} not yet filed into
              Karbon.
            </strong>{' '}
            Karbon is the system of record, and until filing succeeds these exist only here. This is expected while
            Karbon is unconnected or Test Mode is on; if neither is true, check the system jobs for a failing
            FILE_EXTERNAL_SIGNATURE.
          </p>
        </div>
      ) : null}

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
        <div className="card-header">
          <h2 className="text-base font-semibold">Firm signer</h2>
        </div>
        <div className="card-body space-y-3">
          <p className="text-sm text-slate-600">
            Who signs on the firm&rsquo;s behalf. The firm signs first, so the letter a client receives has already been
            countersigned. Preparing an engagement proposes this person; the Signers tab can override it for one
            engagement without changing the default.
          </p>

          {currentFirmSigner ? null : (
            <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              No firm signer is set, so preparation cannot propose one and nothing can be sent for signature until a
              signer is named on each engagement by hand.
            </p>
          )}

          {isAdministrator ? (
            <ActionForm action={setFirmSigner} csrfToken={csrfToken} submitLabel="Save firm signer">
              <label className="label" htmlFor="firm-signer">
                Default firm signer
              </label>
              <select id="firm-signer" name="userId" className="input" defaultValue={currentFirmSigner}>
                <option value="">Nobody &mdash; name a signer on each engagement</option>
                {activeUsers.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.displayName} ({candidate.email})
                  </option>
                ))}
              </select>
              <p className="field-note">
                Changing this affects engagements prepared from now on. Ones already prepared keep the signer they have,
                because a reviewer may already have confirmed it.
              </p>
            </ActionForm>
          ) : (
            <p className="text-sm text-slate-600">
              {currentFirmSigner
                ? activeUsers.find((candidate) => candidate.id === currentFirmSigner)?.displayName ??
                  'A user who no longer exists.'
                : 'Not set.'}{' '}
              Only an administrator can change this.
            </p>
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
