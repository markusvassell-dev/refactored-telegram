'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * Shows a safe message. Technical detail stays in the server logs and the
 * audit trail; it is never rendered to a user, who may not be an administrator.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The digest correlates this screen with the server-side log entry.
    console.error('Route error', error.digest);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold text-slate-900">Something went wrong</h1>
      <p className="mt-2 text-sm text-slate-600">
        The action could not be completed. An administrator can find the technical details in the system logs.
      </p>
      {error.digest ? <p className="mt-1 font-mono text-xs text-slate-500">Reference: {error.digest}</p> : null}
      <button type="button" onClick={reset} className="btn-primary mt-4">Try again</button>
    </div>
  );
}
