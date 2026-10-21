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

// Azure voices, as AZURE_VOICES in the agent: Neerja HD speaks every language.
const AZURE_VOICES: Record<string, string> = { neerja: 'en-IN-Neerja:DragonHDLatestNeural' };
const AZURE_LANGUAGES: Record<string, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  ta: 'ta-IN',
  ml: 'ml-IN',
};

const escapeXml = (text: string) => text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** MP3 from Azure Speech, or null if it isn't configured or fails (Cartesia is used). */
async function azureSpeech(text: string, voice: string, lang: string) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    return null;
  }
  const xmlLang = AZURE_LANGUAGES[lang] ?? 'en-IN';
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}">` +
    `<voice name="${voice}"><lang xml:lang="${xmlLang}">${escapeXml(text)}</lang></voice></speak>`;
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      'User-Agent': 'tina-ceremony',
    },
    body: ssml,
  });
  if (!response.ok) {
    console.error('Azure speech failed', response.status, await response.text());
    return null;
  }
  return response.arrayBuffer();
}

export async function POST(req: Request) {
  const { text, voice, language } = (await req.json()) as {
    text?: string;
    voice?: string;
    language?: string;
  };
  const lang = ['en', 'hi', 'ta', 'ml'].includes(language ?? '') ? language! : 'en';
  if (!text?.trim() || text.length > MAX_CHARS) {
    return new NextResponse(`Text must be 1-${MAX_CHARS} characters.`, { status: 400 });
  }
  const azureVoice = AZURE_VOICES[voice ?? ''];
  const azureAudio = azureVoice ? await azureSpeech(text, azureVoice, lang) : null;
  if (azureAudio) {
    return new NextResponse(azureAudio, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  }
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    return new NextResponse('CARTESIA_API_KEY is not configured.', { status: 503 });
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
