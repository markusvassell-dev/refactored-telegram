import { ROLE_PERMISSIONS, ROLES, can, describeBootstrapAddressProblem, env } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { grantRole, revokeRole, setUserActive } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const currentUser = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const canManage = can(currentUser, 'user:manage');

  const users = await container.users.list();
  const activeAdministrators = users.filter(
    (user) => user.isActive && user.roles.some((row) => row.role === 'ADMINISTRATOR'),
  ).length;

  // BOOTSTRAP_ADMIN_EMAILS is matched against the address Entra ID
  // authenticated. When it does not match, the result is silent: somebody signs
  // in, holds no roles, and nothing anywhere says the variable is the reason.
  // Reconciled here against the accounts that actually exist, because this is
  // the screen a person visits when wondering why they have no access.
  const bootstrapAddresses = env().BOOTSTRAP_ADMIN_EMAILS;
  const bootstrap = bootstrapAddresses.map((address) => {
    const match = users.find((user) => user.email.toLowerCase() === address);
    return {
      address,
      matched: match !== undefined,
      isAdministrator: match?.roles.some((row) => row.role === 'ADMINISTRATOR') ?? false,
      // A value that is not an address cannot match anyone, ever. Saying
      // "nobody has signed in with this address" about it sends the reader off
      // to check sign-ins, which is the wrong errand entirely.
      problem: describeBootstrapAddressProblem(address),
    };
  });
  const unmatched = bootstrap.filter((entry) => !entry.matched);
  const malformed = bootstrap.filter((entry) => entry.problem !== null);

  return (
    <>
      <PageHeader
        title="Users and Roles"
        description="Roles are additive. Separation of duties is enforced separately and per document: nobody approves their own draft, wording change, or fee override."
      />

      {canManage && bootstrap.length > 0 ? (
        <div
          role="note"
          className={
            malformed.length > 0
              ? 'mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900'
              : unmatched.length > 0
                ? 'mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900'
                : 'mb-4 rounded border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700'
          }
        >
          <p>
            <strong className="font-semibold">BOOTSTRAP_ADMIN_EMAILS</strong> is set. A listed address is granted
            ADMINISTRATOR the next time it signs in through Entra ID — the only path to a role that does not go through
            an existing administrator.
          </p>
          <ul className="mt-2 space-y-1">
            {bootstrap.map((entry) => (
              <li key={entry.address} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{entry.address}</span>
                {entry.problem ? (
                  <span className="badge bg-red-100 text-red-800">not an address</span>
                ) : entry.matched ? (
                  <span className="badge bg-emerald-100 text-emerald-800">
                    {entry.isAdministrator ? 'granted' : 'signed in, not yet an administrator'}
                  </span>
                ) : (
                  <span className="badge bg-amber-100 text-amber-800">nobody has signed in with this address</span>
                )}
                {entry.problem ? <span className="w-full text-xs">This value {entry.problem}</span> : null}
              </li>
            ))}
          </ul>
          {malformed.length > 0 ? (
            <p className="mt-2">
              Until this is corrected the variable grants nothing at all, and anyone relying on it to get their first
              role will sign in successfully and still have no access. The accounts below are the ones that exist.
            </p>
          ) : unmatched.length > 0 ? (
            <p className="mt-2">
              An address nobody has signed in with grants nothing. Entra ID may have authenticated a different address
              than the one in the variable — the accounts below are the ones that exist. Correct the variable to match
              one of them, or clear it.
            </p>
          ) : (
            <p className="mt-2">
              Every listed address has been granted. Clear the variable now: it is needed exactly once, on a first
              deployment.
            </p>
          )}
        </div>
      ) : null}

      {canManage ? (
        <div role="note" className="mb-4 rounded border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <p>
            <strong className="font-semibold">Every change here is recorded</strong> against the person it affects, with
            the reason you give. A role decides who may approve a client-facing legal document, so the reason matters as
            much as the change.
          </p>
          <p className="mt-2">
            There{' '}
            {activeAdministrators === 1
              ? 'is 1 active administrator'
              : `are ${activeAdministrators} active administrators`}
            . The last one cannot be removed or deactivated — with none, the only way back is a database edit.
          </p>
        </div>
      ) : null}

      <section className="card mb-6">
        <div className="card-header">
          <h2 className="text-base font-semibold">People</h2>
        </div>
        <div className="card-body overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Users</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Roles</th>
                <th scope="col">Active</th>
                <th scope="col">Last sign-in</th>
                {canManage ? <th scope="col">Change</th> : null}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const held = user.roles.map((row) => row.role);
                const grantable = ROLES.filter((role) => !held.includes(role));
                const isSelf = user.id === currentUser.id;

                return (
                  <tr key={user.id}>
                    <td className="font-medium">
                      {user.displayName}
                      {isSelf ? <span className="ml-2 text-xs text-slate-500">(you)</span> : null}
                    </td>
                    <td>{user.email}</td>
                    <td>
                      {held.length === 0 ? (
                        <span className="text-slate-500">None</span>
                      ) : (
                        <ul className="space-y-1">
                          {user.roles.map((row) => (
                            <li key={row.role} className="flex flex-wrap items-center gap-2">
                              <span className="badge bg-slate-100 text-slate-700">{row.role}</span>
                              {row.grantedBy === 'entra-id' ? (
                                <span className="text-xs text-slate-500" title="Reapplied at every sign-in">
                                  from the directory
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>{user.isActive ? 'Yes' : 'No'}</td>
                    <td className="text-xs">
                      {user.lastLoginAt?.toISOString().slice(0, 16).replace('T', ' ') ?? 'Never'}
                    </td>

                    {canManage ? (
                      <td className="min-w-[22rem] space-y-3">
                        {grantable.length > 0 ? (
                          <ActionForm action={grantRole} csrfToken={csrfToken} submitLabel="Grant" variant="secondary">
                            <input type="hidden" name="userId" value={user.id} />
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div>
                                <label className="label" htmlFor={`grant-${user.id}`}>
                                  Grant a role
                                </label>
                                <select
                                  id={`grant-${user.id}`}
                                  name="role"
                                  className="input"
                                  defaultValue={grantable[0]}
                                >
                                  {grantable.map((role) => (
                                    <option key={role} value={role}>
                                      {role}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="label" htmlFor={`grant-reason-${user.id}`}>
                                  Reason
                                </label>
                                <input id={`grant-reason-${user.id}`} name="reason" className="input" required />
                              </div>
                            </div>
                          </ActionForm>
                        ) : (
                          <p className="text-xs text-slate-500">Holds every role.</p>
                        )}

                        {held.length > 0 ? (
                          <ActionForm
                            action={revokeRole}
                            csrfToken={csrfToken}
                            submitLabel="Remove"
                            variant="secondary"
                            confirm="Removing a role takes away what this person can approve. Continue?"
                          >
                            <input type="hidden" name="userId" value={user.id} />
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div>
                                <label className="label" htmlFor={`revoke-${user.id}`}>
                                  Remove a role
                                </label>
                                <select id={`revoke-${user.id}`} name="role" className="input" defaultValue={held[0]}>
                                  {held.map((role) => (
                                    <option key={role} value={role}>
                                      {role}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="label" htmlFor={`revoke-reason-${user.id}`}>
                                  Reason
                                </label>
                                <input id={`revoke-reason-${user.id}`} name="reason" className="input" required />
                              </div>
                            </div>
                          </ActionForm>
                        ) : null}

                        <ActionForm
                          action={setUserActive}
                          csrfToken={csrfToken}
                          submitLabel={user.isActive ? 'Deactivate' : 'Reactivate'}
                          variant="secondary"
                          confirm={
                            user.isActive
                              ? 'A deactivated person cannot sign in. Their past approvals stay on the record. Continue?'
                              : undefined
                          }
                        >
                          <input type="hidden" name="userId" value={user.id} />
                          <input type="hidden" name="isActive" value={user.isActive ? 'false' : 'true'} />
                          <div>
                            <label className="label" htmlFor={`active-reason-${user.id}`}>
                              Reason
                            </label>
                            <input id={`active-reason-${user.id}`} name="reason" className="input" required />
                          </div>
                        </ActionForm>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="text-base font-semibold">What each role can do</h2>
        </div>
        <div className="card-body overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Role permissions</caption>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => (
                <tr key={role}>
                  <td className="font-medium">{role}</td>
                  <td className="text-xs">{ROLE_PERMISSIONS[role].join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-sm text-slate-600">
            An administrator manages the system but does not automatically gain approval or sending rights. Somebody who
            needs both must hold both roles explicitly.
          </p>
        </div>
      </section>
    </>
  );
}
