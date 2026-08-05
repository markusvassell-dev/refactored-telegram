'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';
import type { ActionResult } from '@/app/actions';

/**
 * A form bound to a server action, with accessible inline feedback.
 * Blocking reasons are listed so a reviewer knows exactly what to fix.
 */

const INITIAL: ActionResult | null = null;

export function ActionForm({
  action,
  csrfToken,
  submitLabel,
  variant = 'primary',
  children,
  confirm,
  disabled,
  disabledReason,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  csrfToken: string;
  submitLabel: string;
  variant?: 'primary' | 'secondary' | 'danger';
  children?: ReactNode;
  confirm?: string;
  disabled?: boolean;
  disabledReason?: string;
}): ReactNode {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => action(formData),
    INITIAL,
  );

  const buttonClass =
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-secondary';

  return (
    <form
      action={formAction}
      className="space-y-3"
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      <input type="hidden" name="csrf" value={csrfToken} />
      {children}

      <div className="flex items-center gap-3">
        <button type="submit" className={buttonClass} disabled={pending || disabled}>
          {pending ? 'Working…' : submitLabel}
        </button>
        {disabled && disabledReason ? <span className="text-xs text-slate-500">{disabledReason}</span> : null}
      </div>

      {state ? (
        <div
          role="status"
          aria-live="polite"
          className={
            state.ok
              ? 'rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
              : 'rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800'
          }
        >
          <p>{state.message}</p>
          {state.blockers && state.blockers.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {state.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
