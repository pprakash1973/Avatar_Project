// Award ceremony mode: shared types, defaults and on-device storage.
// The award list and the slides stay on the host laptop; the list is sent to
// Tina only when the ceremony starts.
import type { LanguageCode } from '@/lib/agent-channels';

export const CEREMONY_AWARDS_TOPIC = 'ceremony-awards';
/** The stage tells Tina what media it plays: {type: 'media', kind, playing}. */
export const CEREMONY_EVENTS_TOPIC = 'ceremony-events';

export type Award = {
  category: string;
  winner: string;
  /** Exactly what Tina says, word-for-word. */
  script: string;
  /** 1-based slide number shown while announcing. */
  slide: number;
  /** Optional music link (YouTube / YouTube Music / audio file) played after this
   * winner's congratulations; otherwise the general walk-up music. */
  music?: string;
};

export type CeremonySettings = {
  /** Seconds between the winners of one category (all are announced together). */
  pause_seconds: number;
  /** Tina's first words, when the host first calls her; {name} is the host's name. */
  greeting: string;
  /** Read word-for-word when the host asks for the welcome note. */
  welcome_note: string;
  /** Languages the greeting is spoken in, in order; English uses `greeting` itself. */
  greeting_languages: LanguageCode[];
  /** The greeting in the other languages; an empty one is translated when Tina joins. */
  greeting_translations: Translations;
  welcome_languages: LanguageCode[];
  welcome_translations: Translations;
  /** Languages Tina understands and replies in (English always); she answers in the host's. */
  conversation_languages: LanguageCode[];
  /** Say e.g. "Congratulations, Soumya!" after every winner's announcement. */
  congratulate: boolean;
  /** {winner} is replaced by the winner's name. */
  congratulations: string;
  /** How Tina carries herself: a polished host (default) or a lively MC. */
  style: 'professional' | 'lively';
  /** Seconds of silence before Tina treats the host's request as finished. */
  listen_pause: number;
  /** Show the ovation photo (if one was uploaded) after each winner. */
  celebrate: boolean;
  /** "And the winner is...": the slide stays hidden until Tina says the name. */
  suspense: boolean;
  /** The dramatic pause before the name, in seconds. */
  suspense_seconds: number;
  /** Play the walk-up music (if one was uploaded) after each winner. */
  walkup: boolean;
  /** How long the music plays after the last winner of a category, in seconds. */
  walkup_seconds: number;
  /** Music volume, 0-1. */
  walkup_volume: number;
  /** General walk-up music link (YouTube / YouTube Music / audio file); the uploaded
   * file is used when this is empty. An announcement's own music link comes first. */
  walkup_url: string;
  /** Songs the host can ask for by name ("Tina, play Jai Ho"), e.g. during a break. */
  songs: Song[];
  /** Phrases the host can say (without "Tina") to control her. */
  keywords: Keyword[];
  /** Written name -> how Tina should say it (speech only; slides keep the real spelling). */
  pronunciations: Pronunciation[];
  /** When the settings were last saved (ms); the newer copy wins between devices. */
  saved_at?: number;
};

export type Song = { name: string; url: string };

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

/** The announcement split before the winner's name, for the suspense pause:
 * ["The award for X goes to", "Soumya Rao. ... Congratulations, Soumya!"]. */
export function announcementParts(settings: CeremonySettings, award: Award): [string, string] {
  const whole = announcementFor(settings, award);
  const name = award.winner.trim();
  const at = name ? award.script.toLowerCase().indexOf(name.toLowerCase()) : -1;
  if (at <= 0) {
    return ['', whole];
  }
  const rest = [award.script.slice(at), congratulationsFor(settings, award.winner)];
  return [award.script.slice(0, at).trim(), rest.filter(Boolean).join(' ')];
}

export type MusicSource =
  | { kind: 'youtube'; id: string; start: number }
  | { kind: 'audio'; url: string };

/** A playable music link: YouTube / YouTube Music (with an optional start time such as
 * &t=45 or ?t=1m5s), or a direct audio file. null for anything else (e.g. Spotify). */
export function parseMusicUrl(link: string): MusicSource | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id =
      url.searchParams.get('v') ??
      url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/)?.[1] ??
      null;
  }
  if (id && /^[\w-]{6,}$/.test(id)) {
    const t = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '0';
    const [, m = '0', sec = '0'] = t.match(/^(?:(\d+)m)?(\d+)?s?$/) ?? [];
    return { kind: 'youtube', id, start: Number(m) * 60 + Number(sec) };
  }
  if (/^https?:$/.test(url.protocol) && /\.(mp3|m4a|aac|ogg|oga|opus|wav)$/i.test(url.pathname)) {
    return { kind: 'audio', url: url.toString() };
  }
  return null;
}

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

/** Languages the host can talk to Tina in besides English (needs Gemini hearing). */
export const CONVERSATION_LANGUAGES: LanguageCode[] = ['ta'];

