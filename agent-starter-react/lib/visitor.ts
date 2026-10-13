// Per-browser preferences. The visitor id lets the agent remember this browser
// across calls; storage can be unavailable (private mode), so every access is guarded.

const VISITOR_ID_KEY = 'avatar.visitorId';
const NAME_KEY = 'avatar.name';
const LANGUAGE_KEY = 'avatar.language';
const STYLE_KEY = 'avatar.style';
const ADAPT_KEY = 'avatar.adapt';
const MICROPHONE_KEY = 'avatar.microphone';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted; the app still works for this visit.
  }
}

export function getVisitorId(): string {
  let id = read(VISITOR_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    write(VISITOR_ID_KEY, id);
  }
  return id;
}

export const getSavedName = () => read(NAME_KEY) ?? '';
export const saveName = (name: string) => write(NAME_KEY, name);
export const getSavedLanguage = () => read(LANGUAGE_KEY);
export const saveLanguage = (language: string) => write(LANGUAGE_KEY, language);
export const getSavedStyle = () => read(STYLE_KEY);
export const saveStyle = (style: string) => write(STYLE_KEY, style);
export const getSavedAdapt = () => read(ADAPT_KEY) !== '0';
export const saveAdapt = (adapt: boolean) => write(ADAPT_KEY, adapt ? '1' : '0');
export const getSavedMicrophoneId = () => read(MICROPHONE_KEY) ?? '';
export const saveMicrophoneId = (deviceId: string) => write(MICROPHONE_KEY, deviceId);
