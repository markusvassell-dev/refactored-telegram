import { cookies, headers } from 'next/headers';
import { prisma } from '@element/database';
import {
  PermissionError,
  can,
  env,
  seal,
  unseal,
  type Permission,
  type Principal,
  type Role,
} from '@element/shared';

/**
 * Session handling.
 *
 * The session cookie is an authenticated, encrypted blob (AES-256-GCM with a
 * key derived from SESSION_SECRET). It carries only the user id and an expiry;
 * roles are re-read from the database on every request so a revoked role takes
 * effect immediately rather than at the next sign-in.
 */

const COOKIE_NAME = 'element_session';
const MAX_AGE_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  userId: string;
  issuedAt: number;
  expiresAt: number;
  /** Bound to the CSRF token issued with the session. */
  csrfToken: string;
}

export async function createSession(userId: string, csrfToken: string): Promise<void> {
  const configuration = env();
  const now = Math.floor(Date.now() / 1000);

  const payload: SessionPayload = {
    userId,
    issuedAt: now,
    expiresAt: now + MAX_AGE_SECONDS,
    csrfToken,
  };

  const store = await cookies();
  store.set(COOKIE_NAME, seal(payload, configuration.SESSION_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure: configuration.APP_ENV !== 'development',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const payload = unseal<SessionPayload>(raw, env().SESSION_SECRET);
  if (!payload) return null;
  if (payload.expiresAt < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** The signed-in user, or null. Roles come from the database every time. */
export async function currentUser(): Promise<Principal | null> {
  const session = await readSession();
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { userRoles: true },
  });

  if (!user || !user.isActive) return null;

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.userRoles.map((row) => row.role as Role),
  };
}

export async function requireUser(): Promise<Principal> {
  const user = await currentUser();
  if (!user) throw new PermissionError('You must sign in to continue.');
  return user;
}

export async function requirePermission(permission: Permission): Promise<Principal> {
  const user = await requireUser();
  if (!can(user, permission)) {
    throw new PermissionError(`Your role does not permit this action (${permission}).`);
  }
  return user;
}

/**
 * The page equivalent of `requirePermission`.
 *
 * A server action or an API route should throw: the caller is code, and a 403
 * is the answer it needs. A page is read by a person, and throwing there means
 * the route error boundary renders "Something went wrong" with a reference
 * number — indistinguishable from a crash, and useless to the person reading
 * it. So this reports the decision instead of raising it, and the page renders
 * `<AccessDenied>`.
 */
export async function pageAccess(
  permission: Permission,
): Promise<{ allowed: true; user: Principal } | { allowed: false; user: Principal | null }> {
  const user = await currentUser();
  if (user && can(user, permission)) return { allowed: true, user };
  return { allowed: false, user };
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * Server Actions are same-origin by construction, and Next.js verifies the
 * Origin header for them. This adds a defence-in-depth token check for the
 * mutating actions, bound to the session.
 */
export async function sessionCsrfToken(): Promise<string | null> {
  const session = await readSession();
  return session?.csrfToken ?? null;
}

export async function assertCsrf(token: string | undefined | null): Promise<void> {
  const expected = await sessionCsrfToken();
  if (!expected || !token || token !== expected) {
    throw new PermissionError('This request could not be verified. Please reload the page and try again.');
  }
}

export async function requestContext(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const headerList = await headers();
  const forwarded = headerList.get('x-forwarded-for');
  return {
    ipAddress: forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null,
    userAgent: headerList.get('user-agent'),
  };
}
