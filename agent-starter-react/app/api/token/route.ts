import { NextResponse } from 'next/server';
import {
  AccessToken,
  type AccessTokenOptions,
  RoomConfiguration,
  type VideoGrant,
} from 'livekit-server-sdk';
import { redis } from '@/lib/redis';

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

// NOTE: you are expected to define the following environment variables in `.env.local`:
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

// don't cache the results
export const revalidate = 0;

const CALLS_PER_HOUR = Number(process.env.RATE_LIMIT_CALLS_PER_HOUR ?? 5);
// A single call can fetch several tokens; requests within this window count once.
const SAME_CALL_WINDOW_SECONDS = 30;
const LANGUAGE_CODES = new Set(['en', 'hi', 'ta', 'ml']);
const STYLE_CODES = new Set(['friendly', 'professional', 'concise', 'humorous']);
const VISITOR_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
// connection_check_ rooms come from the connection test and carry no agent dispatch.
const ROOM_NAME_RE = /^(voice_assistant_room|connection_check)_[A-Za-z0-9-]{8,64}$/;

function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

/** Returns true when this IP has started too many calls in the last hour. */
async function isRateLimited(ip: string): Promise<boolean> {
  if (!redis || !(CALLS_PER_HOUR > 0)) {
    return false;
  }
  try {
    const isNewCall = await redis.set(`ratelimit:recent:${ip}`, 1, {
      nx: true,
      ex: SAME_CALL_WINDOW_SECONDS,
    });
    const key = `ratelimit:calls:${ip}`;
    if (!isNewCall) {
      return Number((await redis.get(key)) ?? 0) > CALLS_PER_HOUR;
    }
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 60 * 60);
    }
    return count > CALLS_PER_HOUR;
  } catch (error) {
    // Never block calls because the database is unavailable.
    console.error('rate limit check failed', error);
    return false;
  }
}

export async function POST(req: Request) {
  // make an exception for the vercel preview environment
  if (process.env.NODE_ENV !== 'development' && process.env.IS_VERCEL_PREVIEW !== 'true') {
    throw new Error(
      'THIS API ROUTE IS INSECURE. DO NOT USE THIS ROUTE IN PRODUCTION WITHOUT AN AUTHENTICATION LAYER.'
    );
  }

  try {
    if (LIVEKIT_URL === undefined) {
      throw new Error('LIVEKIT_URL is not defined');
    }
    if (API_KEY === undefined) {
      throw new Error('LIVEKIT_API_KEY is not defined');
    }
    if (API_SECRET === undefined) {
      throw new Error('LIVEKIT_API_SECRET is not defined');
    }

    if (await isRateLimited(clientIp(req))) {
      return new NextResponse(
        `You've reached the limit of ${CALLS_PER_HOUR} calls per hour. Please try again later.`,
        { status: 429 }
      );
    }

    // Parse room config from request body.
    const body = await req.json();
    const roomConfig = body?.room_config
      ? RoomConfiguration.fromJson(body.room_config, { ignoreUnknownFields: true })
      : new RoomConfiguration();

    // Generate participant token. The agent greets the user by this name.
    const participantName =
      typeof body?.participant_name === 'string' ? body.participant_name.trim().slice(0, 50) : '';
    // The agent reads these to pick the language and to remember this browser.
    const requested = body?.participant_attributes ?? {};
    const attributes: Record<string, string> = {
      language: LANGUAGE_CODES.has(requested.language) ? requested.language : 'en',
      style: STYLE_CODES.has(requested.style) ? requested.style : 'friendly',
      adapt: requested.adapt === '0' ? '0' : '1',
    };
    // Ceremony mode (from /ceremony): Tina only answers when called by name.
    if (requested.mode === 'ceremony') {
      attributes.mode = 'ceremony';
      attributes.wake = '1';
    }
    if (typeof requested.visitor_id === 'string' && VISITOR_ID_RE.test(requested.visitor_id)) {
      attributes.visitor_id = requested.visitor_id;
    }
    const participantIdentity = `voice_assistant_user_${Math.floor(Math.random() * 10_000)}`;
    // The client picks a fresh room name per call; fall back to a random one.
    const roomName =
      typeof body?.room_name === 'string' && ROOM_NAME_RE.test(body.room_name)
        ? body.room_name
        : `voice_assistant_room_${crypto.randomUUID()}`;

    const participantToken = await createParticipantToken(
      { identity: participantIdentity, name: participantName, attributes },
      roomName,
      roomConfig
    );

    // Return connection details
    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL,
      roomName,
      participantName,
      participantToken,
    };
    const headers = new Headers({
      'Cache-Control': 'no-store',
    });
    return NextResponse.json(data, { headers });
  } catch (error) {
    if (error instanceof Error) {
      console.error(error);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  roomConfig: RoomConfiguration | undefined
): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    ...userInfo,
    ttl: '15m',
  });
  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };
  at.addGrant(grant);

  if (roomConfig) {
    at.roomConfig = roomConfig;
  }

  return at.toJwt();
}
