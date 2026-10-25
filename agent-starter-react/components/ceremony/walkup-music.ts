'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { YTPlayer } from '@/components/ceremony/video-player';
import {
  type CeremonySettings,
  DEFAULT_WALKUP_MUSIC,
  type MusicSource,
  SUSPENSE_HIT_SECONDS,
  SUSPENSE_TRACKS,
  loadWalkupMusic,
  parseAwardMusic,
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
 * Walk-up music after each winner: start(link) plays the winner's music link (else the
 * general link, the uploaded file or the built-in clap-along beat), fades it in and keeps it going for further winners
 * with the same music; a different link switches track. It
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
  // The name of a song the host asked for (it plays to the end), or null.
  const [song, setSong] = useState<string | null>(null);
  const output = useRef<Output | null>(null);
  const audioRef = useRef<SinkableAudio | null>(null);
  const fadeRef = useRef<number | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef(0);
  // The volume the host asked for ("Tina, louder"); null: the setting.
  const chosenVolume = useRef<number | null>(null);
  // The link of the music playing now ('' for the uploaded file).
  const current = useRef<string | null>(null);
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
      current.current = null;
      setYouTube(null);
      setSong(null);
      setPlaying(false);
      notify.current(false);
    });
  }, [fadeTo, youtube]);

  // Set by stop(); a song's end calls it through this ref.
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const audioOutput = useCallback((url: string, loop: boolean): Output => {
    const audio: SinkableAudio = new Audio(url);
    audio.loop = loop;
    audio.onended = () => stopRef.current();
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

  /** Plays `source` (`link` names it): for `seconds`, or to the end when null. */
  const play = useCallback(
    (source: MusicSource, link: string, seconds: number | null, title: string | null) => {
      target.current = chosenVolume.current ?? settings.walkup_volume;
      clearTimeout(stopTimerRef.current ?? undefined);
      stopTimerRef.current = seconds === null ? null : setTimeout(stop, seconds * 1000);
      setSong(title);
      if (playing && current.current === link) {
        // A further winner with the same music: keep it going.
        fadeTo(level());
        return;
      }
      if (playing) {
        // A different song for this winner: switch straight away.
        clearInterval(fadeRef.current ?? undefined);
        output.current?.stop();
        output.current = null;
        setYouTube(null);
      }
      current.current = link;
      setPlaying(true);
      notify.current(true);
      if (source.kind === 'youtube') {
        // <MusicCard> creates the player and hands it to onYouTubePlayer.
        setYouTube({ id: source.id, start: source.start });
      } else {
        output.current = audioOutput(source.url, seconds !== null);
        fadeTo(level());
      }
    },
    [settings.walkup_volume, playing, stop, fadeTo, audioOutput]
  );

  /** Plays the winner's music link, else the general link, else the uploaded file, else
   * the built-in clap-along beat. YouTube links are skipped: not royalty-free. */
  const start = useCallback(
    (link = '') => {
      if (!settings.walkup) {
        return;
      }
      const chosen = [link, settings.walkup_url].find((l) => parseAwardMusic(l)) ?? '';
      const source: MusicSource = parseAwardMusic(chosen) ?? {
        kind: 'audio',
        url: file ?? DEFAULT_WALKUP_MUSIC,
      };
      play(source, chosen, settings.walkup_seconds, null);
    },
    [settings.walkup, settings.walkup_url, settings.walkup_seconds, file, play]
  );

  /** A song the host asked for by name: plays to the end, or until stopped. */
  const playSong = useCallback(
    (link: string, name: string) => {
      const source = parseMusicUrl(link);
      if (source) {
        play(source, link, null, name);
      }
    },
    [play]
  );

  // The countdown's suspense track last played, so the next one differs.
  const lastCountdown = useRef('');

  /** The countdown before a winner's name: a suspense track started so its final hit
   * lands on the reveal, `seconds` from now. */
  const playCountdown = useCallback(
    (seconds: number) => {
      const choices = SUSPENSE_TRACKS.filter((t) => t !== lastCountdown.current);
      const track = choices[Math.floor(Math.random() * choices.length)];
      lastCountdown.current = track;
      const from = Math.max(0, SUSPENSE_HIT_SECONDS - seconds);
      play({ kind: 'audio', url: `${track}#t=${from}` }, `countdown:${track}`, null, 'Suspense');
    },
    [play]
  );

  /** The name is out: let the hit ring under Tina's voice, then fade the countdown
   * music (only that; the walk-up music may have started by then). */
  const endCountdown = useCallback((afterMs: number) => {
    setTimeout(() => {
      if (current.current?.startsWith('countdown:')) {
        stopRef.current();
      }
    }, afterMs);
  }, []);

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

  /** Louder (+) or softer (-) by `step`, for this and the following music. */
  const changeVolume = useCallback(
    (step: number) => {
      const volume = Math.min(
        1,
        Math.max(0.05, (chosenVolume.current ?? settings.walkup_volume) + step)
      );
      chosenVolume.current = volume;
      if (playing) {
        target.current = volume;
        fadeTo(level());
      }
    },
    [settings.walkup_volume, playing, fadeTo]
  );

  const toggle = useCallback(
    (link?: string) => (playing ? stop() : start(link)),
    [playing, start, stop]
  );

  return {
    playing,
    youtube,
    song,
    start,
    playSong,
    playCountdown,
    endCountdown,
    stop,
    toggle,
    changeVolume,
    onYouTubePlayer,
  };
}
