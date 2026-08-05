import { ROLE_PERMISSIONS, ROLES } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';
import { PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  await requireUser();

  const users = await container.prisma.user.findMany({
    include: { userRoles: true },
    orderBy: { email: 'asc' },
  });

  return (
    <>
      <PageHeader
        title="Users and Roles"
        description="Roles are additive. Separation of duties is enforced separately: nobody approves their own draft, wording change, or fee override."
      />

      <section className="card mb-6">
        <div className="card-header"><h2 className="text-base font-semibold">People</h2></div>
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
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td className="font-medium">{user.displayName}</td>
                  <td>{user.email}</td>
                  <td>{user.userRoles.map((row) => row.role).join(', ') || 'None'}</td>
                  <td>{user.isActive ? 'Yes' : 'No'}</td>
                  <td className="text-xs">{user.lastLoginAt?.toISOString().slice(0, 16).replace('T', ' ') ?? 'Never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-header"><h2 className="text-base font-semibold">What each role can do</h2></div>
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
