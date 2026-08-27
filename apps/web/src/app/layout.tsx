import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { env, productBranding } from '@element/shared';
import { container } from '@/lib/container';
import { currentUser } from '@/lib/session';
import { Shell } from '@/components/shell';
import { THEME_COOKIE, readTheme, themeAttribute } from '@/lib/theme';
import './globals.css';

/**
 * Nothing in this application is safe to statically prerender: every page
 * reflects live workflow state, and the shell itself reads Test Mode.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const name = await container.settings.productName(env().APP_NAME).catch(() => env().APP_NAME);
  return {
    title: { default: name, template: `%s · ${name}` },
    description: 'Engagement letters, completion cover letters, review, approval and signing.',
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  const configuration = env();

  // Read here rather than in a client component, and this is the whole point of
  // keeping it in a cookie: the attribute is in the HTML the browser receives,
  // so the first painted frame is already the right theme. A theme applied
  // after hydration means every load of a dark-mode app starts white.
  const theme = readTheme((await cookies()).get(THEME_COOKIE)?.value);

  // The layout must render even when the database is unreachable, so the
  // operator sees a useful page rather than a stack trace.
  const [user, state, productName] = await Promise.all([
    currentUser().catch(() => null),
    container.testModeState().catch(() => ({
      testMode: true,
      productionSendingEnabled: false,
      banner: 'The database is unreachable. The application is read-only until it recovers.',
    })),
    container.settings.productName(configuration.APP_NAME).catch(() => configuration.APP_NAME),
  ]);

  // Counted here so the badge appears on every page. Bounded, and tolerant of
  // an unreachable database for the same reason the rest of this is.
  const unreadNotifications = user
    ? await container.userNotifications.unreadCount(user.id).catch(() => 0)
    : 0;

  return (
    // No attribute at all for "system", which is what lets
    // `prefers-color-scheme` decide. See `themeAttribute`.
    <html lang="en" data-theme={themeAttribute(theme) ?? undefined}>
      <body>
        <Shell
          user={user}
          productName={productBranding(productName).name}
          banner={state.banner}
          unreadNotifications={unreadNotifications}
          theme={theme}
        >
          {children}
        </Shell>
      </body>
    </html>
  );
}
