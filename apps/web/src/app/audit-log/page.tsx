import Link from 'next/link';
import { container } from '@/lib/container';
import { pageAccess } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { EmptyState, PageHeader } from '@/components/shell';
import { Pagination, PageOutOfRange } from '@/components/pagination';
import { boundedCount, parsePageRequest, toPage, withStableOrder } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const access = await pageAccess('audit:view');
  if (!access.allowed) return <AccessDenied permission="audit:view" user={access.user} what="The audit log" />;

  const params = await searchParams;
  const request = parsePageRequest(params, { defaultPageSize: 100 });

  const where = {
    ...(params.eventType ? { eventType: params.eventType } : {}),
    ...(params.engagementId ? { engagementId: params.engagementId } : {}),
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    ...(params.objectType ? { objectType: params.objectType } : {}),
    ...(params.from || params.to
      ? {
          createdAt: {
            ...(params.from ? { gte: new Date(params.from) } : {}),
            ...(params.to ? { lte: new Date(params.to) } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    container.prisma.auditEvent.findMany({
      where,
      // Postgres `now()` is the transaction timestamp, so every event written by
      // one bulk rollout carries an identical `createdAt`. Ordering by it alone
      // leaves tied rows in no defined sequence, and paging over an undefined
      // sequence loses events — which is not a cosmetic fault in an audit trail.
      orderBy: withStableOrder([{ createdAt: 'desc' as const }]),
      skip: request.skip,
      take: request.take,
    }),
    boundedCount((limit) => container.prisma.auditEvent.count({ where, take: limit })),
  ]);

  const page = toPage(rows, request);
  const events = page.items;

  // audit_event deliberately has no foreign keys, so that history survives the
  // deletion of what it describes. The display names are joined here instead.
  const [users, engagements] = await Promise.all([
    container.prisma.user.findMany({
      where: { id: { in: [...new Set(events.map((event) => event.userId).filter(Boolean))] as string[] } },
      select: { id: true, displayName: true },
    }),
    container.prisma.engagement.findMany({
      where: { id: { in: [...new Set(events.map((event) => event.engagementId).filter(Boolean))] as string[] } },
      select: { id: true, client: { select: { legalName: true } } },
    }),
  ]);

  const userNames = new Map(users.map((user) => [user.id, user.displayName]));
  const clientNames = new Map(engagements.map((engagement) => [engagement.id, engagement.client.legalName]));

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Append-only. The database rejects any attempt to update or delete an audit event, and sensitive values are redacted before they are stored."
      />

      <form method="get" className="card mb-4">
        <div className="card-body grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { name: 'eventType', label: 'Event' },
            { name: 'objectType', label: 'Object' },
            { name: 'engagementId', label: 'Engagement' },
            { name: 'userId', label: 'User' },
            { name: 'correlationId', label: 'Correlation' },
          ].map((field) => (
            <div key={field.name}>
              <label className="label" htmlFor={field.name}>{field.label}</label>
              <input id={field.name} name={field.name} className="input" defaultValue={params[field.name] ?? ''} />
            </div>
          ))}
          <div className="flex items-end">
            <button type="submit" className="btn-secondary">Filter</button>
          </div>
        </div>
      </form>

      {events.length === 0 ? (
        page.page > 1 ? (
          <PageOutOfRange pathname="/audit-log" params={params} pluralNoun="audit events" />
        ) : (
          <EmptyState message="No audit events match these filters." />
        )
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Audit events</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col">Object</th>
                <th scope="col">Client</th>
                <th scope="col">User</th>
                <th scope="col">Reason</th>
                <th scope="col">Correlation</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="whitespace-nowrap text-xs">
                    {/* The row's way in to the payload. `beforeValue`/`afterValue` are
                        deliberately not columns here — this table already scrolls
                        sideways, and a snapshot is not a cell. */}
                    <Link className="text-brand-700 underline" href={`/audit-log/${event.id}`}>
                      {event.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                    </Link>
                  </td>
                  <td className="text-xs font-medium">{event.eventType}</td>
                  <td className="text-xs">{event.objectType}</td>
                  <td className="text-xs">{(event.engagementId ? clientNames.get(event.engagementId) : null) ?? '—'}</td>
                  <td className="text-xs">{(event.userId ? userNames.get(event.userId) : null) ?? 'system'}</td>
                  <td className="max-w-xs text-xs">{event.reason ?? '—'}</td>
                  <td className="max-w-[8rem] truncate font-mono text-xs">{event.correlationId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="px-4 pb-3">
            <Pagination
              page={page}
              total={total}
              noun="audit event"
              pluralNoun="audit events"
              pathname="/audit-log"
              params={params}
              label="Audit log pagination"
            />
          </div>
        </div>
      )}
    </>
  );
}
