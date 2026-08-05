'use client';

/** Last-resort boundary, used when the root layout itself fails to render. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
        <h1>Element Engagements is temporarily unavailable</h1>
        <p>The application could not start a page. An administrator should check the service logs and the database.</p>
        {error.digest ? <p style={{ fontFamily: 'monospace' }}>Reference: {error.digest}</p> : null}
      </body>
    </html>
  );
}
