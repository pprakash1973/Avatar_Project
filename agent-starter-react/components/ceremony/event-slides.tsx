'use client';

import { useEffect, useState } from 'react';
import { CircleNotchIcon, ImagesIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';
import {
  type CeremonyEvent,
  EVENT_SLIDE_SECONDS,
  type EventSlides,
  loadEventSlides,
  removeEventSlides,
  saveEventSlides,
} from '@/lib/ceremony';
import { type PDFDocumentProxy, openPdf, pageImage } from '@/lib/pdf';

/** An event's slides, ready to show: a PDF's pages, or pictures (object URLs). */
export type LoadedEventSlides = { count: number; pdf?: PDFDocumentProxy; images?: string[] };

const isPdf = (file: File) =>
  file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

async function open(slides: EventSlides): Promise<LoadedEventSlides | null> {
  const files = await loadEventSlides(slides);
  if (!files) {
    return null;
  }
  if (slides.kind === 'pdf') {
    const pdf = await openPdf(await files[0].arrayBuffer());
    return { count: pdf.numPages, pdf };
  }
  return { count: files.length, images: files.map((f) => URL.createObjectURL(f)) };
}

/** The slides of all the events that have them, by their slides' id. */
export async function loadAllEventSlides(
  events: CeremonyEvent[]
): Promise<Record<string, LoadedEventSlides>> {
  const loaded: Record<string, LoadedEventSlides> = {};
  for (const event of events) {
    if (event.slides) {
      const slides = await open(event.slides).catch(() => null);
      if (slides) {
        loaded[event.slides.id] = slides;
      }
    }
  }
  return loaded;
}

/** Frees the pictures' object URLs. */
export function releaseEventSlides(all: Record<string, LoadedEventSlides>) {
  for (const slides of Object.values(all)) {
    slides.images?.forEach((url) => URL.revokeObjectURL(url));
  }
}

/** Small pictures of the slides, for the settings page. */
async function thumbnails(slides: LoadedEventSlides): Promise<string[]> {
  if (slides.images) {
    return slides.images;
  }
  const pdf = slides.pdf;
  if (!pdf) {
    return [];
  }
  const images = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 12); n++) {
    images.push(await pageImage(pdf, n, 200, 0.6));
  }
  return images;
}

/** The event's slides on the settings page: upload (a PDF or pictures), preview, remove. */
export function EventSlidesField({
  slides,
  onChange,
}: {
  slides: EventSlides | undefined;
  onChange: (slides: EventSlides | undefined) => void;
}) {
  const [previews, setPreviews] = useState<string[]>([]);
  // The files aren't on this laptop (the settings came from another one).
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!slides) {
      setPreviews([]);
      setMissing(false);
      return;
    }
    let stopped = false;
    let loaded: LoadedEventSlides | null = null;
    void (async () => {
      loaded = await open(slides).catch(() => null);
      if (stopped) {
        return;
      }
      setMissing(!loaded);
      setPreviews(loaded ? await thumbnails(loaded) : []);
    })();
    return () => {
      stopped = true;
      if (loaded) {
        releaseEventSlides({ x: loaded });
      }
    };
  }, [slides]);

  const upload = async (list: FileList) => {
    const files = Array.from(list);
    setError('');
    const pdf = files.find(isPdf);
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!pdf && images.length === 0) {
      setError('Choose a PDF (PowerPoint: File → Export → PDF) or pictures.');
      return;
    }
    setBusy(true);
    try {
      const id = crypto.randomUUID().slice(0, 8);
      let next: EventSlides;
      if (pdf) {
        const doc = await openPdf(await pdf.arrayBuffer());
        await saveEventSlides(id, [pdf]);
        next = { id, kind: 'pdf', count: doc.numPages };
      } else {
        await saveEventSlides(id, images);
        next = { id, kind: 'images', count: images.length };
      }
      if (slides) {
        await removeEventSlides(slides);
      }
      onChange(next);
    } catch (e) {
      setError(`Could not read the slides: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="text-muted-foreground flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <label
          className={`border-input hover:bg-accent text-foreground flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${
            busy ? 'pointer-events-none opacity-50' : ''
          }`}
        >
          {busy ? (
            <CircleNotchIcon className="size-4 animate-spin" />
          ) : (
            <ImagesIcon className="size-4" />
          )}
          {slides ? 'Replace slides' : 'Add slides (PDF or pictures)'}
          <input
            type="file"
            multiple
            accept="application/pdf,.pdf,image/*"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const files = e.target.files;
              if (files?.length) {
                void upload(files);
              }
              e.target.value = '';
            }}
          />
        </label>
        <span>
          {!slides
            ? 'Optional: shown while Tina says the text and until the next event or award.'
            : slides.count === 1
              ? 'One slide: it stays up until the next event or award.'
              : `${slides.count} slides: each shows for ${EVENT_SLIDE_SECONDS} seconds, over and over, until the next event or award.`}
        </span>
        {slides && (
          <button
            type="button"
            onClick={() => {
              void removeEventSlides(slides);
              onChange(undefined);
            }}
            className="hover:text-destructive flex items-center gap-1"
          >
            <TrashIcon className="size-3.5" /> Remove slides
          </button>
        )}
      </div>
      {missing && (
        <p role="alert" className="text-amber-600">
          These slides were added on another laptop: add them again here.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {previews.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {previews.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt={`Slide ${i + 1}`}
              className="h-16 w-auto shrink-0 rounded border object-contain"
            />
          ))}
        </div>
      )}
    </div>
  );
}
