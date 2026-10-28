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
  /** Optional introduction to the category (what the award recognises), said once
   * before its first winner with Tina on screen. Kept on the category's first entry. */
  intro?: string;
  /** Optional music link (an audio file such as .mp3) played after this winner's
   * congratulations; otherwise the general walk-up music. */
  music?: string;
  /** The award section (its id) this award belongs to; none: the first section.
   * `slide` is a slide of that section's PDF. */
  section?: string;
};

/** A group of awards with its own PDF, e.g. "Sports Awards", presented in turn. */
export type AwardSection = { id: string; name: string };

/** The first section; its PDF is the deck uploaded before there were sections. */
export const FIRST_SECTION_ID = 'main';
export const DEFAULT_SECTIONS: AwardSection[] = [{ id: FIRST_SECTION_ID, name: 'Awards' }];

export type CeremonySettings = {
  /** Seconds between the winners of one category (all are announced together). */
  pause_seconds: number;
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
  /** Suspense music during that countdown, its final hit landing on the name. */
  suspense_music: boolean;
  /** Tina's entrance: she materializes as a hologram, with a shimmering sound, before
   * her introduction. */
  intro_reveal: boolean;
  /** Play walk-up music after each winner (the built-in clap-along beat by default). */
  walkup: boolean;
  /** How long the music plays after the last winner of a category, in seconds. */
  walkup_seconds: number;
  /** Music volume, 0-1. */
  walkup_volume: number;
  /** General walk-up music link (an audio file); the uploaded file, else the built-in
   * clap-along beat, is used when this is empty. An announcement's own link comes first. */
  walkup_url: string;
  /** Everything Tina says from this page besides the awards: her introduction, the
   * greeting, the welcome message and the programme items (e.g. the lamp lighting),
   * each said word-for-word when its trigger comes. */
  events: CeremonyEvent[];
  /** Songs the host can ask for by name ("Tina, play Jai Ho"), e.g. during a break. */
  songs: Song[];
  /** Phrases the host can say (without "Tina") to control her. */
  keywords: Keyword[];
  /** Written name -> how Tina should say it (speech only; slides keep the real spelling). */
  pronunciations: Pronunciation[];
  /** When the settings were last saved (ms); the newer copy wins between devices. */
  saved_at?: number;
  /** Set once the Ask AI event was added to these settings (so a removed one stays removed). */
  ask_ai_offered?: boolean;
  /** The same for the Lucky Draw event. */
  lucky_draw_offered?: boolean;
};

export type Song = { name: string; url: string };

/** When Tina says an event: when the host calls it by name (default), as soon as she
 * appears, or when the host first calls her ("Hello Tina"). */
export type EventTrigger = 'called' | 'appear' | 'first_call';

export const EVENT_TRIGGERS: { code: EventTrigger; label: string }[] = [
  { code: 'called', label: 'Called by name' },
  { code: 'appear', label: 'As soon as Tina appears' },
  { code: 'first_call', label: 'Host’s first “Hello Tina”' },
];

/** name: what the host calls it ("Lamp Lighting"); script: what Tina says, in English
 * ({name} is the host's name); slide: shown while she speaks (0 or none: Tina full
 * screen); languages: spoken in turn (English only by default), with their translations. */
export type CeremonyEvent = {
  name: string;
  script: string;
  slide?: number;
  trigger?: EventTrigger;
  languages?: LanguageCode[];
  translations?: Translations;
  /** 'ask_ai': after its text, Tina answers the audience's questions on stage.
   * 'lucky_draw': after its text, Tina draws a lucky number from draw_from to draw_to. */
  kind?: EventKind;
  draw_from?: number;
  draw_to?: number;
  /** How many lucky draws are planned: the host can roll again that often (or more). */
  draws?: number;
  /** Music played once Tina has said the text (an audio file or YouTube link), e.g.
   * devotional music for the lamp lighting, for music_seconds. */
  music?: string;
  music_seconds?: number;
};

export type EventKind = 'say' | 'ask_ai' | 'lucky_draw';

export const DEFAULT_EVENT_MUSIC_SECONDS = 60;
export const MAX_EVENT_MUSIC_SECONDS = 300;

/** Audience Q&A: after this, anyone on stage can ask Tina anything, without her name. */
export const ASK_AI_EVENT: CeremonyEvent = {
  name: 'Ask AI',
  trigger: 'called',
  kind: 'ask_ai',
  script:
    "It's time for Ask AI! Come up to the stage and ask me anything that comes to your mind. " +
    "I'll do my best to answer, or at least make you smile.",
};

