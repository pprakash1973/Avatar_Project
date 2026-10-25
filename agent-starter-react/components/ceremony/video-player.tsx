'use client';

import { useEffect, useRef } from 'react';

// A full-screen YouTube player for the ceremony stage (YouTube IFrame Player API).
// YouTube picks the quality from the player size, so full screen plays in HD.

export type StageVideo = { id: string; title: string; channel: string };

/** Pause / play from Tina or the operator keys. */
export type VideoControls = {
  pause: () => void;
  play: () => void;
  toggle: () => void;
  /** Louder (+) or softer (-) by `step` (0-1). */
  changeVolume: (step: number) => void;
};

export type YTPlayer = {
  pauseVideo: () => void;
  playVideo: () => void;
  setVolume: (volume: number) => void;
  getVolume: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};

export type YTNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      host: string;
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    }
  ) => YTPlayer;
  PlayerState: { ENDED: number; PLAYING: number };
};

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiReady: Promise<YTNamespace> | null = null;

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (!apiReady) {
    apiReady = new Promise((resolve) => {
      if (window.YT?.Player) {
        resolve(window.YT);
        return;
      }
      window.onYouTubeIframeAPIReady = () => resolve(window.YT as YTNamespace);
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
    });
  }
  return apiReady;
}

interface VideoPlayerProps {
  video: StageVideo;
  onEnded: () => void;
  /** The video can't be played (removed, not embeddable): try the next result. */
  onError: () => void;
  controlsRef: React.RefObject<VideoControls | null>;
  /** Where the player sits: a small corner window, or `absolute inset-0` for full screen. */
  className: string;
}

export function VideoPlayer({ video, onEnded, onError, controlsRef, className }: VideoPlayerProps) {
  const full = className.includes('inset-0');
  const hostRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onEnded, onError });
  callbacks.current = { onEnded, onError };

  useEffect(() => {
    let player: YTPlayer | null = null;
    let cancelled = false;
    void loadYouTubeApi().then((YT) => {
      if (cancelled || !hostRef.current) {
        return;
      }
      // The API replaces this element with the iframe.
      const target = document.createElement('div');
      hostRef.current.replaceChildren(target);
      player = new YT.Player(target, {
        host: 'https://www.youtube-nocookie.com',
        videoId: video.id,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, controls: 1, iv_load_policy: 3 },
        events: {
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) {
              callbacks.current.onEnded();
            }
          },
          onError: () => callbacks.current.onError(),
        },
      });
      controlsRef.current = {
        pause: () => player?.pauseVideo(),
        play: () => player?.playVideo(),
        toggle: () =>
          player?.getPlayerState() === YT.PlayerState.PLAYING
            ? player.pauseVideo()
            : player?.playVideo(),
        changeVolume: (step) =>
          player?.setVolume(Math.min(100, Math.max(5, player.getVolume() + step * 100))),
      };
    });
    return () => {
      cancelled = true;
      controlsRef.current = null;
      player?.destroy();
    };
  }, [video.id, controlsRef]);

  return (
    // The same elements in both sizes, so resizing keeps the video playing.
    <div
      className={`${className} flex flex-col overflow-hidden bg-black transition-all duration-500`}
    >
      <div ref={hostRef} className={full ? 'min-h-0 flex-1' : 'aspect-video w-full'} />
      <div className="truncate px-2 py-1 text-[10px] text-white/70">
        {video.title} · {video.channel} · E: {full ? 'smaller' : 'enlarge'} · V: stop · N: next
        result · Space: pause
      </div>
    </div>
  );
}
