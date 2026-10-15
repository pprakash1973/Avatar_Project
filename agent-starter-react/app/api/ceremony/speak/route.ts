import { NextResponse } from 'next/server';

// Speaks a short text in one of Tina's voices so the operator can check name
// pronunciations before the ceremony. Protected by the admin password (middleware.ts).

const MAX_CHARS = 800;

// Same voices as VOICES in voice-avatar-assistant/src/agent.py.
const VOICE_IDS: Record<string, string> = {
  priya: 'f6141af3-5f94-418c-80ed-a45d450e7e2e',
  janvi: '7ea5e9c2-b719-4dc3-b870-5ba5f14d31d8',
  kiara: 'f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d',
  simi: '3b554273-4299-48b9-9aaf-eefd438e3941',
  katie: 'f786b574-daa5-4673-aa0c-cbe3e8534c02',
};

export async function POST(req: Request) {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    return new NextResponse('CARTESIA_API_KEY is not configured.', { status: 503 });
  }
  const { text, voice, language } = (await req.json()) as {
    text?: string;
    voice?: string;
    language?: string;
  };
  const lang = ['en', 'hi', 'ta', 'ml'].includes(language ?? '') ? language! : 'en';
  if (!text?.trim() || text.length > MAX_CHARS) {
    return new NextResponse(`Text must be 1-${MAX_CHARS} characters.`, { status: 400 });
  }

  const response = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Cartesia-Version': '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // Malayalam needs Sonic 3.6, as in make_tts in the agent.
      model_id: lang === 'ml' ? 'sonic-3.6' : 'sonic-3',
      transcript: text,
      voice: { mode: 'id', id: VOICE_IDS[voice ?? ''] ?? VOICE_IDS.priya },
      language: lang,
      output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 96000 },
    }),
  });
  if (!response.ok) {
    return new NextResponse(`Voice service error: ${await response.text()}`, { status: 502 });
  }
  return new NextResponse(await response.arrayBuffer(), {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
  });
}
