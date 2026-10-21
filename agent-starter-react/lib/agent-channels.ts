// Data-stream topics shared with the Python agent (voice-avatar-assistant/src/agent.py).
export const FILE_UPLOAD_TOPIC = 'file-upload';
export const UI_CARD_TOPIC = 'ui-card';
export const UI_STATUS_TOPIC = 'ui-status';

export const MAX_UPLOAD_BYTES = 1_000_000;
export const UPLOAD_ACCEPT = '.pdf,.docx,.jpg,.jpeg,.png';

export type SearchCard = {
  type: 'search';
  query: string;
  answer: string;
  sources: { url: string; title: string }[];
};

export type FileCard = {
  type: 'file';
  name: string;
  title: string;
  summary: string;
  key_points: string[];
};

export type FileErrorCard = {
  type: 'file_error';
  name: string;
  reason: string;
};

export type TravelCard = {
  type: 'travel';
  kind: 'flights' | 'hotels' | 'trains' | 'buses';
  title: string;
  summary: string;
  options: { name: string; details: string; price: string; source_url: string }[];
  booking_links: { label: string; url: string }[];
  retrieved_at: string;
};

export type ItineraryCard = {
  type: 'itinerary';
  title: string;
  summary: string;
  days: { day: string; title: string; plan: string }[];
  budget: { item: string; amount: string }[];
  total_estimate: string;
  retrieved_at: string;
};

export type AgentCard = SearchCard | FileCard | FileErrorCard | TravelCard | ItineraryCard;

export type AgentStatus = { type: 'busy' } | { type: 'style'; style: StyleCode; adapt: boolean };

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'ta', label: 'தமிழ் (Tamil)' },
  { code: 'ml', label: 'മലയാളം (Malayalam)' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export const STYLES = [
  { code: 'friendly', label: 'Friendly' },
  { code: 'professional', label: 'Professional' },
  { code: 'concise', label: 'Concise' },
  { code: 'humorous', label: 'Humorous' },
] as const;

export type StyleCode = (typeof STYLES)[number]['code'];

// Tina's voices; keys match VOICES / AZURE_VOICES in voice-avatar-assistant/src/agent.py.
// Neerja HD is Azure (falls back to Priya); the others are Cartesia.
export const VOICES = [
  { code: 'neerja', label: 'Neerja HD', accent: 'Indian English' },
  { code: 'priya', label: 'Priya', accent: 'Indian English' },
  { code: 'janvi', label: 'Janvi', accent: 'Indian English' },
  { code: 'kiara', label: 'Kiara', accent: 'Indian English' },
  { code: 'simi', label: 'Simi', accent: 'Indian English' },
  { code: 'katie', label: 'Katie', accent: 'American English' },
] as const;

export type VoiceCode = (typeof VOICES)[number]['code'];
export const DEFAULT_VOICE: VoiceCode = 'neerja';
