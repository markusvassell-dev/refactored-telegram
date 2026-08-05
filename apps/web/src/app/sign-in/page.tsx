import { redirect } from 'next/navigation';
import { env } from '@element/shared';
import { container } from '@/lib/container';
import { currentUser } from '@/lib/session';
import { PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

/**
 * Sign-in.
 *
 * Microsoft Entra ID is the production method. The development login only
 * appears when APP_ENV is development or test AND DEV_LOGIN_ENABLED is set —
 * the environment schema refuses to boot with it enabled in staging or
 * production, so it cannot be turned on by accident.
 */
export default async function SignInPage() {
  const user = await currentUser();
  if (user) redirect('/');

  const configuration = env();
  const entraConfigured = Boolean(configuration.ENTRA_TENANT_ID && configuration.ENTRA_CLIENT_ID);
  const devLoginAvailable =
    configuration.DEV_LOGIN_ENABLED && (configuration.APP_ENV === 'development' || configuration.APP_ENV === 'test');

  const developmentUsers = devLoginAvailable
    ? await container.prisma.user.findMany({
        where: { isActive: true },
        include: { userRoles: true },
        orderBy: { email: 'asc' },
      })
    : [];

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Sign in" description="Access is restricted to firm staff." />

      <div className="card">
        <div className="card-body space-y-6">
          <section>
            <h2 className="text-base font-semibold text-slate-900">Microsoft Entra ID</h2>
            <p className="mt-1 text-sm text-slate-600">
              Sign in with your firm account. Multi-factor authentication and conditional access are enforced by the
              firm&rsquo;s tenant policy.
            </p>
            <form action="/api/auth/entra/start" method="post" className="mt-3">
              <button type="submit" className="btn-primary" disabled={!entraConfigured}>
                Continue with Microsoft
              </button>
              {!entraConfigured ? (
                <p className="field-note">
                  Entra ID is not configured in this environment. An administrator must set ENTRA_TENANT_ID,
                  ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET.
                </p>
              ) : null}
            </form>
          </section>

          {devLoginAvailable ? (
            <section className="border-t border-slate-200 pt-6">
              <h2 className="text-base font-semibold text-slate-900">Development login</h2>
              <p className="mt-1 text-sm text-slate-600">
                Available only in development and test. Choose a seeded account to exercise each role.
              </p>

              <form action="/api/auth/dev-login" method="post" className="mt-3 space-y-3">
                <div>
                  <label className="label" htmlFor="dev-user">
                    Account
                  </label>
                  <select id="dev-user" name="userId" className="input" required>
                    {developmentUsers.map((developmentUser) => (
                      <option key={developmentUser.id} value={developmentUser.id}>
                        {developmentUser.displayName} — {developmentUser.userRoles.map((row) => row.role).join(', ')}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="btn-secondary">
                  Sign in for development
                </button>
              </form>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
