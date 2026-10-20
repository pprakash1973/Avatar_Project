'use client';

import { useEffect, useRef } from 'react';

// A full-screen YouTube player for the ceremony stage (YouTube IFrame Player API).
// YouTube picks the quality from the player size, so full screen plays in HD.

export type StageVideo = { id: string; title: string; channel: string };

/** Pause / play from Tina or the operator keys. */
export type VideoControls = { pause: () => void; play: () => void; toggle: () => void };

export type YTPlayer = {
  pauseVideo: () => void;
  playVideo: () => void;
  setVolume: (volume: number) => void;
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
}

export function VideoPlayer({ video, onEnded, onError, controlsRef }: VideoPlayerProps) {
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
      };
    });
    return () => {
      cancelled = true;
      controlsRef.current = null;
      player?.destroy();
    };
  }, [video.id, controlsRef]);

  return (
    <div className="absolute inset-0 bg-black">
      <div ref={hostRef} className="size-full" />
      <div className="pointer-events-none absolute top-3 left-1/2 max-w-[60vw] -translate-x-1/2 truncate rounded-full bg-black/60 px-3 py-1 text-xs text-white/80">
        {video.title} · {video.channel} · V: stop · N: next result · Space: pause
      </div>
    </div>
  );
}
