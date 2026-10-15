import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

// The ceremony settings (greeting, welcome note, languages, keywords, pronunciations),
// kept on the server so a dry run on one laptop carries over to the ceremony laptop.
// Winners are not stored here: they stay on the laptop that prepared them.
// Protected by the admin password (middleware.ts).

const KEY = 'ceremony:settings';
const MAX_BYTES = 100_000;

export async function GET() {
  if (!redis) {
    return NextResponse.json(null);
  }
  return NextResponse.json((await redis.get(KEY)) ?? null, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function PUT(req: Request) {
  if (!redis) {
    return new NextResponse('No database is configured; saved on this laptop only.', {
      status: 503,
    });
  }
  const body = await req.text();
  if (body.length > MAX_BYTES) {
    return new NextResponse('Settings are too large.', { status: 413 });
  }
  let settings: unknown;
  try {
    settings = JSON.parse(body);
  } catch {
    return new NextResponse('Invalid settings.', { status: 400 });
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return new NextResponse('Invalid settings.', { status: 400 });
  }
  await redis.set(KEY, settings);
  return new NextResponse(null, { status: 204 });
}
