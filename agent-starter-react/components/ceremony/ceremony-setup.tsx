'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CheckIcon,
  CircleNotchIcon,
  PlayIcon,
  PlusIcon,
  SpeakerHighIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react/dist/ssr';
import { MicrophoneSelect } from '@/components/app/microphone-select';
import { VoiceSelect } from '@/components/app/voice-select';
import { playRevealSound } from '@/components/ceremony/hologram-reveal';
import { MusicCard } from '@/components/ceremony/music-card';
import { Button } from '@/components/ui/button';
import { LANGUAGES, type LanguageCode, type VoiceCode } from '@/lib/agent-channels';
import {
  type Award,
  CONVERSATION_LANGUAGES,
  type CeremonyEvent,
  type CeremonySettings,
  DEFAULT_EVENT_MUSIC_SECONDS,
  EVENT_TRIGGERS,
  type EventTrigger,
  type ExtractedAward,
  KEYWORD_ACTIONS,
  type KeywordAction,
  MAX_EVENT_MUSIC_SECONDS,
  type Translations,
  announcementFor,
  announcementParts,
  congratulationsFor,
  defaultScript,
  greetingFor,
  loadAwards,
  loadDeck,
  loadOvationPhoto,
  loadWalkupMusic,
  parseAwardMusic,
  parseMusicUrl,
  placeholderIn,
  saveAwards,
  saveDeck,
  saveOvationPhoto,
  saveSettingsEverywhere,
  saveWalkupMusic,
  spokenText,
} from '@/lib/ceremony';
import { type PDFDocumentProxy, openPdf, pageImage, pageText } from '@/lib/pdf';
import { getSavedSpeakerId, saveName, saveVoice } from '@/lib/visitor';

type SinkableAudio = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };

// Slides with less text than this are sent as a sharper image, since the names are
// probably in pictures. Every slide is sent as an image (budget allowing) so the model
// can compare photo sizes: the winner has the smaller photo, a testimonial giver the larger.
const MIN_TEXT_CHARS = 40;
// Keep the extraction request well under Vercel's 4.5 MB body limit.
const MAX_REQUEST_BYTES = 3_500_000;

const categoryKey = (category: string) => category.replace(/\s+/g, ' ').trim().toLowerCase();

const inputClassName =
  'border-input bg-background text-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2';
// For short number inputs inside a sentence.
const numberClassName = inputClassName.replace('w-full', 'w-16');

type SetupTab = 'events' | 'awards' | 'customise' | 'launch';
const TABS: { code: SetupTab; label: string }[] = [
  { code: 'events', label: 'Events' },
  { code: 'awards', label: 'Awards' },
  { code: 'customise', label: 'Customise' },
  { code: 'launch', label: 'Sound test & launch' },
];
const TAB_KEY = 'avatar.ceremony.setup-tab';

interface CeremonySetupProps {
  deck: PDFDocumentProxy | null;
  onDeckChange: (deck: PDFDocumentProxy | null) => void;
  awards: Award[];
  onAwardsChange: (awards: Award[]) => void;
  voice: VoiceCode;
  onVoiceChange: (voice: VoiceCode) => void;
  hostName: string;
  onHostNameChange: (name: string) => void;
  settings: CeremonySettings;
  onSettingsChange: (settings: CeremonySettings) => void;
  onStart: () => void;
  isStarting: boolean;
}

