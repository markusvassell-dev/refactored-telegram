import Link from 'next/link';
import { container } from '@/lib/container';
import { requireUser, sessionCsrfToken } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { markAllNotificationsRead, markNotificationRead } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * What has happened that this person should know about.
 *
 * Addressed to the reader: everyone sees their own list, and reading one is a
 * personal act rather than a shared one. Three people can be told a letter was
 * signed and each clear it in their own time.
 */
export default async function NotificationsPage() {
  const user = await requireUser();
  const csrfToken = (await sessionCsrfToken()) ?? '';
  const notifications = await container.userNotifications.listFor(user.id);
  const unread = notifications.filter((notification) => notification.readAt === null);

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Addressed to you. Everything here is also in the engagement it concerns — this is so you do not have to go looking."
        actions={
          unread.length > 0 ? (
            <ActionForm
              action={markAllNotificationsRead}
              csrfToken={csrfToken}
              submitLabel={`Mark all ${unread.length} read`}
              variant="secondary"
            />
          ) : undefined
        }
      />

      {notifications.length === 0 ? (
        <EmptyState message="Nothing to report. You will be told here when a letter you are responsible for is signed, declined or expires." />
      ) : (
        <ul className="space-y-3">
          {notifications.map((notification) => (
            <li
              key={notification.id}
              className={
                notification.readAt === null
                  ? 'card border-l-4 border-l-brand-500'
                  : 'card border-l-4 border-l-transparent opacity-70'
              }
            >
              <div className="card-body">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">{notification.title}</p>
                    <p className="mt-1 text-sm text-slate-600">{notification.body}</p>
                    <p className="mt-2 text-xs text-slate-500">
                      {notification.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                      {notification.readAt === null ? null : ' · read'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {notification.link ? (
                      <Link href={notification.link} className="btn-secondary">
                        Open
                      </Link>
                    ) : null}
                    {notification.readAt === null ? (
                      <ActionForm
                        action={markNotificationRead}
                        csrfToken={csrfToken}
                        submitLabel="Mark read"
                        variant="secondary"
                      >
                        <input type="hidden" name="notificationId" value={notification.id} />
                      </ActionForm>
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
