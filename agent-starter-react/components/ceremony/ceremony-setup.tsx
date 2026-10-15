'use client';

import { useEffect, useState } from 'react';
import {
  CheckIcon,
  CircleNotchIcon,
  PlayIcon,
  PlusIcon,
  SpeakerHighIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';
import { MicrophoneSelect } from '@/components/app/microphone-select';
import { VoiceSelect } from '@/components/app/voice-select';
import { Button } from '@/components/ui/button';
import { LANGUAGES, type LanguageCode, type VoiceCode } from '@/lib/agent-channels';
import {
  type Award,
  type CeremonySettings,
  type ExtractedAward,
  KEYWORD_ACTIONS,
  type KeywordAction,
  type Translations,
  announcementFor,
  defaultScript,
  greetingFor,
  loadAwards,
  loadDeck,
  loadOvationPhoto,
  saveAwards,
  saveDeck,
  saveOvationPhoto,
  saveSettingsEverywhere,
  spokenText,
} from '@/lib/ceremony';
import { type PDFDocumentProxy, openPdf, pageImage, pageText } from '@/lib/pdf';
import { getSavedSpeakerId, saveName, saveVoice } from '@/lib/visitor';

type SinkableAudio = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };

// Slides with less text than this are sent as an image so names in pictures are read too.
const MIN_TEXT_CHARS = 40;
// Keep the extraction request well under Vercel's 4.5 MB body limit.
const MAX_REQUEST_BYTES = 3_500_000;

