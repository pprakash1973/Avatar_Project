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

export type AgentCard = SearchCard | FileCard | FileErrorCard;

export type AgentStatus = { type: 'busy' };

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'ta', label: 'தமிழ் (Tamil)' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
