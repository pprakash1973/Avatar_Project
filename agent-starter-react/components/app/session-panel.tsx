'use client';

import { useRef, useState } from 'react';
import { useSessionContext } from '@livekit/components-react';
import {
  AirplaneTiltIcon,
  CircleNotchIcon,
  FileTextIcon,
  GlobeIcon,
  MapTrifoldIcon,
  PaperclipIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import type { CardWithId } from '@/hooks/useAgentChannels';
import { toastAlert } from '@/hooks/useAgentErrors';
import { FILE_UPLOAD_TOPIC, MAX_UPLOAD_BYTES, UPLOAD_ACCEPT } from '@/lib/agent-channels';
import { cn } from '@/lib/shadcn/utils';

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function retrievedAt(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function FileUploadButton() {
  const { room } = useSessionContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleFile = async (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      toastAlert({
        title: 'File too large',
        description: 'Please choose a PDF, Word document, or image of 1 MB or less.',
      });
      return;
    }
    setIsUploading(true);
    try {
      await room.localParticipant.sendFile(file, { topic: FILE_UPLOAD_TOPIC, compress: false });
    } catch (error) {
      console.error('file upload failed', error);
      toastAlert({ title: 'Upload failed', description: 'Please try again.' });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) {
            void handleFile(file);
          }
        }}
      />
      <Button
        variant="outline"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        aria-busy={isUploading}
        title="PDF, Word or image, up to 1 MB"
        className="self-end rounded-full font-mono text-xs font-bold tracking-wider uppercase"
      >
        {isUploading ? (
          <CircleNotchIcon weight="bold" className="animate-spin" />
        ) : (
          <PaperclipIcon weight="bold" />
        )}
        {isUploading ? 'Uploading…' : 'Upload file'}
      </Button>
    </>
  );
}

function CardBody({ card }: { card: CardWithId }) {
  switch (card.type) {
    case 'search':
      return (
        <>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <GlobeIcon weight="bold" className="size-3.5 shrink-0" />
            <span className="truncate">Web search · {card.query}</span>
          </p>
          <p className="mt-2 line-clamp-5">{card.answer}</p>
          {card.sources.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {card.sources.map((source) => (
                <li key={source.url} className="truncate">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline underline-offset-2"
                    title={source.title}
                  >
                    {hostname(source.url)} — {source.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    case 'file':
      return (
        <>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <FileTextIcon weight="bold" className="size-3.5 shrink-0" />
            <span className="truncate">{card.name}</span>
          </p>
          <p className="mt-2 font-semibold">{card.title}</p>
          <p className="mt-1">{card.summary}</p>
          {card.key_points.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {card.key_points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          )}
        </>
      );
    case 'travel':
      return (
        <>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <AirplaneTiltIcon weight="bold" className="size-3.5 shrink-0" />
            <span className="truncate">{card.title}</span>
          </p>
          <p className="mt-2">{card.summary}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {card.options.map((option) => (
              <li key={`${option.name}-${option.price}`} className="border-t pt-2">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{option.name}</span>
                  <span className="shrink-0 tabular-nums">{option.price}</span>
                </p>
                <p className="text-muted-foreground text-xs">{option.details}</p>
                {option.source_url.startsWith('http') && (
                  <a
                    href={option.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline underline-offset-2"
                  >
                    Source: {hostname(option.source_url)}
                  </a>
                )}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-2 text-xs">
            Estimated prices from public websites, checked {retrievedAt(card.retrieved_at)}. Confirm
            the final price and availability when booking.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {card.booking_links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="border-input hover:bg-accent rounded-full border px-3 py-1 text-xs font-medium"
              >
                Book on {link.label}
              </a>
            ))}
          </div>
        </>
      );
    case 'itinerary':
      return (
        <>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <MapTrifoldIcon weight="bold" className="size-3.5 shrink-0" />
            <span className="truncate">Itinerary</span>
          </p>
          <p className="mt-2 font-semibold">{card.title}</p>
          <p className="mt-1">{card.summary}</p>
          <ol className="mt-2 flex flex-col gap-2">
            {card.days.map((day) => (
              <li key={day.day}>
                <p className="font-medium">
                  {day.day}: {day.title}
                </p>
                <p className="text-muted-foreground text-xs">{day.plan}</p>
              </li>
            ))}
          </ol>
          {card.budget.length > 0 && (
            <table className="mt-3 w-full text-xs">
              <caption className="text-muted-foreground mb-1 text-left">Estimated budget</caption>
              <tbody>
                {card.budget.map((line) => (
                  <tr key={line.item} className="border-t">
                    <th scope="row" className="py-1 pr-2 text-left font-normal">
                      {line.item}
                    </th>
                    <td className="py-1 text-right tabular-nums">{line.amount}</td>
                  </tr>
                ))}
                <tr className="border-t font-semibold">
                  <th scope="row" className="py-1 pr-2 text-left">
                    Total
                  </th>
                  <td className="py-1 text-right tabular-nums">{card.total_estimate}</td>
                </tr>
              </tbody>
            </table>
          )}
          <p className="text-muted-foreground mt-2 text-xs">
            Costs are estimates from public websites, checked {retrievedAt(card.retrieved_at)}.
          </p>
        </>
      );
    case 'file_error':
      return (
        <p className="flex items-start gap-1.5">
          <WarningIcon weight="bold" className="mt-0.5 size-4 shrink-0" />
          <span>
            Couldn&apos;t read <strong>{card.name}</strong>: {card.reason}.
          </span>
        </p>
      );
  }
}

interface SessionPanelProps {
  cards: CardWithId[];
  onDismiss: (id: string) => void;
}

/** Upload button plus the cards the agent shows while it talks. */
export function SessionPanel({ cards, onDismiss }: SessionPanelProps) {
  return (
    <aside className="fixed top-4 right-4 left-4 z-40 flex max-h-[calc(100svh-9rem)] flex-col gap-3 md:top-20 md:left-auto md:w-88">
      <FileUploadButton />
      <div className="flex flex-col gap-3 overflow-y-auto">
        {cards.map((card, index) => (
          <article
            key={card.id}
            className={cn(
              'bg-background/90 text-foreground relative rounded-xl border p-4 pr-9 text-sm shadow-sm backdrop-blur',
              // On phones only the newest card is shown, so the avatar stays visible.
              index > 0 && 'hidden md:block'
            )}
          >
            <button
              type="button"
              onClick={() => onDismiss(card.id)}
              aria-label="Dismiss card"
              className="text-muted-foreground hover:text-foreground absolute top-3 right-3"
            >
              <XIcon weight="bold" className="size-4" />
            </button>
            <CardBody card={card} />
          </article>
        ))}
      </div>
    </aside>
  );
}