const inputClassName =
  'border-input bg-background text-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2';

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
  const hear = async (key: string, text: string, language: LanguageCode = 'en') => {
    setSpeaking(key);
    setError('');
    try {
      const response = await fetch('/api/ceremony/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: spokenText(text, settings.pronunciations),
          voice,
          language,
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const url = URL.createObjectURL(await response.blob());
      const audio: SinkableAudio = new Audio(url);
      const speakerId = getSavedSpeakerId();
      if (speakerId && audio.setSinkId) {
        await audio.setSinkId(speakerId).catch(() => {});
      }
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setSpeaking(null);
      };
      await audio.play();
    } catch (e) {
      setError(`Could not play the preview: ${e instanceof Error ? e.message : String(e)}`);
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
      if (text.length < MIN_TEXT_CHARS && size < MAX_REQUEST_BYTES) {
        image = await pageImage(doc, n, 1024, 0.6);
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
    update(
      found.map((a) => ({
        category: a.category,
        winner: a.winner,
        script: defaultScript(a),
        slide: a.slide,
      }))
    );
  };

  const setField = <K extends keyof Award>(index: number, key: K, value: Award[K]) =>
    update(awards.map((a, i) => (i === index ? { ...a, [key]: value } : a)));

  const ready = deck && awards.length > 0 && awards.every((a) => a.category && a.script);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-24 pb-16">
      <h1 className="text-foreground text-xl font-semibold">Award ceremony with Tina</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Upload the deck as PDF, check each announcement, then start. During the ceremony the host
        says, for example, &ldquo;Tina, please announce the Best Innovator award&rdquo;. Tina reads
        the announcement text exactly as written below and shows its slide.
      </p>

      <section className="mt-6 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">1. Presentation (PDF)</h2>
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
        {error && (
          <p role="alert" className="text-destructive mt-2 text-sm">
            {error}
          </p>
        )}
      </section>

      <section className="mt-4 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">2. Announcements ({awards.length})</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Tina reads the announcement text word-for-word. Spell names the way they should sound if
          needed. Winners stay on this laptop and are only sent to Tina when the ceremony starts.
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
                  onClick={() => void hear(`award-${index}`, announcementFor(settings, award))}
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
                <label className="text-muted-foreground text-xs md:col-span-3">
                  Announcement text (read word-for-word)
                  <textarea
                    rows={3}
                    className={inputClassName}
                    value={award.script}
                    onChange={(e) => setField(index, 'script', e.target.value)}
                  />
                </label>
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
          onClick={() => update([...awards, { category: '', winner: '', script: '', slide: 1 }])}
        >
          <PlusIcon /> Add award
        </Button>
      </section>

      <section className="mt-4 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">3. Tina</h2>
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
            Host name (Tina greets the host by name when she appears)
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
          <label className="text-muted-foreground text-xs">
            Opening greeting ({'{name}'} is replaced by the host name)
            <textarea
              rows={2}
              className={inputClassName}
              value={settings.greeting}
              onChange={(e) => updateSettings({ greeting: e.target.value })}
            />
          </label>
          <button
            type="button"
            onClick={() => void hear('greeting', greetingFor(settings.greeting, hostName))}
            disabled={!settings.greeting || speaking !== null}
            className="text-muted-foreground hover:text-foreground -mt-2 flex items-center gap-1 self-start text-xs"
          >
            {speaking === 'greeting' ? (
              <CircleNotchIcon className="size-3.5 animate-spin" />
            ) : (
              <SpeakerHighIcon className="size-3.5" />
            )}
            Hear the greeting
          </button>
          <SpeechLanguages
            id="greeting"
            source={settings.greeting}
            languages={settings.greeting_languages}
            translations={settings.greeting_translations}
            onChange={(greeting_languages, greeting_translations) =>
              updateSettings({ greeting_languages, greeting_translations })
            }
            preview={(text) => greetingFor(text, hostName)}
            hear={hear}
            speaking={speaking}
          />
          <label className="text-muted-foreground text-xs">
            Welcome note (read word-for-word when the host says, e.g., &ldquo;Tina, please give the
            welcome note&rdquo;)
            <textarea
              rows={4}
              className={inputClassName}
              value={settings.welcome_note}
              onChange={(e) => updateSettings({ welcome_note: e.target.value })}
            />
          </label>
          <button
            type="button"
            onClick={() => void hear('welcome', settings.welcome_note)}
            disabled={!settings.welcome_note || speaking !== null}
            className="text-muted-foreground hover:text-foreground -mt-2 flex items-center gap-1 self-start text-xs"
          >
            {speaking === 'welcome' ? (
              <CircleNotchIcon className="size-3.5 animate-spin" />
            ) : (
              <SpeakerHighIcon className="size-3.5" />
            )}
            Hear the welcome note
          </button>
          <SpeechLanguages
            id="welcome"
            source={settings.welcome_note}
            languages={settings.welcome_languages}
            translations={settings.welcome_translations}
            onChange={(welcome_languages, welcome_translations) =>
              updateSettings({ welcome_languages, welcome_translations })
            }
            preview={(text) => text}
            hear={hear}
            speaking={speaking}
          />
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
              Five seconds of applause after each winner
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
                bottom of the screen during the applause. Wide photos work best.
              </span>
            </div>
          </div>
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
          <fieldset className="text-sm">
            <legend className="text-muted-foreground mb-1 text-xs">
              When a category has several winners
            </legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="multi-winner"
                checked={settings.multi_winner === 'ask'}
                onChange={() => updateSettings({ multi_winner: 'ask' })}
              />
              Ask the host before announcing the next winner
            </label>
            <label className="mt-1 flex flex-wrap items-center gap-2">
              <input
                type="radio"
                name="multi-winner"
                checked={settings.multi_winner === 'auto'}
                onChange={() => updateSettings({ multi_winner: 'auto' })}
              />
              Continue automatically after a pause of
              <input
                type="number"
                min={2}
                max={60}
                className={`${inputClassName} w-16`}
                value={settings.pause_seconds}
                onChange={(e) =>
                  updateSettings({
                    pause_seconds: Math.min(60, Math.max(2, Number(e.target.value) || 8)),
                  })
                }
              />
              seconds (the slide moves to the next winner)
            </label>
          </fieldset>
        </div>
      </section>

      <section className="mt-4 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">4. Voice keywords</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          The host can say these phrases at any time, without calling &ldquo;Tina&rdquo;. While on
          hold, Tina ignores everything except a &ldquo;continue&rdquo; phrase.
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
        <h2 className="text-sm font-semibold">5. Name pronunciations</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Wherever a name below appears in an announcement or the greeting, Tina says it the way you
          write it on the right. Slides keep the real spelling. Use hyphens or simple sounds, e.g.
          Soumya → Sow-mya.
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
        <h2 className="text-sm font-semibold">6. Hall audio</h2>
        <p className="text-muted-foreground mt-1 mb-3 text-xs">
          Pick the host microphone and the speaker / PA output, and test them.
        </p>
        <MicrophoneSelect disabled={isStarting} />
      </section>

      <div className="bg-background/95 sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-3 border-t py-3 backdrop-blur">
        <Button onClick={() => void save()} disabled={saveState === 'saving'} variant="outline">
          {saveState === 'saving' ? (
            <CircleNotchIcon className="size-4 animate-spin" />
          ) : (
            <CheckIcon className="size-4" />
          )}
          Save settings
        </Button>
        <span className="text-muted-foreground text-xs" role="status">
          {saveState === 'saving'
            ? 'Saving…'
            : isDirty
              ? 'Unsaved changes'
              : saveState === 'saved'
                ? 'Saved on this laptop and online (other laptops get it too)'
                : saveState === 'local'
                  ? `Saved on this laptop only: ${saveError}`
                  : settings.saved_at
                    ? `Last saved ${new Date(settings.saved_at).toLocaleString()}`
                    : 'Not saved yet'}
        </span>
      </div>

      <div className="mt-6 flex flex-col items-center gap-2">
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
