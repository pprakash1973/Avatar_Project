'use client';

import { useEffect, useState } from 'react';
import { CircleNotchIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import { MicrophoneSelect } from '@/components/app/microphone-select';
import { VoiceSelect } from '@/components/app/voice-select';
import { Button } from '@/components/ui/button';
import type { VoiceCode } from '@/lib/agent-channels';
import {
  type Award,
  type CeremonySettings,
  type ExtractedAward,
  defaultScript,
  loadAwards,
  loadDeck,
  saveAwards,
  saveDeck,
  saveSettings,
} from '@/lib/ceremony';
import { type PDFDocumentProxy, openPdf, pageImage, pageText } from '@/lib/pdf';
import { saveVoice } from '@/lib/visitor';

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
  settings,
  onSettingsChange,
  onStart,
  isStarting,
}: CeremonySetupProps) {
  const updateSettings = (patch: Partial<CeremonySettings>) => {
    const next = { ...settings, ...patch };
    onSettingsChange(next);
    saveSettings(next);
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
            Opening greeting (Tina says this as soon as she appears)
            <textarea
              rows={2}
              className={inputClassName}
              value={settings.greeting}
              onChange={(e) => updateSettings({ greeting: e.target.value })}
            />
          </label>
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
        <h2 className="text-sm font-semibold">4. Hall audio</h2>
        <p className="text-muted-foreground mt-1 mb-3 text-xs">
          Pick the host microphone and the speaker / PA output, and test them.
        </p>
        <MicrophoneSelect disabled={isStarting} />
      </section>

      <div className="mt-6 flex flex-col items-center gap-2">
        <Button
          size="lg"
          onClick={onStart}
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
