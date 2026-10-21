import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

// What the ceremony page saw go wrong (its LiveKit disconnect reason, reconnects, page
// errors), kept next to Tina's own call records to explain a dropped call.
// Protected by the admin password (middleware.ts).

const KEY = 'client_events';
const MAX_EVENTS = 500;
const MAX_BYTES = 2_000;

export async function POST(req: Request) {
  if (!redis) {
    return new NextResponse(null, { status: 204 });
  }
  const body = await req.text();
  if (body.length > MAX_BYTES) {
    return new NextResponse('Too large.', { status: 413 });
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return new NextResponse('Invalid event.', { status: 400 });
  }
  await redis.lpush(
    KEY,
    JSON.stringify({
      at: new Date().toISOString(),
      room: String(event.room ?? '').slice(0, 100),
      event: String(event.event ?? '').slice(0, 60),
      detail: String(event.detail ?? '').slice(0, 500),
      browser: (req.headers.get('user-agent') ?? '').slice(0, 160),
    })
  );
  await redis.ltrim(KEY, 0, MAX_EVENTS - 1);
  return new NextResponse(null, { status: 204 });
}