export function CeremonySetup({
  deck,
  onDeckChange,
  awards,
  onAwardsChange,
  voice,
  onVoiceChange,
  hostName,
  onHostNameChange,
  settings,
  onSettingsChange,
  onStart,
  isStarting,
}: CeremonySetupProps) {
  // Edits stay a draft until "Save settings"; starting the ceremony also saves them.
  const [isDirty, setIsDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'local'>('idle');
  const [saveError, setSaveError] = useState('');
  const updateSettings = (patch: Partial<CeremonySettings>) => {
    onSettingsChange({ ...settings, ...patch });
    setIsDirty(true);
    setSaveState('idle');
  };
  const save = async () => {
    setSaveState('saving');
    setSaveError('');
    try {
      onSettingsChange(await saveSettingsEverywhere(settings));
      setSaveState('saved');
    } catch (e) {
      // saveSettingsEverywhere keeps the laptop copy even if the server is unreachable.
      setSaveState('local');
      setSaveError(e instanceof Error ? e.message : String(e));
    }
    setIsDirty(false);
  };
  const start = () => {
    if (isDirty) {
      void save();
    }
    onStart();
  };

  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  // Plays text in Tina's voice (with the pronunciation list applied) on the chosen speaker.
  const [speaking, setSpeaking] = useState<string | null>(null);
  const hear = async (
    key: string,
    text: string | string[],
    language: LanguageCode = 'en',
    gapSeconds = 0
  ) => {
    setSpeaking(key);
    setError('');
    try {
      const parts = (Array.isArray(text) ? text : [text]).filter((t) => t.trim());
      const urls = await Promise.all(
        parts.map(async (part) => {
          const response = await fetch('/api/ceremony/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: spokenText(part, settings.pronunciations),
              voice,
              language,
            }),
          });
          if (!response.ok) {
            throw new Error(await response.text());
          }
          return URL.createObjectURL(await response.blob());
        })
      );
      const speakerId = getSavedSpeakerId();
      for (const [i, url] of urls.entries()) {
        if (i > 0 && gapSeconds) {
          await new Promise((resolve) => setTimeout(resolve, gapSeconds * 1000));
        }
        const audio: SinkableAudio = new Audio(url);
        if (speakerId && audio.setSinkId) {
          await audio.setSinkId(speakerId).catch(() => {});
        }
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error('playback failed'));
          audio.play().catch(reject);
        });
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError(`Could not play the preview: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSpeaking(null);
    }
  };

  const setPronunciation = (index: number, key: 'written' | 'spoken', value: string) =>
    updateSettings({
      pronunciations: settings.pronunciations.map((p, i) =>
        i === index ? { ...p, [key]: value } : p
      ),
    });

  const setKeyword = (index: number, patch: { phrase?: string; action?: KeywordAction }) =>
    updateSettings({
      keywords: settings.keywords.map((k, i) => (i === index ? { ...k, ...patch } : k)),
    });

  // Optional audience photo for the applause, kept on this laptop.
  const [ovationUrl, setOvationUrl] = useState<string | null>(null);
  const showOvation = (blob: Blob | null) =>
    setOvationUrl((old) => {
      if (old) {
        URL.revokeObjectURL(old);
      }
      return blob ? URL.createObjectURL(blob) : null;
    });
  useEffect(() => {
    void loadOvationPhoto().then(showOvation);
  }, []);

  // Optional walk-up music, kept on this laptop.
  const [musicName, setMusicName] = useState<string | null>(null);
  const musicPreview = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    void loadWalkupMusic().then((blob) =>
      setMusicName(blob ? (blob instanceof File ? blob.name : 'Walk-up music') : null)
    );
  }, []);
  const previewMusic = async () => {
    if (musicPreview.current) {
      musicPreview.current.pause();
      musicPreview.current = null;
      return;
    }
    const blob = await loadWalkupMusic();
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio: SinkableAudio = new Audio(url);
    audio.volume = settings.walkup_volume;
    const speakerId = getSavedSpeakerId();
    if (speakerId && audio.setSinkId) {
      await audio.setSinkId(speakerId).catch(() => {});
    }
    musicPreview.current = audio;
    audio.onended = () => (musicPreview.current = null);
    void audio.play();
    // A taste of it, as long as it plays after a winner.
    setTimeout(() => {
      if (musicPreview.current === audio) {
        audio.pause();
        musicPreview.current = null;
      }
      URL.revokeObjectURL(url);
    }, settings.walkup_seconds * 1000);
  };

  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  // Restore the deck and award list prepared earlier on this laptop.
  useEffect(() => {
    onAwardsChange(loadAwards());
    void (async () => {
      const saved = await loadDeck();
      if (saved) {
        onDeckChange(await openPdf(await saved.arrayBuffer()));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!deck) {
      setThumbnails([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const images: string[] = [];
      for (let n = 1; n <= deck.numPages; n++) {
        images.push(await pageImage(deck, n, 240, 0.6));
      }
      if (!cancelled) {
        setThumbnails(images);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deck]);

  const update = (next: Award[]) => {
    onAwardsChange(next);
    saveAwards(next);
  };

  const handleFile = async (file: File) => {
    setError('');
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please upload the deck exported as PDF (PowerPoint: File → Export → PDF).');
      return;
    }
    setIsBusy(true);
    try {
      setStatus('Opening the deck…');
      const doc = await openPdf(await file.arrayBuffer());
      await saveDeck(file);
      onDeckChange(doc);
      await extract(doc);
    } catch (e) {
      setError(`Could not open the PDF: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsBusy(false);
      setStatus('');
    }
  };

  const extract = async (doc: PDFDocumentProxy) => {
    setStatus(`Reading ${doc.numPages} slides…`);
    const pages: { page: number; text: string; image?: string }[] = [];
    let size = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const text = await pageText(doc, n);
      let image: string | undefined;
      if (size < MAX_REQUEST_BYTES) {
        image =
          text.length < MIN_TEXT_CHARS
            ? await pageImage(doc, n, 1024, 0.6)
            : await pageImage(doc, n, 800, 0.5);
        size += image.length;
      }
      size += text.length;
      pages.push({ page: n, text, image });
    }
    setStatus('Tina is finding the award categories and winners…');
    const response = await fetch('/api/ceremony/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages }),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const { awards: found } = (await response.json()) as { awards: ExtractedAward[] };
    // Keep the music links already set for the same winners.
    const key = (a: { category: string; winner: string }) =>
      `${a.category}|${a.winner}`.replace(/\s+/g, ' ').trim().toLowerCase();
    const music = new Map(awards.filter((a) => a.music).map((a) => [key(a), a.music]));
    // And the introductions already written for the same categories.
    const intros = new Map(
      awards.filter((a) => a.intro).map((a) => [categoryKey(a.category), a.intro])
    );
    update(
      found.map((a, i) => ({
        category: a.category,
        winner: a.winner,
        script: defaultScript(a, found[i - 1]),
        slide: a.slide,
        music: music.get(key(a)),
        intro:
          found.findIndex((f) => categoryKey(f.category) === categoryKey(a.category)) === i
            ? intros.get(categoryKey(a.category))
            : undefined,
      }))
    );
  };

  const setEvent = (index: number, patch: Partial<CeremonyEvent>) =>
    updateSettings({
      events: settings.events.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    });

  // Events read from the MC script (PDF or text), added after those already listed.
  const [eventStatus, setEventStatus] = useState('');
  const [eventError, setEventError] = useState('');
  const importEvents = async (file: File) => {
    setEventError('');
    setEventStatus('Reading the script…');
    try {
      let text: string;
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const doc = await openPdf(await file.arrayBuffer());
        const pages = [];
        for (let n = 1; n <= doc.numPages; n++) {
          pages.push(await pageText(doc, n));
        }
        text = pages.join('\n\n');
      } else {
        text = await file.text();
      }
      setEventStatus('Tina is finding the events…');
      const response = await fetch('/api/ceremony/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const { events: found } = (await response.json()) as { events: CeremonyEvent[] };
      const known = new Set(settings.events.map((e) => e.name.trim().toLowerCase()));
      updateSettings({
        events: [
          ...settings.events,
          ...found.filter((e) => e.name.trim() && !known.has(e.name.trim().toLowerCase())),
        ],
      });
    } catch (e) {
      setEventError(`Could not read the script: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEventStatus('');
    }
  };

  const setField = <K extends keyof Award>(index: number, key: K, value: Award[K]) =>
    update(awards.map((a, i) => (i === index ? { ...a, [key]: value } : a)));

  const ready = deck && awards.length > 0 && awards.every((a) => a.category && a.script);

  // The tab last open on this laptop (restored after the first render, which the server
  // also makes).
  const [tab, setTab] = useState<SetupTab>('events');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TAB_KEY);
      if (TABS.some((t) => t.code === saved)) {
        setTab(saved as SetupTab);
      }
    } catch {
      // Storage unavailable: start on Events.
    }
  }, []);
  const chooseTab = (code: SetupTab) => {
    setTab(code);
    try {
      window.localStorage.setItem(TAB_KEY, code);
    } catch {
      // Not remembered; fine.
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-24 pb-16">
      <h1 className="text-foreground text-xl font-semibold">Award ceremony with Tina</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        During the ceremony the host says, for example, &ldquo;Tina, the lamp lighting please&rdquo;
        or &ldquo;Tina, please announce the Best Innovator award&rdquo;. Tina reads the text exactly
        as written and shows its slide.
      </p>

      <div className="bg-background/95 sticky top-0 z-20 mt-4 border-b backdrop-blur md:top-20">
        <div className="flex flex-wrap items-center gap-2 py-2">
          <div role="tablist" aria-label="Settings" className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.code}
                type="button"
                role="tab"
                aria-selected={tab === t.code}
                onClick={() => chooseTab(t.code)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  tab === t.code
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {t.label}
                {t.code === 'events' && ` (${settings.events.length})`}
                {t.code === 'awards' && ` (${awards.length})`}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground hidden text-xs sm:inline" role="status">
              {saveState === 'saving'
                ? 'Saving…'
                : isDirty
                  ? 'Unsaved changes'
                  : saveState === 'saved'
                    ? 'Saved here and online'
                    : saveState === 'local'
                      ? `Saved on this laptop only: ${saveError}`
                      : settings.saved_at
                        ? `Last saved ${new Date(settings.saved_at).toLocaleString()}`
                        : 'Not saved yet'}
            </span>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={saveState === 'saving'}
              variant={isDirty ? 'default' : 'outline'}
            >
              {saveState === 'saving' ? (
                <CircleNotchIcon className="size-4 animate-spin" />
              ) : (
                <CheckIcon className="size-4" />
              )}
              Save settings
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-destructive pb-2 text-sm">
            {error}
          </p>
        )}
      </div>

      {tab === 'events' && (
        <>
          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Events ({settings.events.length})</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              Everything Tina says besides the awards: her introduction, the greeting, the welcome
              message and the programme items such as the lamp lighting or a performance. Tina says
              each word-for-word, in English and any other ticked language, in turn. The host calls
              most of them by name, in any order: &ldquo;Tina, the lamp lighting please&rdquo;.
              &ldquo;Tina, the next event&rdquo; starts the next one not done yet, in this order.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label className="border-input hover:bg-accent cursor-pointer rounded-full border px-4 py-2 text-sm font-medium">
                Import from the MC script (PDF or text)
                <input
                  type="file"
                  accept="application/pdf,.pdf,text/plain,.txt,.md"
                  className="hidden"
                  disabled={eventStatus !== ''}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) {
                      void importEvents(file);
                    }
                  }}
                />
              </label>
              <span className="text-muted-foreground text-xs">
                Tina lists each event with the MC&rsquo;s opening lines; check and edit them below.
                Word files: save as PDF first.
              </span>
            </div>
            {eventStatus && (
              <p className="text-muted-foreground mt-2 flex items-center gap-2 text-sm">
                <CircleNotchIcon weight="bold" className="size-4 animate-spin" /> {eventStatus}
              </p>
            )}
            {eventError && (
              <p role="alert" className="text-destructive mt-2 text-sm">
                {eventError}
              </p>
            )}
            <ol className="mt-3 flex flex-col gap-3">
              {settings.events.map((event, index) => {
                const placeholder = placeholderIn(event.script);
                return (
                  <li key={index} className="flex gap-3 rounded-lg border p-3">
                    <div className="grid flex-1 gap-2 md:grid-cols-[1fr_15rem_6rem]">
                      <label className="text-muted-foreground text-xs">
                        Event name (what the host says)
                        <input
                          className={inputClassName}
                          value={event.name}
                          placeholder="e.g. Lamp Lighting"
                          onChange={(e) => setEvent(index, { name: e.target.value })}
                        />
                      </label>
                      <label className="text-muted-foreground text-xs">
                        When Tina says it
                        <select
                          className={inputClassName}
                          disabled={event.kind === 'ask_ai'}
                          value={event.trigger ?? 'called'}
                          onChange={(e) =>
                            setEvent(index, { trigger: e.target.value as EventTrigger })
                          }
                        >
                          {EVENT_TRIGGERS.map((t) => (
                            <option key={t.code} value={t.code}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-muted-foreground text-xs">
                        Slide (optional)
                        <input
                          type="number"
                          min={0}
                          max={deck?.numPages}
                          disabled={(event.trigger ?? 'called') !== 'called'}
                          className={inputClassName}
                          value={event.slide || ''}
                          placeholder="Tina"
                          onChange={(e) =>
                            setEvent(index, { slide: Math.max(0, Number(e.target.value) || 0) })
                          }
                        />
                      </label>
                      <label className="text-muted-foreground text-xs md:col-span-3">
                        What Tina says in English (word-for-word; {'{name}'} is the host&rsquo;s
                        name)
                        <textarea
                          rows={3}
                          className={inputClassName}
                          value={event.script}
                          placeholder="e.g. I request our chief guests and leaders to join us on stage for the lamp lighting ceremony."
                          onChange={(e) => setEvent(index, { script: e.target.value })}
                        />
                      </label>
                      {event.kind === 'ask_ai' && (
                        <p className="rounded-md bg-sky-500/10 p-2 text-xs md:col-span-3">
                          <strong>Audience Q&amp;A.</strong> After this text, anyone on stage can
                          ask Tina anything, without saying her name. She answers with a touch of
                          humour, doesn&rsquo;t use the host&rsquo;s name, and says &ldquo;Sorry, I
                          cannot answer that&rdquo; to anything sensitive (people&rsquo;s personal
                          details, confidential company or client matters, the winners, politics or
                          religion). It ends when the host says &ldquo;Tina, end Ask AI&rdquo; or
                          calls another event or award.
                        </p>
                      )}
                      {placeholder && (
                        <p role="alert" className="text-xs text-amber-600 md:col-span-3">
                          Fill in {placeholder} before the event: Tina would read it out as written.
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          void hear(`event-${index}`, greetingFor(event.script, hostName))
                        }
                        disabled={!event.script || speaking !== null}
                        className="text-muted-foreground hover:text-foreground flex items-center gap-1 justify-self-start text-xs"
                      >
                        {speaking === `event-${index}` ? (
                          <CircleNotchIcon className="size-3.5 animate-spin" />
                        ) : (
                          <SpeakerHighIcon className="size-3.5" />
                        )}
                        Hear how Tina will say it
                      </button>
                      <div className="md:col-span-3">
                        <SpeechLanguages
                          id={`event-${index}`}
                          source={event.script}
                          languages={event.languages ?? ['en']}
                          translations={event.translations ?? {}}
                          onChange={(languages, translations) =>
                            setEvent(index, { languages, translations })
                          }
                          preview={(text) => greetingFor(text, hostName)}
                          hear={hear}
                          speaking={speaking}
                        />
                      </div>
                      {event.kind !== 'ask_ai' && (event.trigger ?? 'called') === 'called' && (
                        <div className="text-muted-foreground flex flex-col gap-1 text-xs md:col-span-3">
                          <span>
                            Music after Tina&rsquo;s text (optional), e.g. devotional music for the
                            lamp lighting: an .mp3 or YouTube link. It plays for
                            <input
                              type="number"
                              min={5}
                              max={MAX_EVENT_MUSIC_SECONDS}
                              aria-label="Music seconds"
                              className={`${numberClassName} mx-1 inline-block`}
                              value={event.music_seconds ?? DEFAULT_EVENT_MUSIC_SECONDS}
                              onChange={(e) =>
                                setEvent(index, {
                                  music_seconds: Math.min(
                                    MAX_EVENT_MUSIC_SECONDS,
                                    Math.max(5, Number(e.target.value) || 5)
                                  ),
                                })
                              }
                            />
                            seconds (up to {MAX_EVENT_MUSIC_SECONDS}), then fades out; &ldquo;Tina,
                            stop the music&rdquo; or M ends it sooner.
                          </span>
                          <MusicLink
                            value={event.music ?? ''}
                            onChange={(music) => setEvent(index, { music: music || undefined })}
                            settings={settings}
                            emptyLabel="No music"
                          />
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${event.name || 'event'}`}
                      onClick={() =>
                        updateSettings({ events: settings.events.filter((_, i) => i !== index) })
                      }
                      className="text-muted-foreground hover:text-destructive self-start"
                    >
                      <TrashIcon className="size-5" />
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  updateSettings({ events: [...settings.events, { name: '', script: '' }] })
                }
              >
                <PlusIcon /> Add event
              </Button>
              {settings.events.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (window.confirm('Remove all events?')) {
                      updateSettings({ events: [] });
                    }
                  }}
                >
                  Remove all
                </Button>
              )}
            </div>
          </section>
        </>
      )}

      {tab === 'awards' && (
        <>
          <section className="mt-6 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Presentation (PDF)</h2>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="border-input hover:bg-accent cursor-pointer rounded-full border px-4 py-2 text-sm font-medium">
                {deck ? 'Replace deck' : 'Upload deck (PDF)'}
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  disabled={isBusy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) {
                      void handleFile(file);
                    }
                  }}
                />
              </label>
              {deck && (
                <span className="text-muted-foreground text-sm">{deck.numPages} slides loaded</span>
              )}
              {deck && !isBusy && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsBusy(true);
                    setError('');
                    extract(deck)
                      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                      .finally(() => {
                        setIsBusy(false);
                        setStatus('');
                      });
                  }}
                >
                  Re-read awards from slides
                </Button>
              )}
            </div>
            {status && (
              <p className="text-muted-foreground mt-2 flex items-center gap-2 text-sm">
                <CircleNotchIcon weight="bold" className="size-4 animate-spin" /> {status}
              </p>
            )}
          </section>

          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Announcements ({awards.length})</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              Tina reads the announcement text word-for-word. Spell names the way they should sound
              if needed. Winners stay on this laptop and are only sent to Tina when the ceremony
              starts.
            </p>
            <ol className="mt-3 flex flex-col gap-3">
              {awards.map((award, index) => (
                <li key={index} className="flex flex-col gap-3 rounded-lg border p-3 md:flex-row">
                  {thumbnails[award.slide - 1] && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbnails[award.slide - 1]}
                      alt={`Slide ${award.slide}`}
                      className="h-fit w-full rounded border md:w-40"
                    />
                  )}
                  <div className="grid flex-1 gap-2 md:grid-cols-[1fr_1fr_5rem]">
                    <label className="text-muted-foreground text-xs">
                      Category
                      <input
                        className={inputClassName}
                        value={award.category}
                        onChange={(e) => setField(index, 'category', e.target.value)}
                      />
                    </label>
                    <label className="text-muted-foreground text-xs">
                      Winner
                      <input
                        className={inputClassName}
                        value={award.winner}
                        onChange={(e) => setField(index, 'winner', e.target.value)}
                      />
                    </label>
                    <label className="text-muted-foreground text-xs">
                      Slide
                      <input
                        type="number"
                        min={1}
                        max={deck?.numPages}
                        className={inputClassName}
                        value={award.slide}
                        onChange={(e) => setField(index, 'slide', Number(e.target.value) || 1)}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        const [lead, reveal] = announcementParts(settings, award);
                        void (settings.suspense && lead
                          ? hear(`award-${index}`, [lead, reveal], 'en', settings.suspense_seconds)
                          : hear(`award-${index}`, announcementFor(settings, award)));
                      }}
                      disabled={!award.script || speaking !== null}
                      className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs md:col-span-3"
                    >
                      {speaking === `award-${index}` ? (
                        <CircleNotchIcon className="size-3.5 animate-spin" />
                      ) : (
                        <SpeakerHighIcon className="size-3.5" />
                      )}
                      Hear how Tina will say it
                    </button>
                    {awards.findIndex(
                      (a) => categoryKey(a.category) === categoryKey(award.category)
                    ) === index && (
                      <div className="md:col-span-3">
                        <label className="text-muted-foreground text-xs">
                          Introduction (optional): said once before this award&rsquo;s winners, with
                          Tina on screen, e.g. what the award recognises
                          <textarea
                            rows={2}
                            className={inputClassName}
                            value={award.intro ?? ''}
                            placeholder="e.g. We now present the Associate of the Year Award, which recognises outstanding contribution, commitment, and impact."
                            onChange={(e) => setField(index, 'intro', e.target.value || undefined)}
                          />
                        </label>
                        {award.intro && placeholderIn(award.intro) && (
                          <p role="alert" className="text-xs text-amber-600">
                            Fill in {placeholderIn(award.intro)} before the event: Tina would read
                            it out as written.
                          </p>
                        )}
                        {award.intro && (
                          <button
                            type="button"
                            onClick={() => void hear(`intro-${index}`, award.intro ?? '')}
                            disabled={speaking !== null}
                            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
                          >
                            {speaking === `intro-${index}` ? (
                              <CircleNotchIcon className="size-3.5 animate-spin" />
                            ) : (
                              <SpeakerHighIcon className="size-3.5" />
                            )}
                            Hear the introduction
                          </button>
                        )}
                      </div>
                    )}
                    <label className="text-muted-foreground text-xs md:col-span-3">
                      Announcement text (read word-for-word)
                      <textarea
                        rows={3}
                        className={inputClassName}
                        value={award.script}
                        onChange={(e) => setField(index, 'script', e.target.value)}
                      />
                    </label>
                    <div className="text-muted-foreground text-xs md:col-span-3">
                      Music URL (optional, an .mp3 link): plays for {settings.walkup_seconds}{' '}
                      seconds after &ldquo;
                      {congratulationsFor(settings, award.winner) || 'the announcement'}
                      &rdquo;
                      <MusicLink
                        value={award.music ?? ''}
                        onChange={(music) => setField(index, 'music', music || undefined)}
                        settings={settings}
                        emptyLabel="General walk-up music"
                        audioOnly
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${award.category || 'award'}`}
                    onClick={() => update(awards.filter((_, i) => i !== index))}
                    className="text-muted-foreground hover:text-destructive self-start"
                  >
                    <TrashIcon className="size-5" />
                  </button>
                </li>
              ))}
            </ol>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() =>
                update([...awards, { category: '', winner: '', script: '', slide: 1 }])
              }
            >
              <PlusIcon /> Add award
            </Button>
          </section>
        </>
      )}

      {tab === 'customise' && (
        <>
          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Announcements, music and style</h2>
            <div className="mt-3 flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.intro_reveal}
                    onChange={(e) => updateSettings({ intro_reveal: e.target.checked })}
                  />
                  Magical entrance: Tina materializes as a hologram, with a shimmering sound, before
                  her introduction (6 seconds)
                </label>
                <button
                  type="button"
                  onClick={() => playRevealSound(settings.walkup_volume)}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 self-start text-xs"
                >
                  <SpeakerHighIcon className="size-3.5" /> Hear the entrance sound
                </button>
              </div>
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.congratulate}
                    onChange={(e) => updateSettings({ congratulate: e.target.checked })}
                  />
                  Congratulate each winner after their announcement
                </label>
                <input
                  aria-label="Congratulations text"
                  className={inputClassName}
                  disabled={!settings.congratulate}
                  value={settings.congratulations}
                  onChange={(e) => updateSettings({ congratulations: e.target.value })}
                />
                <span className="text-muted-foreground text-xs">
                  {'{winner}'} is replaced by the winner&rsquo;s name, e.g. &ldquo;Congratulations,
                  Soumya!&rdquo;
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.celebrate}
                    onChange={(e) => updateSettings({ celebrate: e.target.checked })}
                  />
                  Show the ovation photo for five seconds after each winner
                </label>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  {ovationUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={ovationUrl} alt="Ovation photo" className="h-16 rounded border" />
                  )}
                  <label className="border-input hover:bg-accent cursor-pointer rounded-full border px-3 py-1.5 font-medium">
                    {ovationUrl ? 'Replace ovation photo' : 'Add ovation photo (optional)'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) {
                          void saveOvationPhoto(file);
                          showOvation(file);
                        }
                      }}
                    />
                  </label>
                  {ovationUrl && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        void saveOvationPhoto(null);
                        showOvation(null);
                      }}
                    >
                      Remove
                    </button>
                  )}
                  <span className="text-muted-foreground">
                    A photo of an audience applauding (one you have the rights to) rises along the
                    bottom of the screen; no sound is played. Wide photos work best.
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.suspense}
                    onChange={(e) => updateSettings({ suspense: e.target.checked })}
                  />
                  Suspense reveal: the slide stays blurred, Tina says &ldquo;The award for … goes
                  to&rdquo;, a
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={0.5}
                    className={numberClassName}
                    value={settings.suspense_seconds}
                    onChange={(e) =>
                      updateSettings({
                        suspense_seconds: Math.min(10, Math.max(1, Number(e.target.value) || 5)),
                      })
                    }
                  />
                  second countdown, then the name and the slide are revealed together
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.suspense_music}
                    disabled={!settings.suspense}
                    onChange={(e) => updateSettings({ suspense_music: e.target.checked })}
                  />
                  Suspense music during the countdown (royalty-free; its drum-roll hit lands on the
                  winner&rsquo;s name)
                </label>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.walkup}
                    onChange={(e) => updateSettings({ walkup: e.target.checked })}
                  />
                  Play walk-up music after each winner
                </label>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  {musicName && <span className="font-medium">{musicName}</span>}
                  <label className="border-input hover:bg-accent cursor-pointer rounded-full border px-3 py-1.5 font-medium">
                    {musicName ? 'Replace music' : 'Use your own music (MP3, optional)'}
                    <input
                      type="file"
                      accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/ogg"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file && file.size > 15 * 1024 * 1024) {
                          setError('The music file is too large (15 MB at most).');
                        } else if (file) {
                          void saveWalkupMusic(file);
                          setMusicName(file.name);
                        }
                      }}
                    />
                  </label>
                  {musicName && (
                    <>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground flex items-center gap-1"
                        onClick={() => void previewMusic()}
                      >
                        <SpeakerHighIcon className="size-3.5" /> Hear it / stop
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          void saveWalkupMusic(null);
                          setMusicName(null);
                        }}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
                <label className="flex flex-wrap items-center gap-2 text-xs">
                  Play for
                  <input
                    type="number"
                    min={5}
                    max={60}
                    className={numberClassName}
                    value={settings.walkup_seconds}
                    onChange={(e) =>
                      updateSettings({
                        walkup_seconds: Math.min(60, Math.max(5, Number(e.target.value) || 15)),
                      })
                    }
                  />
                  seconds, at volume
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={settings.walkup_volume}
                    onChange={(e) => updateSettings({ walkup_volume: Number(e.target.value) })}
                  />
                  {Math.round(settings.walkup_volume * 100)}%
                </label>
                <span className="text-muted-foreground text-xs">
                  Without your own music, Tina plays her built-in clap-along beat (royalty-free).
                  Use instrumental music you have the rights to: lyrics through the PA can reach
                  Tina&rsquo;s microphone. It softens while Tina speaks and fades out on its own; M
                  on the stage starts or stops it.
                </span>
                <label className="text-muted-foreground text-xs">
                  Or a link to an audio file (.mp3), used instead of the uploaded music. YouTube
                  links aren&rsquo;t played after winners, as YouTube music isn&rsquo;t
                  royalty-free.
                </label>
                <MusicLink
                  value={settings.walkup_url}
                  onChange={(walkup_url) => updateSettings({ walkup_url })}
                  settings={settings}
                  emptyLabel={musicName ? 'Uploaded music' : 'Clap-along beat'}
                  audioOnly
                />
              </div>
              <p className="text-muted-foreground text-xs">
                Videos: say &ldquo;Tina, play the … video&rdquo; and she plays the best HD match
                from YouTube full screen. On the stage, N plays the next search result, Space
                pauses, V stops. YouTube may show ads on some videos; that can&rsquo;t be turned
                off.
              </p>
              <fieldset className="text-sm">
                <legend className="text-muted-foreground mb-1 text-xs">
                  Languages the host can talk to Tina in (she replies in the same language)
                </legend>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked disabled />
                  English
                </label>
                {CONVERSATION_LANGUAGES.map((code) => (
                  <label key={code} className="mt-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.conversation_languages.includes(code)}
                      onChange={(e) =>
                        updateSettings({
                          conversation_languages: e.target.checked
                            ? [...settings.conversation_languages, code]
                            : settings.conversation_languages.filter((c) => c !== code),
                        })
                      }
                    />
                    {LANGUAGES.find((l) => l.code === code)?.label ?? code}
                  </label>
                ))}
                <span className="text-muted-foreground mt-1 block text-xs">
                  Tina hears mixed Tamil and English too. Announcements are read as written. With
                  Tamil on she answers about half a second later.
                </span>
              </fieldset>
              <fieldset className="text-sm">
                <legend className="text-muted-foreground mb-1 text-xs">
                  Tina&rsquo;s hosting style
                </legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="host-style"
                    checked={settings.style === 'professional'}
                    onChange={() => updateSettings({ style: 'professional' })}
                  />
                  Professional: polished, gracious and formal (recommended)
                </label>
                <label className="mt-1 flex items-center gap-2">
                  <input
                    type="radio"
                    name="host-style"
                    checked={settings.style === 'lively'}
                    onChange={() => updateSettings({ style: 'lively' })}
                  />
                  Lively MC: upbeat and energetic
                </label>
              </fieldset>
              <label className="flex flex-wrap items-center gap-2 text-sm">
                Wait for
                <input
                  type="number"
                  min={0.5}
                  max={4}
                  step={0.1}
                  className={numberClassName}
                  value={settings.listen_pause}
                  onChange={(e) =>
                    updateSettings({
                      listen_pause: Math.min(4, Math.max(0.5, Number(e.target.value) || 1.5)),
                    })
                  }
                />
                seconds of silence before Tina answers (raise it if she cuts the host off)
              </label>
              <label className="flex flex-wrap items-center gap-2 text-sm">
                When a category has several winners, announce them one after another, each with
                their slide, with a pause of
                <input
                  type="number"
                  min={1}
                  max={30}
                  className={numberClassName}
                  value={settings.pause_seconds}
                  onChange={(e) =>
                    updateSettings({
                      pause_seconds: Math.min(30, Math.max(1, Number(e.target.value) || 3)),
                    })
                  }
                />
                seconds between winners
              </label>
            </div>
          </section>

          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Name pronunciations</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              Wherever a name below appears in an announcement or an event, Tina says it the way you
              write it on the right. Slides keep the real spelling. Use hyphens or simple sounds,
              e.g. Soumya → Sow-mya.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {settings.pronunciations.map((p, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    aria-label="Written name"
                    placeholder="Written name"
                    className={inputClassName}
                    value={p.written}
                    onChange={(e) => setPronunciation(index, 'written', e.target.value)}
                  />
                  <span className="text-muted-foreground text-xs">→</span>
                  <input
                    aria-label="Say it as"
                    placeholder="Say it as"
                    className={inputClassName}
                    value={p.spoken}
                    onChange={(e) => setPronunciation(index, 'spoken', e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={`Hear ${p.written || 'name'}`}
                    onClick={() => void hear(`name-${index}`, p.spoken || p.written)}
                    disabled={!(p.spoken || p.written) || speaking !== null}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {speaking === `name-${index}` ? (
                      <CircleNotchIcon className="size-5 animate-spin" />
                    ) : (
                      <PlayIcon weight="fill" className="size-5" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${p.written || 'pronunciation'}`}
                    onClick={() =>
                      updateSettings({
                        pronunciations: settings.pronunciations.filter((_, i) => i !== index),
                      })
                    }
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <TrashIcon className="size-5" />
                  </button>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() =>
                updateSettings({
                  pronunciations: [...settings.pronunciations, { written: '', spoken: '' }],
                })
              }
            >
              <PlusIcon /> Add name
            </Button>
          </section>

          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Voice keywords</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              The host can say these phrases at any time, without calling &ldquo;Tina&rdquo;. While
              on hold, Tina ignores everything except a &ldquo;continue&rdquo; phrase.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {settings.keywords.map((k, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    aria-label="Phrase"
                    placeholder="e.g. please repeat"
                    className={inputClassName}
                    value={k.phrase}
                    onChange={(e) => setKeyword(index, { phrase: e.target.value })}
                  />
                  <select
                    aria-label="Action"
                    className={inputClassName}
                    value={k.action}
                    onChange={(e) => setKeyword(index, { action: e.target.value as KeywordAction })}
                  >
                    {KEYWORD_ACTIONS.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={`Remove ${k.phrase || 'keyword'}`}
                    onClick={() =>
                      updateSettings({ keywords: settings.keywords.filter((_, i) => i !== index) })
                    }
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <TrashIcon className="size-5" />
                  </button>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() =>
                updateSettings({
                  keywords: [...settings.keywords, { phrase: '', action: 'repeat' }],
                })
              }
            >
              <PlusIcon /> Add keyword
            </Button>
          </section>

          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Songs for breaks</h2>
            <p className="text-muted-foreground mt-1 mb-3 text-xs">
              Give each song a short name the host can say: &ldquo;Tina, play Jai Ho&rdquo; plays it
              to the end (YouTube songs in a small player in the corner); &ldquo;Tina, stop the
              music&rdquo; or M stops it. Any other song is searched on YouTube instead.
            </p>
            <p className="text-muted-foreground mb-3 text-xs">
              Built in, for lucky draws and on-the-spot awards: &ldquo;Tina, play the suspense
              music&rdquo; plays one of three one-minute suspense tracks (royalty-free, a different
              one each time). While music or a video plays, &ldquo;Tina, louder&rdquo; or
              &ldquo;Tina, softer&rdquo; changes its volume.
            </p>
            <ul className="flex flex-col gap-3">
              {settings.songs.map((song, index) => (
                <li key={index} className="flex flex-col gap-1 rounded-lg border p-2">
                  <div className="flex items-center gap-2">
                    <input
                      className={inputClassName.replace('w-full', 'w-48')}
                      value={song.name}
                      placeholder="Name, e.g. Jai Ho"
                      aria-label="Song name"
                      onChange={(e) =>
                        updateSettings({
                          songs: settings.songs.map((s, i) =>
                            i === index ? { ...s, name: e.target.value } : s
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${song.name || 'song'}`}
                      onClick={() =>
                        updateSettings({ songs: settings.songs.filter((_, i) => i !== index) })
                      }
                      className="text-muted-foreground hover:text-destructive ml-auto"
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  </div>
                  <MusicLink
                    value={song.url}
                    onChange={(url) =>
                      updateSettings({
                        songs: settings.songs.map((s, i) => (i === index ? { ...s, url } : s)),
                      })
                    }
                    settings={settings}
                    emptyLabel="Add a YouTube or .mp3 link"
                  />
                </li>
              ))}
            </ul>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => updateSettings({ songs: [...settings.songs, { name: '', url: '' }] })}
            >
              <PlusIcon /> Add song
            </Button>
          </section>
        </>
      )}

      {tab === 'launch' && (
        <>
          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Tina&rsquo;s voice and the host</h2>
            <div className="mt-3 flex flex-col gap-4">
              <VoiceSelect
                value={voice}
                onChange={(v) => {
                  onVoiceChange(v);
                  saveVoice(v);
                }}
                disabled={isStarting}
              />
              <label className="text-muted-foreground text-xs">
                Host name (Tina greets the host by name: {'{name}'} in an event&rsquo;s text)
                <input
                  className={inputClassName}
                  value={hostName}
                  placeholder="e.g. Prakash"
                  onChange={(e) => {
                    onHostNameChange(e.target.value);
                    saveName(e.target.value);
                  }}
                />
              </label>
            </div>
          </section>

          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Hall audio</h2>
            <p className="text-muted-foreground mt-1 mb-3 text-xs">
              Pick the host microphone and the speaker / PA output, and test them.
            </p>
            <MicrophoneSelect disabled={isStarting} />
          </section>

          <section className="mt-4 rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Ready to start?</h2>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {[
                { ok: settings.events.length > 0, text: `${settings.events.length} events` },
                {
                  ok: Boolean(deck),
                  text: deck ? `Deck loaded (${deck.numPages} slides)` : 'No deck loaded',
                },
                {
                  ok: awards.length > 0 && awards.every((a) => a.category && a.script),
                  text: `${awards.length} announcements, each with a category and text`,
                },
                {
                  ok: !isDirty,
                  text: isDirty ? 'Unsaved changes (saved when you start)' : 'Settings saved',
                },
              ].map((check) => (
                <li key={check.text} className="flex items-center gap-2">
                  {check.ok ? (
                    <CheckIcon className="size-4 text-green-600" />
                  ) : (
                    <WarningIcon className="size-4 text-amber-600" />
                  )}
                  {check.text}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-col items-center gap-2">
              <Button
                size="lg"
                onClick={start}
                disabled={!ready || isStarting || isBusy}
                className="w-72 rounded-full font-mono text-xs font-bold tracking-wider uppercase"
              >
                {isStarting ? (
                  <>
                    <CircleNotchIcon weight="bold" className="size-4 animate-spin" /> Starting Tina…
                  </>
                ) : (
                  'Start ceremony'
                )}
              </Button>
              {!ready && (
                <p className="text-muted-foreground text-xs">
                  Upload the deck and make sure every award has a category and announcement text.
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

interface SpeechLanguagesProps {
  id: string;
  /** The English text as written, sent for translation. */
  source: string;
  languages: LanguageCode[];
  translations: Translations;
  onChange: (languages: LanguageCode[], translations: Translations) => void;
  /** The text to play for a translation's preview (placeholders filled in). */
  preview: (text: string) => string;
  hear: (key: string, text: string, language?: LanguageCode) => Promise<void>;
  speaking: string | null;
}

/** Pick the languages Tina speaks a text in, and review each translation. */
function SpeechLanguages({
  id,
  source,
  languages,
  translations,
  onChange,
  preview,
  hear,
  speaking,
}: SpeechLanguagesProps) {
  const [isTranslating, setIsTranslating] = useState(false);
  const [error, setError] = useState('');
  const others = languages.filter((code) => code !== 'en');

  const toggle = (code: LanguageCode, on: boolean) => {
    // Keep the order of the language list, so English comes first.
    const next = LANGUAGES.map((l) => l.code).filter((c) =>
      c === code ? on : languages.includes(c)
    );
    onChange(next.length ? next : ['en'], translations);
  };

  const translate = async (codes: LanguageCode[]) => {
    setIsTranslating(true);
    setError('');
    try {
      const response = await fetch('/api/ceremony/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: source, languages: codes }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      onChange(languages, { ...translations, ...((await response.json()) as Translations) });
    } catch (e) {
      setError(`Could not translate: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsTranslating(false);
    }
  };

  return (
    <div className="-mt-1 flex flex-col gap-2 rounded-md border border-dashed p-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        Speak in:
        {LANGUAGES.map((l) => (
          <label key={l.code} className="text-foreground flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={languages.includes(l.code)}
              onChange={(e) => toggle(l.code, e.target.checked)}
            />
            {l.label}
          </label>
        ))}
      </div>
      {others.length > 0 && (
        <>
          <p className="text-muted-foreground text-xs">
            Tina says it in each ticked language, in this order. Check the translations; an empty
            one is translated automatically when Tina speaks.
          </p>
          {others.map((code) => (
            <div key={code} className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">
                {LANGUAGES.find((l) => l.code === code)?.label}
                <textarea
                  rows={2}
                  className={inputClassName}
                  value={translations[code] ?? ''}
                  onChange={(e) => onChange(languages, { ...translations, [code]: e.target.value })}
                />
              </label>
              <button
                type="button"
                onClick={() => void hear(`${id}-${code}`, preview(translations[code] ?? ''), code)}
                disabled={!translations[code]?.trim() || speaking !== null}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 self-start text-xs"
              >
                {speaking === `${id}-${code}` ? (
                  <CircleNotchIcon className="size-3.5 animate-spin" />
                ) : (
                  <SpeakerHighIcon className="size-3.5" />
                )}
                Hear it
              </button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={isTranslating || !source.trim()}
            onClick={() => void translate(others)}
          >
            {isTranslating && <CircleNotchIcon className="size-4 animate-spin" />}
            Translate from English
          </Button>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A music link (YouTube / YouTube Music / audio file) with its status and a Test button. */
function MusicLink({
  value,
  onChange,
  settings,
  emptyLabel,
  audioOnly = false,
}: {
  value: string;
  onChange: (link: string) => void;
  settings: CeremonySettings;
  /** What plays when the link is empty. */
  emptyLabel: string;
  /** Award music: audio files only (YouTube isn't royalty-free). */
  audioOnly?: boolean;
}) {
  const source = audioOnly ? parseAwardMusic(value) : parseMusicUrl(value);
  const [testing, setTesting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // A test plays as long as the music would after a winner.
  useEffect(() => {
    if (!testing) {
      return;
    }
    const timer = setTimeout(() => setTesting(false), settings.walkup_seconds * 1000);
    return () => {
      clearTimeout(timer);
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [testing, settings.walkup_seconds]);

  const test = () => {
    if (testing) {
      setTesting(false);
      return;
    }
    if (source?.kind === 'audio') {
      const audio = new Audio(source.url);
      audio.volume = settings.walkup_volume;
      void audio.play();
      audioRef.current = audio;
    }
    setTesting(true);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClassName} min-w-56 flex-1`}
          value={value}
          placeholder={
            audioOnly
              ? 'https://…/music.mp3'
              : 'https://music.youtube.com/watch?v=… or https://…/song.mp3'
          }
          onChange={(e) => {
            setTesting(false);
            onChange(e.target.value.trim());
          }}
        />
        <span
          className={`text-xs ${
            !value ? 'text-muted-foreground' : source ? 'text-green-600' : 'text-destructive'
          }`}
        >
          {!value
            ? emptyLabel
            : source?.kind === 'youtube'
              ? `YouTube${source.start ? ` from ${source.start}s` : ''}`
              : source
                ? 'Audio file'
                : audioOnly && parseMusicUrl(value)?.kind === 'youtube'
                  ? 'YouTube is not played after winners (not royalty-free): use an .mp3 link'
                  : `Not playable: use ${audioOnly ? 'an' : 'a YouTube or'} .mp3 link`}
        </span>
        {source && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
            onClick={test}
          >
            <SpeakerHighIcon className="size-3.5" /> {testing ? 'Stop' : 'Test'}
          </button>
        )}
      </div>
      {testing && source?.kind === 'youtube' && (
        <MusicCard
          id={source.id}
          start={source.start}
          className="mt-1"
          onPlayer={(player) => player?.setVolume(Math.round(settings.walkup_volume * 100))}
        />
      )}
    </div>
  );
}
