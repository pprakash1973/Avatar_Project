import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

// Reads the award slides (text, plus an image for slides with little text) and
// returns category / winner / citation / slide for the operator to review.
// Protected by the admin password (see middleware.ts).

export const maxDuration = 60;

const MODEL = 'claude-sonnet-5-5';
const MAX_PAGES = 120;

type PageInput = { page: number; text: string; image?: string };

const SCHEMA = {
  type: 'object',
  properties: {
    awards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          winner: { type: 'string' },
          citation: { type: 'string' },
          slide: { type: 'integer' },
        },
        required: ['category', 'winner', 'citation', 'slide'],
        additionalProperties: false,
      },
    },
  },
  required: ['awards'],
  additionalProperties: false,
};

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new NextResponse('ANTHROPIC_API_KEY is not configured.', { status: 503 });
  }
  const { pages } = (await req.json()) as { pages: PageInput[] };
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES) {
    return new NextResponse('Expected 1-120 pages.', { status: 400 });
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const page of pages) {
    content.push({ type: 'text', text: `<slide number="${page.page}">\n${page.text}\n</slide>` });
    if (page.image?.startsWith('data:image/jpeg;base64,')) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: page.image.slice('data:image/jpeg;base64,'.length),
        },
      });
    }
  }
  content.push({
    type: 'text',
    text:
      'These are the slides of an award ceremony deck (text per slide; images for slides ' +
      'whose text could not be read). List every award that is presented: the award ' +
      'category, the winner (person or team name exactly as written), the citation (the ' +
      'description of why they won, copied word-for-word from the slide, or an empty ' +
      'string if there is none), and the number of the slide that announces the winner. ' +
      'Skip title, agenda, thank-you and other non-award slides. Never invent names or text.',
  });

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // If the model declines, the API retries on a fallback model instead of failing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') {
      return new NextResponse('The slides could not be processed.', { status: 422 });
    }
    const text = response.content.find((block) => block.type === 'text');
    if (!text || text.type !== 'text') {
      return new NextResponse('No result from the model.', { status: 502 });
    }
    return NextResponse.json(JSON.parse(text.text));
  } catch (error) {
    console.error('award extraction failed', error);
    const message = error instanceof Anthropic.APIError ? error.message : 'Extraction failed.';
    return new NextResponse(message, { status: 502 });
  }
}
