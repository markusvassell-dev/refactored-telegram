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

/**
 * How long a session survives without activity.
 *
 * Four hours rather than a working day, deliberately. This is what an abandoned
 * browser on a shared desk is worth, and the sliding refresh below means an
 * active person never meets it. The old fixed eight hours was the worst of both:
 * long enough to matter if left unattended, and still capable of signing out a
 * reviewer part-way through a document.
 */
const IDLE_SECONDS = 4 * 60 * 60;

/**
 * The longest a session can live however active its owner.
 *
 * A session that slides forever is not a session. Twelve hours covers the
 * longest plausible working day and then ends.
 */
const ABSOLUTE_SECONDS = 12 * 60 * 60;

/**
 * Refresh only once a session is half-used.
 *
 * Rewriting the cookie on every action would be a Set-Cookie on every mutation
 * for no benefit; this makes it occasional while keeping an active session well
 * clear of expiry.
 *
 * The ratio to the idle window is what makes the sliding real. An idle window
 * close to the absolute cap would mean the cap binds on the first refresh and
 * the session never slides again — one extension wearing the name of many.
 */
const REFRESH_AFTER_SECONDS = IDLE_SECONDS / 2;

interface SessionPayload {
  userId: string;
  /** When the session first began. The absolute cap is measured from here. */
  issuedAt: number;
  expiresAt: number;
  /** Bound to the CSRF token issued with the session. */
  csrfToken: string;
}

export async function createSession(userId: string, csrfToken: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await writeSession({ userId, issuedAt: now, expiresAt: now + IDLE_SECONDS, csrfToken });
}

async function writeSession(payload: SessionPayload): Promise<void> {
  const configuration = env();
  const store = await cookies();

  store.set(COOKIE_NAME, seal(payload, configuration.SESSION_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure: configuration.APP_ENV !== 'development',
    path: '/',
    maxAge: Math.max(0, payload.expiresAt - Math.floor(Date.now() / 1000)),
  });
}

/**
 * Extends the current session, if it is live and not past its absolute cap.
 *
 * Called from the server-action wrapper rather than from page rendering,
 * because a Server Component cannot set a cookie — Next.js permits that only in
 * a Server Action, a Route Handler or middleware, and middleware here runs on
 * the Edge runtime, which cannot open the cookie at all (`seal` is AES-256-GCM
 * from `node:crypto`).
 *
 * Acting is what keeps a session alive, then — editing a field, saving a
 * comment, approving a document. Someone who reads pages for eight hours and
 * touches nothing is signed out, which is the behaviour the idle window
 * describes anyway.
 *
 * Returns quietly rather than throwing: failing to extend a session must never
 * fail the action the person actually asked for.
 */
export async function extendSession(): Promise<void> {
  const session = await readSession();
  if (!session) return;

  const now = Math.floor(Date.now() / 1000);

  if (session.issuedAt + ABSOLUTE_SECONDS <= now) return;
  if (session.expiresAt - now > REFRESH_AFTER_SECONDS) return;

  // Never past the absolute cap, however long the idle window would allow.
  const expiresAt = Math.min(now + IDLE_SECONDS, session.issuedAt + ABSOLUTE_SECONDS);
  await writeSession({ ...session, expiresAt });
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

  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt < now) return null;
  // The cap is enforced on read as well as on refresh, so a cookie that somehow
  // carries a later expiry than the cap allows is still refused.
  if (payload.issuedAt + ABSOLUTE_SECONDS <= now) return null;
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
