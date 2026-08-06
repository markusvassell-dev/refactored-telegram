import Link from 'next/link';
import type { Permission, Principal } from '@element/shared';
import { PageHeader } from '@/components/shell';

/**
 * A permission decision, rendered as one.
 *
 * Refusing access is not an error. It was previously thrown as one, which meant
 * the route error boundary caught it and rendered "Something went wrong" with a
 * reference number — the same screen a failed database query produces. Nothing
 * on it distinguished "your account may not read this" from "the application is
 * broken", so the only way to tell was to read the server log.
 *
 * The reason is known at the point of refusal, so it is said here instead.
 */
export function AccessDenied({
  permission,
  user,
  what,
}: {
  permission: Permission;
  user: Principal | null;
  /** Plain-English name of the thing being refused, for the heading. */
  what: string;
}) {
  const hasNoRoles = user !== null && user.roles.length === 0;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="You do not have access to this"
        description={`${what} requires a role your account does not currently hold.`}
      />

      <div className="card">
        <div className="card-body space-y-4 text-sm">
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
            <dt className="text-slate-500">Required</dt>
            <dd className="font-mono text-xs text-slate-800">{permission}</dd>

            <dt className="text-slate-500">Signed in as</dt>
            <dd className="text-slate-800">{user?.email ?? 'nobody'}</dd>

            <dt className="text-slate-500">Your roles</dt>
            <dd className="text-slate-800">{user && user.roles.length > 0 ? user.roles.join(', ') : 'none'}</dd>
          </dl>

          {hasNoRoles ? (
            <>
              <p className="text-slate-600">
                Your account holds no roles at all, so almost every screen will refuse you. Authentication succeeded —
                Entra ID vouched for the address above — but authorisation is separate, and roles are granted inside
                this application.
              </p>
              <p className="text-slate-600">
                On a first deployment there is no administrator to grant them, so the first one comes from the{' '}
                <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">BOOTSTRAP_ADMIN_EMAILS</code> environment
                variable. It is matched against the address above, exactly, ignoring case. If that address is not the
                one in the variable, correct the variable and sign in again.
              </p>
            </>
          ) : (
            <p className="text-slate-600">
              An administrator can grant the necessary role under Users and Roles. Every grant is recorded in the audit
              trail with the reason given.
            </p>
          )}

          <Link href="/" className="btn-secondary inline-block">
            Back to the dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
