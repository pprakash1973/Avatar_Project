import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

const MAX_BODY_BYTES = 20_000;
const MAX_RECORDS = 200;

/** Stores call-attempt timelines posted by hooks/useCallDiagnostics.ts. */
export async function POST(req: Request) {
  const body = await req.text();
  if (!redis || body.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 204 });
  }
  try {
    const record = JSON.parse(body);
    record.received_at = new Date().toISOString();
    await redis.lpush('diagnostics', JSON.stringify(record));
    await redis.ltrim('diagnostics', 0, MAX_RECORDS - 1);
  } catch (error) {
    console.error('could not store diagnostics', error);
  }
  return new NextResponse(null, { status: 204 });
}
