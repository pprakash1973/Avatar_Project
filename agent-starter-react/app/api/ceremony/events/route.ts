import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

// Reads an MC script (its text) and returns the programme's events, each with the
// words the MC says to open it, for the operator to review.
// Protected by the admin password (see middleware.ts).

export const maxDuration = 60;

const MODEL = 'claude-sonnet-5-5';
const MAX_CHARS = 200_000;

const SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          script: { type: 'string' },
        },
        required: ['name', 'script'],
        additionalProperties: false,
      },
    },
  },
  required: ['events'],
  additionalProperties: false,
};

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new NextResponse('ANTHROPIC_API_KEY is not configured.', { status: 503 });
  }
  const { text } = (await req.json()) as { text: string };
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHARS) {
    return new NextResponse('Expected the script text (up to 200,000 characters).', {
      status: 400,
    });
  }

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // If the model declines, the API retries on a fallback model instead of failing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        {
          role: 'user',
          content:
            `<script>\n${text}\n</script>\n\n` +
            'This is the MC script of a corporate event. An AI co-host will take over some of ' +
            "the MC's lines: the host calls an event by its name and the co-host speaks its " +
            'text word-for-word. List the events in programme order.\n\n' +
            '- name: a short name the host can say, e.g. "Lamp Lighting", "Classical Solo", ' +
            '"Fashion Walk", "Dinner". Drop times, durations and numbering such as "Cultural 3:".\n' +
            "- script: the MC's spoken lines that open the event (welcomes, introductions, " +
            'invitations to the stage), copied word-for-word. Leave out stage cues, times and ' +
            'notes for the MC, and the thank-you lines after a performance.\n' +
            '- When one segment has several spoken moments separated by a cue (e.g. the lamp ' +
            'is lit, then a singer is invited; or several speakers in turn), make each moment ' +
            'its own event with a clear name, e.g. "Devotional Song", "Big Picture Speaker 2".\n' +
            '- Skip award presentations (the awards are announced separately) and anything ' +
            'with no spoken lines.\n' +
            '- Keep placeholders in square brackets, such as [Leader Name, Designation], ' +
            'exactly as written. Never invent names or text.',
        },
      ],
    });
    if (response.stop_reason === 'refusal') {
      return new NextResponse('The script could not be processed.', { status: 422 });
    }
    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') {
      return new NextResponse('No result from the model.', { status: 502 });
    }
    return NextResponse.json(JSON.parse(block.text));
  } catch (error) {
    console.error('event extraction failed', error);
    const message = error instanceof Anthropic.APIError ? error.message : 'Extraction failed.';
    return new NextResponse(message, { status: 502 });
  }
}
