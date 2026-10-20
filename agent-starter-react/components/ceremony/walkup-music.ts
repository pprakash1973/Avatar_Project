'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { YTPlayer } from '@/components/ceremony/video-player';
import {
  type CeremonySettings,
  type MusicSource,
  loadWalkupMusic,
  musicKey,
  parseMusicUrl,
} from '@/lib/ceremony';
import { getSavedSpeakerId } from '@/lib/visitor';

type SinkableAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

const FADE_MS = 1500;
/** Music level while Tina is speaking, relative to the set volume. */
const DUCKED = 0.15;

/** What the hook needs from an <audio> element or a YouTube player. */
type Output = { volume: number; setVolume: (v: number) => void; stop: () => void };

/** A YouTube player whose music should be on the stage: rendered by <MusicCard>. */
export type YouTubeMusic = { id: string; start: number };

/**
 * Walk-up music after each winner: start(category) plays that award's music link (or the
 * uploaded file), fades it in and keeps it going for further winners of the award. It
 * ducks under Tina's voice and fades out `walkup_seconds` after the last start(), or
 * straight away on stop().
 */
export function useWalkupMusic(
  settings: CeremonySettings,
  tinaSpeaking: boolean,
  onPlayingChange: (playing: boolean) => void
) {
  const [file, setFile] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [youtube, setYouTube] = useState<YouTubeMusic | null>(null);
  const output = useRef<Output | null>(null);
  const audioRef = useRef<SinkableAudio | null>(null);
  const fadeRef = useRef<number | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef(0);
  const speakingRef = useRef(tinaSpeaking);
  speakingRef.current = tinaSpeaking;
  const notify = useRef(onPlayingChange);
  notify.current = onPlayingChange;

  // The uploaded walk-up music: for awards without their own link.
  useEffect(() => {
    let url: string | null = null;
    void loadWalkupMusic().then((blob) => {
      if (blob) {
        url = URL.createObjectURL(blob);
        setFile(url);
      }
    });
    return () => {
      clearInterval(fadeRef.current ?? undefined);
      clearTimeout(stopTimerRef.current ?? undefined);
      audioRef.current?.pause();
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const level = () => (speakingRef.current ? target.current * DUCKED : target.current);

  // Glides the volume to `to` (0-1), then calls done. A timer, not animation frames:
  // those stop while the page is in the background.
  const fadeTo = useCallback((to: number, done?: () => void) => {
    const out = output.current;
    clearInterval(fadeRef.current ?? undefined);
    if (!out) {
      done?.();
      return;
    }
    const from = out.volume;
    const startedAt = performance.now();
    fadeRef.current = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - startedAt) / FADE_MS);
      out.setVolume(from + (to - from) * t);
      if (t >= 1) {
        clearInterval(fadeRef.current ?? undefined);
        fadeRef.current = null;
        done?.();
      }
    }, 50);
  }, []);

  const stop = useCallback(() => {
    clearTimeout(stopTimerRef.current ?? undefined);
    stopTimerRef.current = null;
    if (!output.current && !youtube) {
      return;
    }
    target.current = 0;
    fadeTo(0, () => {
      output.current?.stop();
      output.current = null;
      setYouTube(null);
      setPlaying(false);
      notify.current(false);
    });
  }, [fadeTo, youtube]);

  const audioOutput = useCallback((url: string): Output => {
    const audio: SinkableAudio = new Audio(url);
    audio.loop = true;
    audio.volume = 0;
    const speakerId = getSavedSpeakerId();
    if (speakerId && audio.setSinkId) {
      void audio.setSinkId(speakerId).catch(() => {});
    }
    void audio.play().catch(() => {});
    audioRef.current = audio;
    return {
      get volume() {
        return audio.volume;
      },
      setVolume: (v) => (audio.volume = Math.min(1, Math.max(0, v))),
      stop: () => audio.pause(),
    };
  }, []);

  /** Plays the music for this award (category from Tina), or the uploaded file. */
  const start = useCallback(
    (category = '') => {
      if (!settings.walkup) {
        return;
      }
      const source: MusicSource | null =
        parseMusicUrl(settings.award_music[musicKey(category)] ?? '') ??
        (file ? { kind: 'audio', url: file } : null);
      if (!source) {
        return;
      }
      target.current = settings.walkup_volume;
      clearTimeout(stopTimerRef.current ?? undefined);
      stopTimerRef.current = setTimeout(stop, settings.walkup_seconds * 1000);
      if (playing) {
        // A further winner of the same award: keep the music going.
        fadeTo(level());
        return;
      }
      setPlaying(true);
      notify.current(true);
      if (source.kind === 'youtube') {
        // <MusicCard> creates the player and hands it to onYouTubePlayer.
        setYouTube({ id: source.id, start: source.start });
      } else {
        output.current = audioOutput(source.url);
        fadeTo(level());
      }
    },
    [settings, file, playing, stop, fadeTo, audioOutput]
  );

  const onYouTubePlayer = useCallback(
    (player: YTPlayer | null) => {
      if (!player) {
        return;
      }
      let volume = 0;
      output.current = {
        get volume() {
          return volume;
        },
        setVolume: (v) => {
          volume = Math.min(1, Math.max(0, v));
          player.setVolume(Math.round(volume * 100));
        },
        stop: () => player.pauseVideo(),
      };
      fadeTo(level());
    },
    [fadeTo]
  );

  // Duck under Tina's voice while the music plays.
  useEffect(() => {
    if (playing && target.current > 0) {
      fadeTo(level());
    }
  }, [tinaSpeaking, playing, fadeTo]);

  const toggle = useCallback(
    (category?: string) => (playing ? stop() : start(category)),
    [playing, start, stop]
  );

  return { playing, youtube, start, stop, toggle, onYouTubePlayer };
}
