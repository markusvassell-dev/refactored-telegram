import Link from 'next/link';
import { notFound } from 'next/navigation';
import { container } from '@/lib/container';
import { pageAccess } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

/**
 * One audit event, in full.
 *
 * The list page shows seven columns and no payload, so until this existed the
 * `beforeValue`/`afterValue` of every event were written, redacted, indexed and
 * shown to nobody. That is tolerable while the described record still exists
 * and can simply be opened — and it stops being tolerable the moment something
 * is deleted, because the snapshot is then the only account of what was there.
 *
 * Everything shown here was redacted before it was stored: email addresses are
 * masked, anything named like a business or account number is tail-masked, and
 * secrets are dropped outright. That is deliberate. This page is readable by
 * every reviewer, which is a wider audience than the engagement it describes.
 */
export default async function AuditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await pageAccess('audit:view');
  if (!access.allowed) return <AccessDenied permission="audit:view" user={access.user} what="The audit log" />;

  const { id } = await params;
  const event = await container.prisma.auditEvent.findUnique({ where: { id } });
  if (!event) notFound();

  // Resolved separately rather than through a relation: audit_event carries no
  // foreign keys precisely so it outlives what it describes, which means either
  // of these can legitimately come back empty.
  const [user, engagement] = await Promise.all([
    event.userId
      ? container.prisma.user.findUnique({ where: { id: event.userId }, select: { displayName: true, email: true } })
      : Promise.resolve(null),
    event.engagementId
      ? container.prisma.engagement.findUnique({
          where: { id: event.engagementId },
          select: { taxYear: true, engagementType: true, client: { select: { legalName: true } } },
        })
      : Promise.resolve(null),
  ]);

  // Three states, not two. The list page collapses the last two into "system",
  // which reads as "nothing did this" for an action a person took under an
  // account that has since been removed.
  const actor = !event.userId
    ? 'system'
    : (user?.displayName ?? `Deleted user (${event.userId})`);

  const engagementGone = Boolean(event.engagementId) && engagement === null;

  return (
    <>
      <PageHeader
        title={event.eventType}
        description={`Recorded ${event.createdAt.toISOString().slice(0, 19).replace('T', ' ')}`}
        actions={
          <Link href="/audit-log" className="btn-secondary self-center">
            Back to the audit log
          </Link>
        }
      />

      {engagementGone ? (
        <div
          role="status"
          className="mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-semibold">This engagement no longer exists.</p>
          <p className="text-sm">
            Its details are in the snapshot below, which is the only remaining record of it. Audit events are never
            edited or removed, so this entry survives the deletion of what it describes.
          </p>
        </div>
      ) : null}

      <div className="card mb-6 p-4">
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <Detail label="Event">{event.eventType}</Detail>
          <Detail label="Object">
            {event.objectType}
            {event.objectId ? <span className="ml-1 font-mono text-xs text-slate-500">{event.objectId}</span> : null}
          </Detail>
          <Detail label="Who">{actor}</Detail>
          <Detail label="Engagement">
            {engagement ? (
              <Link className="text-brand-700 underline" href={`/engagements/${event.engagementId}`}>
                {engagement.client.legalName} — {engagement.engagementType} {engagement.taxYear}
              </Link>
            ) : event.engagementId ? (
              <span className="font-mono text-xs">{event.engagementId}</span>
            ) : (
              '—'
            )}
          </Detail>
          <Detail label="Reason">{event.reason ?? '—'}</Detail>
          <Detail label="Correlation">
            {event.correlationId ? (
              <Link className="text-brand-700 font-mono text-xs underline" href={`/audit-log?correlationId=${event.correlationId}`}>
                {event.correlationId}
              </Link>
            ) : (
              '—'
            )}
          </Detail>
          <Detail label="Address">{event.ipAddress ?? '—'}</Detail>
          <Detail label="Client software">{event.userAgent ?? '—'}</Detail>
        </dl>
      </div>

      <Payload label="Before" value={event.beforeValue} />
      <Payload label="After" value={event.afterValue} />

      <p className="mt-6 max-w-prose text-xs text-slate-500">
        Values were redacted before they were stored: email addresses are masked, business and account numbers keep only
        their last characters, and secrets are removed entirely. A masked value here is not a missing one.
      </p>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium break-words">{children}</dd>
    </div>
  );
}

function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;

  return (
    <div className="card mb-4 p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-900">{label}</h2>
      {/* Wide content scrolls inside its own container rather than pushing the page sideways. */}
      <div className="overflow-x-auto">
        <pre className="text-xs leading-relaxed whitespace-pre">{JSON.stringify(value, null, 2)}</pre>
      </div>
    </div>
  );
}
