import { readBuildIdentity } from '@element/shared';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness: the process is up. Deliberately does not touch the database.
 *
 * It also reports which build is answering. "Is the fix deployed?" was
 * previously unanswerable without opening a shell, and getting it wrong meant
 * treating a stale container's failures as facts about a vendor's API.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({
    status: 'ok',
    service: 'web',
    time: new Date().toISOString(),
    build: readBuildIdentity(),
  });
}
