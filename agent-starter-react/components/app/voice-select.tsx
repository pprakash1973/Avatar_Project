'use client';

import { useRef, useState } from 'react';
import { PlayIcon, StopIcon } from '@phosphor-icons/react/dist/ssr';
import { VOICES, type VoiceCode } from '@/lib/agent-channels';
import { cn } from '@/lib/shadcn/utils';
import { getSavedSpeakerId } from '@/lib/visitor';

type SinkableAudio = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };

interface VoiceSelectProps {
  value: VoiceCode;
  onChange: (voice: VoiceCode) => void;
  disabled?: boolean;
  /** Only these voices, in this order, each with its provider (the ceremony's choice). */
  voices?: VoiceCode[];
}

/** Tina's voice picker; each voice has a short sample played on the chosen speaker. */
export function VoiceSelect({ value, onChange, disabled, voices }: VoiceSelectProps) {
  const shown = voices
    ? voices.flatMap((code) => VOICES.filter((v) => v.code === code))
    : [...VOICES];
  const audioRef = useRef<SinkableAudio | null>(null);
  const [playing, setPlaying] = useState<VoiceCode | null>(null);

  const play = async (code: VoiceCode) => {
    audioRef.current?.pause();
    if (playing === code) {
      setPlaying(null);
      return;
    }
    const audio: SinkableAudio = new Audio(`/voices/${code}.mp3`);
    audioRef.current = audio;
    const speakerId = getSavedSpeakerId();
    if (speakerId && audio.setSinkId) {
      await audio.setSinkId(speakerId).catch(() => {});
    }
    audio.onended = () => setPlaying(null);
    setPlaying(code);
    await audio.play().catch(() => setPlaying(null));
  };

  return (
    <div className="flex flex-col items-center">
      <p className="text-muted-foreground mb-2 text-xs">Tina&apos;s voice</p>
      <div
        role="radiogroup"
        aria-label="Tina's voice"
        className="flex flex-wrap justify-center gap-2"
      >
        {shown.map((voice) => (
          <div
            key={voice.code}
            className={cn(
              'flex items-center rounded-full border text-xs',
              value === voice.code ? 'border-primary bg-primary/10' : 'border-input'
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={value === voice.code}
              disabled={disabled}
              onClick={() => onChange(voice.code)}
              className="py-1.5 pr-1 pl-3 font-medium disabled:opacity-50"
              title={voice.accent}
            >
              {voice.label}
              <span className="text-muted-foreground ml-1 font-normal">
                ·{' '}
                {voices
                  ? voice.provider
                  : voice.accent === 'Indian English'
                    ? 'Indian'
                    : 'American'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void play(voice.code)}
              aria-label={`${playing === voice.code ? 'Stop' : 'Play'} ${voice.label} sample`}
              className="text-muted-foreground hover:text-foreground py-1.5 pr-3 pl-1"
            >
              {playing === voice.code ? (
                <StopIcon weight="fill" className="size-3.5" />
              ) : (
                <PlayIcon weight="fill" className="size-3.5" />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
