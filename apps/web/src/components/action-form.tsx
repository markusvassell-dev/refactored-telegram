'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ActionResult } from '@/app/actions';

/**
 * A form bound to a server action, with accessible inline feedback.
 * Blocking reasons are listed so a reviewer knows exactly what to fix.
 */

const INITIAL: ActionResult | null = null;

/**
 * Puts back what the user typed after a rejected submission.
 *
 * React resets a form once its action completes, which is right after a
 * success and wrong after a failure: being told the year-end is missing and
 * simultaneously losing the client name, the tax year and everything else is
 * how a person gives up on a form. The submission is captured before React
 * resets it and restored when the answer comes back "no".
 */
function restore(form: HTMLFormElement, submitted: FormData): void {
  for (const element of Array.from(form.elements)) {
    const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (!field.name || field.type === 'hidden' || field.type === 'submit') continue;

    const values = submitted.getAll(field.name).filter((value): value is string => typeof value === 'string');

    if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
      field.checked = values.includes(field.value);
      continue;
    }

    const value = values[0];
    if (value !== undefined) field.value = value;
  }
}

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

  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef<FormData | null>(null);

  useEffect(() => {
    if (!state || state.ok || !formRef.current || !submitted.current) return;
    restore(formRef.current, submitted.current);
  }, [state]);

  const buttonClass =
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-secondary';

  return (
    <form
      ref={formRef}
      action={formAction}
      className="space-y-3"
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) {
          event.preventDefault();
          return;
        }
        // Captured before React resets the form on completion.
        submitted.current = new FormData(event.currentTarget);
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