/** The lucky draw: Tina draws a number in this range, the jar spinning for 30 seconds. */
export const LUCKY_DRAW_EVENT: CeremonyEvent = {
  name: 'Lucky Draw',
  trigger: 'called',
  kind: 'lucky_draw',
  draw_from: 1000,
  draw_to: 5000,
  draws: 5,
  script: "It's time for our lucky draw! Let's see whose number comes out of the jar.",
};

/** A placeholder left in an event's text, e.g. "[Leader Name, Designation]". */
export const placeholderIn = (text: string) => text.match(/\[[^\]]+\]/)?.[0] ?? null;

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
  // Music that ships with the app, e.g. /sounds/suspense_60s.mp3.
  if (/^\/[\w\-./]+\.(mp3|m4a|aac|ogg|oga|opus|wav)$/i.test(link.trim())) {
    return { kind: 'audio', url: link.trim() };
  }
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

/** Royalty-free suspense tracks made for Tina; each builds to a hit at SUSPENSE_HIT_SECONDS. */
export const SUSPENSE_TRACKS = [
  '/sounds/suspense_drum_roll.mp3',
  '/sounds/suspense_ticking_clock.mp3',
  '/sounds/suspense_game_show.mp3',
];
export const SUSPENSE_HIT_SECONDS = 56;

/** Walk-up music when no other is set: a royalty-free clap-along beat made for Tina. */
export const DEFAULT_WALKUP_MUSIC = '/sounds/clap_along_beat_30s.mp3';

/** Music for the award presentation: audio files only. YouTube music isn't royalty-free,
 * so it's not played after winners (songs the host asks for during breaks still can be). */
