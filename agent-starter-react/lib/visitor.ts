// Per-browser preferences. The visitor id lets the agent remember this browser
// across calls; storage can be unavailable (private mode), so every access is guarded.

const VISITOR_ID_KEY = 'avatar.visitorId';
const NAME_KEY = 'avatar.name';
const LANGUAGE_KEY = 'avatar.language';

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
