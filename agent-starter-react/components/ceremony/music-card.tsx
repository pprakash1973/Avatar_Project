'use client';

import { useEffect, useRef } from 'react';
import { type YTPlayer, loadYouTubeApi } from '@/components/ceremony/video-player';

/**
 * A small, visible YouTube player for an award's walk-up music (YouTube's terms don't
 * allow hiding the player to play audio only). It starts silent; the music hook fades it.
 */
export function MusicCard({
  id,
  start,
  onPlayer,
  className = 'fixed bottom-20 left-4 z-50',
}: {
  id: string;
  start: number;
  onPlayer: (player: YTPlayer | null) => void;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onPlayerRef = useRef(onPlayer);
  onPlayerRef.current = onPlayer;

  useEffect(() => {
    let player: YTPlayer | null = null;
    let cancelled = false;
    void loadYouTubeApi().then((YT) => {
      if (cancelled || !hostRef.current) {
        return;
      }
      const target = document.createElement('div');
      hostRef.current.replaceChildren(target);
      player = new YT.Player(target, {
        host: 'https://www.youtube-nocookie.com',
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, start, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3 },
        events: {
          onReady: () => {
            player?.setVolume(0);
            player?.playVideo();
            onPlayerRef.current(player);
          },
        },
      });
    });
    return () => {
      cancelled = true;
      onPlayerRef.current(null);
      player?.destroy();
    };
  }, [id, start]);

  return (
    <div
      className={`${className} w-[min(22vw,320px)] min-w-[200px] overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/20`}
    >
      <div ref={hostRef} className="aspect-video w-full" />
      <div className="px-2 py-1 text-[10px] text-white/70">♪ Walk-up music</div>
    </div>
  );
}