/** "Say it again", "wait", "wait a little", "continue" in Tamil. */
const TAMIL_KEYWORDS: Keyword[] = [
  { phrase: 'மீண்டும் சொல்லுங்கள்', action: 'repeat' },
  { phrase: 'திரும்ப சொல்லுங்க', action: 'repeat' },
  { phrase: 'காத்திருங்கள்', action: 'hold' },
  { phrase: 'கொஞ்சம் இருங்க', action: 'hold' },
  { phrase: 'தொடருங்கள்', action: 'continue' },
  { phrase: 'தொடருங்க', action: 'continue' },
];

export const DEFAULT_SETTINGS: CeremonySettings = {
  pause_seconds: 3,
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
  conversation_languages: ['en', 'ta'],
  congratulate: true,
  congratulations: 'Congratulations, {winner}!',
  style: 'professional',
  listen_pause: 1.5,
  celebrate: true,
  suspense: true,
  suspense_seconds: 5,
  walkup: true,
  walkup_seconds: 15,
  walkup_volume: 0.6,
  walkup_url: '',
  songs: [],
  keywords: [
    { phrase: 'please repeat', action: 'repeat' },
    { phrase: 'repeat that', action: 'repeat' },
    { phrase: 'please hold', action: 'hold' },
    { phrase: 'hold on', action: 'hold' },
    { phrase: 'continue', action: 'continue' },
    ...TAMIL_KEYWORDS,
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

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * What Tina says for a winner. When the previous winner had the same award and the
 * same reason (e.g. a team slide), the award and citation aren't repeated:
 * "The next winner is Arshan Soman."
 */
export const defaultScript = (a: ExtractedAward, previous?: ExtractedAward) =>
  previous &&
  oneLine(previous.category).toLowerCase() === oneLine(a.category).toLowerCase() &&
  oneLine(previous.citation) === oneLine(a.citation)
    ? `The next winner is ${oneLine(a.winner)}.`
    : // Slide text keeps its line breaks; collapse them so the script reads as one passage.
      [`The award for ${a.category} goes to ${a.winner}.`, a.citation]
        .map(oneLine)
        .filter(Boolean)
        .join(' ');

const AWARDS_KEY = 'avatar.ceremony.awards';
const SETTINGS_KEY = 'avatar.ceremony.settings';
const OLD_DEFAULT_GREETING =
  "Hello everyone! I'm Tina, and I'm delighted to be your co-host today. Whenever you're ready, just call my name.";

export const greetingFor = (greeting: string, hostName: string) =>
  greeting.replaceAll('{name}', hostName.trim() || 'everyone');

/** Saved settings from earlier versions, brought up to date. */
function migrate(saved: Record<string, unknown>): CeremonySettings {
  const settings = { ...DEFAULT_SETTINGS, ...saved } as CeremonySettings;
  // Earlier versions saved a greeting without the host's name; use the new default.
  if (settings.greeting === OLD_DEFAULT_GREETING) {
    settings.greeting = DEFAULT_SETTINGS.greeting;
  }
  // Earlier versions asked before each extra winner, with a long pause; all winners are
  // now announced together, a few seconds apart.
  if ('multi_winner' in saved) {
    delete (settings as Record<string, unknown>).multi_winner;
    settings.pause_seconds = DEFAULT_SETTINGS.pause_seconds;
  }
  // Music links per category were replaced by a link per announcement.
  delete (settings as Record<string, unknown>).award_music;
  // Tamil conversation came later: turn it on, with its keywords.
  if (!('conversation_languages' in saved)) {
    const known = new Set(settings.keywords.map((k) => k.phrase));
    settings.keywords = [
      ...settings.keywords,
      ...TAMIL_KEYWORDS.filter((k) => !known.has(k.phrase)),
    ];
  }
  return settings;
}

export function loadSettings(): CeremonySettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? migrate(JSON.parse(raw)) : DEFAULT_SETTINGS;
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
    const saved = (await response.json()) as Record<string, unknown> | null;
    return saved ? migrate(saved) : null;
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
  return loadFile(PDF_KEY);
}

const OVATION_KEY = 'ovation';
const WALKUP_KEY = 'walkup-music';

/** The optional audience photo shown during the applause; null removes it. */
export const saveOvationPhoto = (file: Blob | null) => saveFile(OVATION_KEY, file);
export const loadOvationPhoto = () => loadFile(OVATION_KEY);

/** The optional walk-up music played after each winner; null removes it. */
export const saveWalkupMusic = (file: Blob | null) => saveFile(WALKUP_KEY, file);
export const loadWalkupMusic = () => loadFile(WALKUP_KEY);

async function saveFile(key: string, file: Blob | null): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (file) {
        tx.objectStore(STORE).put(file, key);
      } else {
        tx.objectStore(STORE).delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Storage unavailable: the file must be re-uploaded after a reload.
  }
}

async function loadFile(key: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}
