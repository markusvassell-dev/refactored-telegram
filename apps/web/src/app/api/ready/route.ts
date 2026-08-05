import { NextResponse } from 'next/server';
import { container } from '@/lib/container';

export const dynamic = 'force-dynamic';

/** Readiness: the process can serve traffic, including database access. */
export async function GET(): Promise<Response> {
  try {
    await container.prisma.$queryRaw`SELECT 1`;
    const state = await container.testModeState();
    return NextResponse.json({
      status: 'ready',
      database: 'ok',
      testMode: state.testMode,
      productionSendingEnabled: state.productionSendingEnabled,
    });
  } catch {
    return NextResponse.json({ status: 'not-ready', database: 'unreachable' }, { status: 503 });
  }
}
