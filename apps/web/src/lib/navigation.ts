import { can, type Permission, type Principal } from '@element/shared';

/**
 * The main navigation.
 *
 * Data rather than markup, so what a given role is offered can be asserted
 * without rendering anything.
 */

export interface NavItem {
  href: string;
  label: string;
  description: string;
  /**
   * The permission the destination refuses without. Absent means the page
   * admits any signed-in user and decides for itself what to show them.
   *
   * Offering a link that cannot be opened is not a cosmetic fault: it is the
   * application inviting somebody somewhere and then refusing them, which
   * reads as a broken page rather than as an access decision.
   */
  permission?: Permission;
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
  { href: '/audit-log', label: 'Audit Log', description: 'Immutable history', permission: 'audit:view' },
  { href: '/system-jobs', label: 'System Jobs', description: 'Background processing' },
  { href: '/settings', label: 'Settings', description: 'System configuration' },
];

/**
 * The navigation a given principal can actually use.
 *
 * Anonymous visitors see nothing: every destination requires a session, and the
 * dashboard already asks them to sign in.
 */
export function navigationFor(user: Principal | null): NavItem[] {
  if (!user) return [];
  return NAV_ITEMS.filter((item) => item.permission === undefined || can(user, item.permission));
}
