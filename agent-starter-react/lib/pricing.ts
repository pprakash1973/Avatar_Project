// Estimated list prices used by the /admin dashboard. Free-tier allowances are not
// subtracted, so totals overstate what you're actually billed while on free plans.
// Checked October 2026 — update these when your plans or provider prices change.
export const PRICING = {
  // Claude Sonnet 5.5 (main conversation), $ per million tokens
  sonnetInputPerM: 2.0,
  sonnetCachedInputPerM: 0.2,
  sonnetOutputPerM: 10.0,
  // Claude Haiku 5.5 (web search, file reading, memory), $ per million tokens
  haikuInputPerM: 0.1,
  haikuOutputPerM: 0.5,
  // Claude web search tool, $ per search request
  webSearchPerRequest: 0.01,
  // Deepgram Nova-3 streaming STT, $ per minute (list price; promos may be lower)
  deepgramPerMinute: 0.0077,
  // Cartesia Sonic-3 TTS, $ per character (Pro plan overage)
  cartesiaPerChar: 0.000065,
  // Avatar, $ per minute: Simli pay-as-you-go, Anam Starter plan overage
  simliPerMinute: 0.05,
  anamPerMinute: 0.16,
  // LiveKit Cloud agent session, $ per minute
  livekitPerMinute: 0.01,
} as const;

export type CallRecord = {
  id: string;
  room: string;
  name: string;
  visitor_id: string;
  language: string;
  avatar_provider?: 'simli' | 'anam';
  started_at: string;
  status: 'ok' | 'busy';
  duration_s: number;
  searches?: number;
  web_search_requests?: number;
  files?: number;
  llm_input_tokens?: number;
  llm_cached_input_tokens?: number;
  llm_output_tokens?: number;
  stt_seconds?: number;
  tts_characters?: number;
  helper_input_tokens?: number;
  helper_output_tokens?: number;
};

export type CostBreakdown = {
  claude: number;
  webSearch: number;
  deepgram: number;
  cartesia: number;
  avatar: number;
  livekit: number;
  total: number;
};

export function estimateCost(call: CallRecord): CostBreakdown {
  const p = PRICING;
  const minutes = call.duration_s / 60;
  const cached = call.llm_cached_input_tokens ?? 0;
  const uncached = Math.max((call.llm_input_tokens ?? 0) - cached, 0);
  const claude =
    (uncached * p.sonnetInputPerM +
      cached * p.sonnetCachedInputPerM +
      (call.llm_output_tokens ?? 0) * p.sonnetOutputPerM +
      (call.helper_input_tokens ?? 0) * p.haikuInputPerM +
      (call.helper_output_tokens ?? 0) * p.haikuOutputPerM) /
    1_000_000;
  const webSearch = (call.web_search_requests ?? 0) * p.webSearchPerRequest;
  const deepgram = ((call.stt_seconds ?? 0) / 60) * p.deepgramPerMinute;
  const cartesia = (call.tts_characters ?? 0) * p.cartesiaPerChar;
  // Calls recorded before the Simli switch carry no provider and used Anam.
  const avatar = minutes * (call.avatar_provider === 'simli' ? p.simliPerMinute : p.anamPerMinute);
  const livekit = minutes * p.livekitPerMinute;
  return {
    claude,
    webSearch,
    deepgram,
    cartesia,
    avatar,
    livekit,
    total: claude + webSearch + deepgram + cartesia + avatar + livekit,
  };
}
