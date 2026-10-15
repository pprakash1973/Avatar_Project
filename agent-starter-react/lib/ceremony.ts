// Award ceremony mode: shared types, defaults and on-device storage.
// The award list and the slides stay on the host laptop; the list is sent to
// Tina only when the ceremony starts.
import type { LanguageCode } from '@/lib/agent-channels';

export const CEREMONY_AWARDS_TOPIC = 'ceremony-awards';

export type Award = {
  category: string;
  winner: string;
  /** Exactly what Tina says, word-for-word. */
  script: string;
  /** 1-based slide number shown while announcing. */
  slide: number;
};

export type CeremonySettings = {
  /** With several winners in a category: ask the host first, or continue after a pause. */
  multi_winner: 'ask' | 'auto';
  pause_seconds: number;
  /** What Tina says as soon as she joins; {name} is the host's name. */
  greeting: string;
  /** Read word-for-word when the host asks for the welcome note. */
  welcome_note: string;
  /** Languages the greeting is spoken in, in order; English uses `greeting` itself. */
  greeting_languages: LanguageCode[];
  /** The greeting in the other languages; an empty one is translated when Tina joins. */
  greeting_translations: Translations;
  welcome_languages: LanguageCode[];
  welcome_translations: Translations;
  /** Say e.g. "Congratulations, Soumya!" after every winner's announcement. */
  congratulate: boolean;
  /** {winner} is replaced by the winner's name. */
  congratulations: string;
  /** A grey audience stands and claps on screen after each winner. */
  celebrate: boolean;
  /** Phrases the host can say (without "Tina") to control her. */
  keywords: Keyword[];
  /** Written name -> how Tina should say it (speech only; slides keep the real spelling). */
  pronunciations: Pronunciation[];
  /** When the settings were last saved (ms); the newer copy wins between devices. */
  saved_at?: number;
};

export type Translations = Partial<Record<LanguageCode, string>>;

export type KeywordAction = 'repeat' | 'hold' | 'continue';
export type Keyword = { phrase: string; action: KeywordAction };

export const KEYWORD_ACTIONS: { code: KeywordAction; label: string }[] = [
  { code: 'repeat', label: 'Repeat the last announcement or sentence' },
  { code: 'hold', label: 'Hold: wait silently until told to continue' },
  { code: 'continue', label: 'Continue after a hold' },
];

/** What Tina says after a winner's announcement ('' when turned off or no winner). */
export const congratulationsFor = (settings: CeremonySettings, winner: string) =>
  settings.congratulate && winner.trim()
    ? settings.congratulations.replaceAll('{winner}', winner.trim())
    : '';

/** An award's announcement as Tina says it, including the congratulations. */
export const announcementFor = (settings: CeremonySettings, award: Award) =>
  [award.script.trim(), congratulationsFor(settings, award.winner)].filter(Boolean).join(' ');

export type Pronunciation = { written: string; spoken: string };

/** Text as Tina will say it: names replaced by their spoken spelling (whole words only). */
export function spokenText(text: string, pronunciations: Pronunciation[]) {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...pronunciations]
    .filter((p) => p.written.trim() && p.spoken.trim())
    .sort((a, b) => b.written.length - a.written.length)
    .reduce(
      (out, p) =>
        out.replace(new RegExp(`\\b${escape(p.written.trim())}\\b`, 'gi'), p.spoken.trim()),
      text
    );
}

export const DEFAULT_SETTINGS: CeremonySettings = {
  multi_winner: 'ask',
  pause_seconds: 8,
  greeting: 'Hi {name}, good day! I am happy to be your co-host.',
  welcome_note:
    'Good evening, esteemed UST leaders and dear colleagues. A warm welcome to the PACS Annual ' +
    'Rewards and Recognition Ceremony. We sincerely thank our leaders for taking time out of their ' +
    'busy schedules to join us. Your presence and continued support make this occasion truly ' +
    'special. Let us celebrate excellence and achievement together!',
  greeting_languages: ['en'],
  greeting_translations: {},
  welcome_languages: ['en'],
  welcome_translations: {},
  congratulate: true,
  congratulations: 'Congratulations, {winner}!',
  celebrate: true,
  keywords: [
    { phrase: 'please repeat', action: 'repeat' },
    { phrase: 'repeat that', action: 'repeat' },
    { phrase: 'please hold', action: 'hold' },
    { phrase: 'hold on', action: 'hold' },
    { phrase: 'continue', action: 'continue' },
  ],
  pronunciations: [
    { written: 'Soumya', spoken: 'Sow-mya' },
    { written: 'Kalpalatha', spoken: 'Kalpa-latha' },
  ],
};

export type ExtractedAward = {
  category: string;
  winner: string;
  citation: string;
  slide: number;
};

// Slide text keeps its line breaks; collapse them so the script reads as one passage.
export const defaultScript = (a: ExtractedAward) =>
  [`The award for ${a.category} goes to ${a.winner}.`, a.citation]
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');

const AWARDS_KEY = 'avatar.ceremony.awards';
const SETTINGS_KEY = 'avatar.ceremony.settings';
const OLD_DEFAULT_GREETING =
  "Hello everyone! I'm Tina, and I'm delighted to be your co-host today. Whenever you're ready, just call my name.";

export const greetingFor = (greeting: string, hostName: string) =>
  greeting.replaceAll('{name}', hostName.trim() || 'everyone');

export function loadSettings(): CeremonySettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    const saved = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    // Earlier versions saved a greeting without the host's name; use the new default.
    if (saved.greeting === OLD_DEFAULT_GREETING) {
      saved.greeting = DEFAULT_SETTINGS.greeting;
    }
    return saved;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: CeremonySettings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not persisted; still used for this ceremony.
  }
}

/** Saves the settings on this laptop and on the server, so another laptop gets them too. */
export async function saveSettingsEverywhere(
  settings: CeremonySettings
): Promise<CeremonySettings> {
  const stamped = { ...settings, saved_at: Date.now() };
  saveSettings(stamped);
  const response = await fetch('/api/ceremony/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stamped),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return stamped;
}

/** The server copy of the settings, or null if there is none or it can't be reached. */
export async function loadServerSettings(): Promise<CeremonySettings | null> {
  try {
    const response = await fetch('/api/ceremony/settings', { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const saved = (await response.json()) as Partial<CeremonySettings> | null;
    return saved ? { ...DEFAULT_SETTINGS, ...saved } : null;
  } catch {
    return null;
  }
}
const DB_NAME = 'avatar-ceremony';
const STORE = 'files';
const PDF_KEY = 'deck';

export function loadAwards(): Award[] {
  try {
    const raw = window.localStorage.getItem(AWARDS_KEY);
    return raw ? (JSON.parse(raw) as Award[]) : [];
  } catch {
    return [];
  }
}

export function saveAwards(awards: Award[]) {
  try {
    window.localStorage.setItem(AWARDS_KEY, JSON.stringify(awards));
  } catch {
    // Not persisted; still usable for this session.
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Keeps the deck in the browser so a page reload doesn't lose it. */
export async function saveDeck(file: Blob): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(file, PDF_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Storage unavailable: the deck must be re-uploaded after a reload.
  }
}

export async function loadDeck(): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(PDF_KEY);
      request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}
