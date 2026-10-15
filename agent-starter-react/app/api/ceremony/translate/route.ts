import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

// Translates the greeting or welcome note for Tina to speak in other languages.
// The operator reviews the result before the ceremony. Protected by the admin
// password (middleware.ts).

export const maxDuration = 60;

const MODEL = 'claude-sonnet-5-5';
const MAX_CHARS = 2000;
const LANGUAGE_NAMES: Record<string, string> = { hi: 'Hindi', ta: 'Tamil', ml: 'Malayalam' };

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new NextResponse('ANTHROPIC_API_KEY is not configured.', { status: 503 });
  }
  const { text, languages } = (await req.json()) as { text?: string; languages?: string[] };
  const wanted = (languages ?? []).filter((code) => code in LANGUAGE_NAMES);
  if (!text?.trim() || text.length > MAX_CHARS || wanted.length === 0) {
    return new NextResponse('Expected the text and at least one language.', { status: 400 });
  }

  const schema = {
    type: 'object',
    properties: Object.fromEntries(wanted.map((code) => [code, { type: 'string' }])),
    required: wanted,
    additionalProperties: false,
  };
  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [
        {
          role: 'user',
          content:
            'Translate this text, spoken aloud by a warm, formal co-host at a corporate award ' +
            'ceremony in India, into ' +
            wanted.map((code) => `${LANGUAGE_NAMES[code]} (key "${code}")`).join(', ') +
            '. Use natural, respectful spoken language in the native script. Keep personal ' +
            'names, company names and placeholders such as {name} exactly as they are.\n\n' +
            `<text>\n${text}\n</text>`,
        },
      ],
    });
    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') {
      return new NextResponse('No translation returned.', { status: 502 });
    }
    return NextResponse.json(JSON.parse(block.text));
  } catch (error) {
    console.error('translation failed', error);
    const message = error instanceof Anthropic.APIError ? error.message : 'Translation failed.';
    return new NextResponse(message, { status: 502 });
  }
}
