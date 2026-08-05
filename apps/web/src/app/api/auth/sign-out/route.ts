import { NextResponse } from 'next/server';
import { env } from '@element/shared';
import { container } from '@/lib/container';
import { currentUser, destroySession } from '@/lib/session';

export async function POST(): Promise<Response> {
  const user = await currentUser().catch(() => null);
  await destroySession();

  if (user) {
    await container.audit
      .record({ eventType: 'USER_LOGOUT', objectType: 'User', objectId: user.id, userId: user.id })
      .catch(() => undefined);
  }

  return NextResponse.redirect(new URL('/sign-in', env().APP_BASE_URL), { status: 303 });
}
