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
      'These are the slides of an award ceremony deck (text per slide, each followed by an ' +
      'image of the slide when available). List every award that is presented: the award ' +
      'category (usually the slide title), the winner (person or team name exactly as ' +
      'written), the citation and the number of the slide that announces the winner.\n\n' +
      'Some slides show two people: the winner and a testimonial giver (a client or leader ' +
      'who praises the winner). The winner is the person with the SMALLER photo. The ' +
      'testimonial giver has the LARGER photo, usually with a job title and company under ' +
      'their name, and is the one quoted or who signs the message. Never give the ' +
      'testimonial giver as the winner. If there are no photos, the winner is the person the ' +
      'quote or message is about. People whose photos are about the same size (for example ' +
      'a team slide, or two small photos next to each other) are all winners: list every ' +
      'one of them, in reading order (left to right, top to bottom).\n\n' +
      'The citation is the short headline or tagline about the achievement (for example ' +
      '"Turning Ambiguity into Clear Business Decisions"), copied word-for-word, without ' +
      'the testimonial quote or letter; use an empty string if there is none.\n\n' +
      'If an award has several winners, list each winner as a separate entry with the same ' +
      'category and the same citation, in the order they are presented, with the slide ' +
      'for that winner. ' +
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
