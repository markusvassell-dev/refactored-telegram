import { NextResponse } from 'next/server';
import { randomToken, env } from '@element/shared';
import { container } from '@/lib/container';
import { createSession } from '@/lib/session';

/**
 * Development-only sign-in.
 *
 * Refuses outright outside development and test, regardless of what the request
 * says. Production authentication always goes through Entra ID.
 */
export async function POST(request: Request): Promise<Response> {
  const configuration = env();

  if (!configuration.DEV_LOGIN_ENABLED || !['development', 'test'].includes(configuration.APP_ENV)) {
    return NextResponse.json({ error: 'The development login is not available in this environment.' }, { status: 403 });
  }

  const formData = await request.formData();
  const userId = formData.get('userId')?.toString();
  if (!userId) return NextResponse.json({ error: 'A user is required.' }, { status: 400 });

  const user = await container.prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) return NextResponse.json({ error: 'Unknown user.' }, { status: 404 });

  await createSession(user.id, randomToken(24));
  await container.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  await container.audit.record({
    eventType: 'USER_LOGIN',
    objectType: 'User',
    objectId: user.id,
    userId: user.id,
    afterValue: { method: 'development-login' },
  });

  return NextResponse.redirect(new URL('/', configuration.APP_BASE_URL), { status: 303 });
}
