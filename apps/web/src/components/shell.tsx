import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Principal } from '@element/shared';

/**
 * Application shell.
 *
 * Desktop-first but responsive. The Test Mode banner is permanent and
 * unmissable whenever Test Mode is active.
 */

export interface NavItem {
  href: string;
  label: string;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', description: 'What needs attention today' },
  { href: '/engagements', label: 'Engagements', description: 'All engagement letters' },
  { href: '/review-queue', label: 'Review Queue', description: 'Drafts waiting for you' },
  { href: '/cover-letters', label: 'Cover Letters', description: 'Completion cover letters' },
  { href: '/needs-attention', label: 'Needs Attention', description: 'Blocked or failed work' },
  { href: '/bulk-rollout', label: 'Bulk Rollout', description: 'Annual rollout' },
  { href: '/templates', label: 'Templates', description: 'Approved master templates' },
  { href: '/pricing-rules', label: 'Pricing Rules', description: 'Fee increase policy' },
  { href: '/date-rules', label: 'Date Rules', description: 'Deadline calculation' },
  { href: '/integrations', label: 'Integrations', description: 'Karbon and Adobe Sign' },
  { href: '/users', label: 'Users and Roles', description: 'Access control' },
  { href: '/audit-log', label: 'Audit Log', description: 'Immutable history' },
  { href: '/system-jobs', label: 'System Jobs', description: 'Background processing' },
  { href: '/settings', label: 'Settings', description: 'System configuration' },
];

export function TestModeBanner({ banner }: { banner: string | null }): ReactNode {
  if (!banner) return null;

  const isTestMode = banner.startsWith('TEST MODE');

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        isTestMode
          ? 'sticky top-0 z-50 border-b-2 border-amber-500 bg-amber-100 px-4 py-2 text-center text-sm font-semibold text-amber-900'
          : 'sticky top-0 z-50 border-b-2 border-slate-400 bg-slate-200 px-4 py-2 text-center text-sm font-semibold text-slate-800'
      }
    >
      {banner}
    </div>
  );
}

export function Shell({
  user,
  productName,
  banner,
  children,
}: {
  user: Principal | null;
  productName: string;
  banner: string | null;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="min-h-screen">
      <TestModeBanner banner={banner} />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to main content
      </a>

      <div className="flex min-h-screen flex-col lg:flex-row">
        <nav aria-label="Main" className="border-b border-slate-200 bg-white lg:w-64 lg:border-b-0 lg:border-r">
          <div className="px-5 py-4">
            <Link href="/" className="text-lg font-semibold text-brand-700">
              {productName}
            </Link>
            <p className="mt-1 text-xs text-slate-500">Engagement letters and completion cover letters</p>
          </div>

          <ul className="flex flex-wrap gap-1 px-3 pb-4 lg:flex-col lg:gap-0">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex-1">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
            <div />
            <div className="text-sm">
              {user ? (
                <div className="flex items-center gap-3">
                  <span className="text-slate-700">
                    {user.displayName}
                    <span className="ml-2 text-xs text-slate-500">{user.roles.join(', ')}</span>
                  </span>
                  <form action="/api/auth/sign-out" method="post">
                    <button type="submit" className="btn-secondary">
                      Sign out
                    </button>
                  </form>
                </div>
              ) : (
                <Link href="/sign-in" className="btn-primary">
                  Sign in
                </Link>
              )}
            </div>
          </header>

          <main id="main" className="px-6 py-6">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}

const STATUS_TONES: Record<string, string> = {
  NEEDS_ATTENTION: 'bg-red-100 text-red-800',
  GENERATION_FAILED: 'bg-red-100 text-red-800',
  DECLINED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-orange-100 text-orange-800',
  CHANGES_REQUESTED: 'bg-orange-100 text-orange-800',
  COVER_LETTER_CHANGES_REQUESTED: 'bg-orange-100 text-orange-800',
  REVIEW_REQUIRED: 'bg-amber-100 text-amber-800',
  COVER_LETTER_REVIEW_REQUIRED: 'bg-amber-100 text-amber-800',
  IN_REVIEW: 'bg-blue-100 text-blue-800',
  COVER_LETTER_IN_REVIEW: 'bg-blue-100 text-blue-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  COVER_LETTER_APPROVED: 'bg-emerald-100 text-emerald-800',
  SIGNED: 'bg-emerald-100 text-emerald-800',
  COMPLETE: 'bg-emerald-100 text-emerald-800',
  READY_FOR_DELIVERY: 'bg-emerald-100 text-emerald-800',
};

export function StatusBadge({ status }: { status: string }): ReactNode {
  const tone = STATUS_TONES[status] ?? 'bg-slate-100 text-slate-700';
  return (
    <span className={`badge ${tone}`} title={status}>
      {status.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

export function EmptyState({ message }: { message: string }): ReactNode {
  return <p className="rounded border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">{message}</p>;
}
