import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Liveness: the process is up. Deliberately does not touch the database. */
export async function GET(): Promise<Response> {
  return NextResponse.json({ status: 'ok', service: 'web', time: new Date().toISOString() });
}