export function parseAwardMusic(link: string): MusicSource | null {
  const source = parseMusicUrl(link);
  return source?.kind === 'audio' ? source : null;
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
  conversation_languages: ['en', 'ta'],
  congratulate: true,
  congratulations: 'Congratulations, {winner}!',
  style: 'professional',
  listen_pause: 1.5,
  celebrate: true,
  suspense: true,
  suspense_seconds: 5,
  suspense_music: true,
  intro_reveal: true,
  walkup: true,
  walkup_seconds: 30,
  walkup_volume: 0.6,
  walkup_url: '',
  events: [
    {
      name: 'Introduction',
      trigger: 'appear',
      script: 'Hello, I am Tina, your AI avatar assistant. I am ready to support you.',
    },
    {
      name: 'Greeting',
      trigger: 'first_call',
      script: 'Hi {name}, good day! I am happy to be your co-host.',
    },
    {
      name: 'Welcome Message',
      trigger: 'called',
      script:
        'Good evening, esteemed UST leaders and dear colleagues. A warm welcome to the PACS ' +
        'Annual Rewards and Recognition Ceremony. We sincerely thank our leaders for taking time ' +
        'out of their busy schedules to join us. Your presence and continued support make this ' +
        'occasion truly special. Let us celebrate excellence and achievement together!',
    },
    ASK_AI_EVENT,
    LUCKY_DRAW_EVENT,
  ],
  ask_ai_offered: true,
  lucky_draw_offered: true,
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
const SECTIONS_KEY = 'avatar.ceremony.sections';
const SETTINGS_KEY = 'avatar.ceremony.settings';
const OLD_DEFAULT_GREETING =
  "Hello everyone! I'm Tina, and I'm delighted to be your co-host today. Whenever you're ready, just call my name.";

export const greetingFor = (greeting: string, hostName: string) =>
  greeting.replaceAll('{name}', hostName.trim() || 'everyone');

/** Saved settings from earlier versions, brought up to date. */
function migrate(saved: Record<string, unknown>): CeremonySettings {
  const settings = { ...DEFAULT_SETTINGS, ...saved } as CeremonySettings;
  // The introduction, greeting and welcome note had their own fields; they are events now.
  if ('introduction' in saved || 'greeting' in saved || 'welcome_note' in saved) {
    const old = saved as Record<string, unknown>;
    const text = (key: string, fallback: string) =>
      typeof old[key] === 'string' ? (old[key] as string).trim() : fallback;
    const [introduction, greeting, welcome] = DEFAULT_SETTINGS.events;
    let greetingText = text('greeting', greeting.script) || greeting.script;
    // Earlier versions saved a greeting without the host's name; use the new default.
    if (greetingText === OLD_DEFAULT_GREETING) {
      greetingText = greeting.script;
    }
    const greetingLanguages = (old.greeting_languages as LanguageCode[] | undefined) ?? ['en'];
    const converted: CeremonyEvent[] = [
      // An empty introduction meant none.
      {
        ...introduction,
        script: text('introduction', introduction.script),
        languages: greetingLanguages,
      },
      {
        ...greeting,
        script: greetingText,
        languages: greetingLanguages,
        translations: (old.greeting_translations as Translations | undefined) ?? {},
      },
      {
        ...welcome,
        script: text('welcome_note', welcome.script) || welcome.script,
        languages: (old.welcome_languages as LanguageCode[] | undefined) ?? ['en'],
        translations: (old.welcome_translations as Translations | undefined) ?? {},
      },
    ].filter((e) => e.script);
    settings.events = [...converted, ...((saved.events as CeremonyEvent[] | undefined) ?? [])];
    for (const key of [
      'introduction',
      'greeting',
      'welcome_note',
      'greeting_languages',
      'greeting_translations',
      'welcome_languages',
      'welcome_translations',
    ]) {
      delete (settings as Record<string, unknown>)[key];
    }
  }
  // Earlier versions asked before each extra winner, with a long pause; all winners are
  // now announced together, a few seconds apart.
  if ('multi_winner' in saved) {
    delete (settings as Record<string, unknown>).multi_winner;
    settings.pause_seconds = DEFAULT_SETTINGS.pause_seconds;
  }
  // The walk-up music used to play for 15 seconds; the clap-along beat runs 30.
  if (saved.walkup_seconds === 15) {
    settings.walkup_seconds = DEFAULT_SETTINGS.walkup_seconds;
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
  // Ask AI came later: offer it once.
  if (!saved.ask_ai_offered) {
    if (!settings.events.some((e) => e.kind === 'ask_ai')) {
      settings.events = [...settings.events, ASK_AI_EVENT];
    }
    settings.ask_ai_offered = true;
  }
  // The lucky draw came later: offer it once too.
  if (!saved.lucky_draw_offered) {
    if (!settings.events.some((e) => e.kind === 'lucky_draw')) {
      settings.events = [...settings.events, LUCKY_DRAW_EVENT];
    }
    settings.lucky_draw_offered = true;
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
// The first section keeps the key the single deck had.
const deckKey = (sectionId: string) =>
  sectionId === FIRST_SECTION_ID ? PDF_KEY : `${PDF_KEY}:${sectionId}`;

/** A section's PDF; null removes it. */
export const saveDeck = (sectionId: string, file: Blob | null) =>
  saveFile(deckKey(sectionId), file);
export const loadDeck = (sectionId: string) => loadFile(deckKey(sectionId));

export function loadSections(): AwardSection[] {
  try {
    const raw = window.localStorage.getItem(SECTIONS_KEY);
    const sections = raw ? (JSON.parse(raw) as AwardSection[]) : [];
    return sections.length ? sections : DEFAULT_SECTIONS;
  } catch {
    return DEFAULT_SECTIONS;
  }
}

export function saveSections(sections: AwardSection[]) {
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections));
  } catch {
    // Not persisted; still usable for this session.
  }
}

/** The section an award belongs to (the first one if its own was removed). */
export const sectionOf = (award: Award, sections: AwardSection[]) =>
  sections.find((s) => s.id === award.section) ?? sections[0];

/** A section with its PDF (null: none uploaded yet). */
export type SectionDeck<Doc> = AwardSection & { doc: Doc | null };

/** The first slide number of each section's PDF when they're numbered one after another
 * (as Tina knows them): section 1's slides first, then section 2's, and so on. */
export function slideOffsets(decks: SectionDeck<{ numPages: number }>[]) {
  const offsets: Record<string, number> = {};
  let total = 0;
  for (const deck of decks) {
    offsets[deck.id] = total;
    total += deck.doc?.numPages ?? 0;
  }
  return { offsets, total };
}

/** The awards as Tina gets them: in section order, each with its section's name (when
 * there are several) and its slide numbered across all the sections' PDFs. */
export function programAwards(
  awards: Award[],
  decks: SectionDeck<{ numPages: number }>[]
): Award[] {
  const { offsets } = slideOffsets(decks);
  const named = decks.length > 1;
  return decks.flatMap((deck, i) =>
    awards
      .filter((a) => sectionOf(a, decks).id === deck.id)
      .map((a) => ({
        ...a,
        slide: offsets[deck.id] + a.slide,
        section: named ? deck.name.trim() || `Section ${i + 1}` : '',
      }))
  );
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
