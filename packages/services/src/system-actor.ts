import type { PrismaClient } from '@element/database';

/**
 * The actor recorded when nobody is present.
 *
 * The worker runs jobs with no session behind them — a Karbon trigger, a
 * scheduled poll, a queued rollout — and every one of them still has to say who
 * did it. `system` is that answer.
 */
export const SYSTEM_ACTOR_ID = 'system';

/**
 * The same id, but only where a real person is required.
 *
 * Two kinds of column hold an actor and they are not interchangeable. The audit
 * trail's `userId` is a free string, deliberately: `audit_event` has no foreign
 * keys so history survives the deletion of the records it describes, and
 * `system` is a perfectly good value there. But columns like
 * `fee_calculation.calculated_by_user_id` and `engagement.assigned_preparer_id`
 * are foreign keys to `user.id`, and there is no `system` user — nor should
 * there be, since it would appear in every assignment menu and in the
 * firm-signer list.
 *
 * Writing `system` into one of those is a foreign-key violation, and a job that
 * violates one does not fail visibly: it burns its retries and drops the
 * engagement into `NEEDS_ATTENTION` with a Prisma error nobody reads. That is
 * the failure this exists to prevent.
 *
 * So: null where no person acted. The column is nullable in every case, and
 * "the system calculated this" is a truthful thing for it to say.
 */
export async function resolveUserActor(
  prisma: PrismaClient,
  actorId: string | null | undefined,
): Promise<string | null> {
  if (!actorId || actorId === SYSTEM_ACTOR_ID) return null;

  const user = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true } });
  return user?.id ?? null;
}
