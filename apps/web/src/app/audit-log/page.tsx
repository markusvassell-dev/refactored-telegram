import { container } from '@/lib/container';
import { requirePermission } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('audit:view');
  const params = await searchParams;

  const events = await container.prisma.auditEvent.findMany({
    where: {
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
    },
    orderBy: { createdAt: 'desc' },
    take: 250,
  });

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
        <EmptyState message="No audit events match these filters." />
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
                    {event.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
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
        </div>
      )}
    </>
  );
}
