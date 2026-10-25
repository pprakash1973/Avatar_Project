'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionQuality, DisconnectReason, RoomEvent } from 'livekit-client';
import {
  VideoTrack,
  useAgent,
  useSessionContext,
  useVoiceAssistant,
} from '@livekit/components-react';
import {
  ArrowsOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CircleNotchIcon,
  StopIcon,
} from '@phosphor-icons/react/dist/ssr';
import { APPLAUSE_MS, ApplauseCrowd } from '@/components/ceremony/applause-crowd';
import { MusicCard } from '@/components/ceremony/music-card';
import {
  type StageVideo,
  type VideoControls,
  VideoPlayer,
} from '@/components/ceremony/video-player';
import { useWalkupMusic } from '@/components/ceremony/walkup-music';
import { Button } from '@/components/ui/button';
import { toastAlert } from '@/hooks/useAgentErrors';
import { UI_STATUS_TOPIC } from '@/lib/agent-channels';
import {
  type Award,
  CEREMONY_AWARDS_TOPIC,
  CEREMONY_EVENTS_TOPIC,
  type CeremonySettings,
  loadOvationPhoto,
} from '@/lib/ceremony';
import { type PDFDocumentProxy, renderPage } from '@/lib/pdf';

function SlideCanvas({ deck, slide }: { deck: PDFDocumentProxy; slide: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }
    let cancelled = false;
    const draw = () => {
      if (!cancelled) {
        void renderPage(deck, slide, canvas, container.clientWidth, container.clientHeight);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [deck, slide]);

  return (
    <div ref={containerRef} className="flex size-full items-center justify-center">
      <canvas ref={canvasRef} aria-label={`Slide ${slide}`} />
    </div>
  );
}

/**
 * Reports what goes wrong on this page (its LiveKit disconnect reason, reconnects, a
 * poor connection, page errors) to the server, to explain a dropped call afterwards.
 */
function useClientLog(room: ReturnType<typeof useSessionContext>['room']) {
  useEffect(() => {
    const log = (event: string, detail = '') =>
      void fetch('/api/ceremony/client-log', {
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ room: room.name, event, detail }),
      }).catch(() => {});
    const onDisconnected = (reason?: DisconnectReason) =>
      log('disconnected', reason === undefined ? 'unknown' : DisconnectReason[reason]);
    const onReconnecting = () => log('reconnecting');
    const onReconnected = () => log('reconnected');
    const onQuality = (quality: ConnectionQuality, participant: { isLocal: boolean }) => {
      if (participant.isLocal && (quality === 'poor' || quality === 'lost')) {
        log('poor connection', quality);
      }
    };
    const onError = (e: ErrorEvent) =>
      log('page error', `${e.message} @ ${e.filename}:${e.lineno}`);
    const onRejection = (e: PromiseRejectionEvent) => log('page error', String(e.reason));
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.ConnectionQualityChanged, onQuality);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.ConnectionQualityChanged, onQuality);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [room]);
}

/** Keeps the laptop screen on for the whole ceremony. */
function useScreenWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        lock = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        // Not supported or denied; the OS power settings then apply.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void acquire();
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, []);
}

// Positions for Tina's small window while a slide is shown (cycled with C).
type Shape = 'tall' | 'square' | 'wide';
const shape = (ratio: number): Shape => (ratio < 0.8 ? 'tall' : ratio > 1.25 ? 'wide' : 'square');
// Tina in the middle: a standing (tall) Tina leaves room for a video window beside her.
const TINA_LARGE_SIZE: Record<Shape, string> = {
  tall: 'h-[84vh]',
  square: 'h-[72vh] max-w-[90vw]',
  wide: 'w-[58vw]',
};
const TINA_CORNER_SIZE: Record<Shape, string> = {
  tall: 'h-[32vh] min-h-40',
  square: 'w-[13vw] min-w-28',
  wide: 'w-[20vw] min-w-40',
};

const CORNERS = ['right-3 bottom-3', 'right-3 top-3', 'left-3 top-12', 'left-3 bottom-16'];

// How long the announcement slide stays up before Tina returns to the middle.
const SLIDE_HOLD_MS = 2 * 60 * 1000;
// A hidden winner is revealed anyway after this long (if the reveal never arrives).
const REVEAL_FAILSAFE_MS = 15_000;
// The first award's curtains: how long they take to open (matches globals.css), and,
// without the suspense reveal, how long they stay closed on the slide.
const CURTAIN_OPEN_MS = 2600;
const CURTAIN_CLOSED_MS = 1500;

/** Red stage curtains over the first award's slide; they part when `opening`. */
function Curtains({ opening }: { opening: boolean }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden ${opening ? 'curtains-opening' : ''}`}
    >
      <div className="curtain curtain-left" />
      <div className="curtain curtain-right" />
      <div className="curtain-valance" />
    </div>
  );
}

/** The drum-roll countdown (3, 2, 1) during the pause before the winner's name. */
// The award title types in within this long, at most this fast per letter.
const TYPING_MS = 1800;
const TYPING_LETTER_MS = 70;

/** The award title typed in letter by letter, in gold, with a blinking caret. */
function TypedTitle({ text }: { text: string }) {
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    const step = Math.min(TYPING_LETTER_MS, TYPING_MS / Math.max(1, text.length));
    const timer = setInterval(() => setTyped((n) => (n >= text.length ? n : n + 1)), step);
    return () => clearInterval(timer);
  }, [text]);
  return (
    <span className="text-amber-300">
      {text.slice(0, typed)}
      <span className="typing-caret" />
      {/* The rest, invisible, so the centred title doesn't shift while it types. */}
      <span className="invisible">{text.slice(typed)}</span>
    </span>
  );
}

function Countdown({ seconds, startedAt }: { seconds: number; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  const left = Math.ceil(seconds - (now - startedAt) / 1000);
  if (left <= 0) {
    return null;
  }
  return (
    <span key={left} className="suspense-pulse text-[18vh] leading-none font-bold text-white">
      {left}
    </span>
  );
}

const STATE_LABELS: Record<string, string> = {
  listening: 'Listening for “Tina”',
  thinking: 'Tina is thinking…',
  speaking: 'Tina is speaking',
};

interface CeremonyStageProps {
  deck: PDFDocumentProxy;
  awards: Award[];
  settings: CeremonySettings;
  onReconnect: () => void;
  onEnd: () => void;
}

export function CeremonyStage({ deck, awards, settings, onReconnect, onEnd }: CeremonyStageProps) {
  const { room, isConnected, connectionState } = useSessionContext();
  const agent = useAgent();
  const { videoTrack } = useVoiceAssistant();
  const [slide, setSlide] = useState(1);
  const [isLive, setIsLive] = useState(false);
  // 'tina': Tina large in the middle (default, and during breaks).
  // 'slide': the slide fills the screen and Tina moves to the corner.
  // 'video': Tina large in the middle, a YouTube video in a small corner window
  // (E enlarges it to fill the screen, Tina then in the corner).
  const [view, setView] = useState<'tina' | 'slide' | 'video'>('tina');
  const viewRef = useRef(view);
  viewRef.current = view;
  // Search results for the video on screen; N plays the next one.
  const [videos, setVideos] = useState<StageVideo[]>([]);
  const [videoIndex, setVideoIndex] = useState(0);
  const [videoLarge, setVideoLarge] = useState(false);
  const videoControls = useRef<VideoControls | null>(null);
  // Suspense: the award title over a blurred slide until Tina says the winner's name.
  const [hiddenTitle, setHiddenTitle] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<{ seconds: number; startedAt: number } | null>(null);
  const [revealedAt, setRevealedAt] = useState(0);
  // The first award opens with stage curtains (once per ceremony); later awards use
  // only the blur reveal.
  const [curtain, setCurtain] = useState<'closed' | 'opening' | null>(null);
  const curtainUsed = useRef(false);
  // Corner for Tina's small window over slides; C moves it if it covers a face or text.
  const [corner, setCorner] = useState(0);
  // Tina's video shape (width / height): square for classic faces; Trinity-2 faces
  // stream tall (standing) or wide.
  const [tinaRatio, setTinaRatio] = useState(1);
  const [slideShownAt, setSlideShownAt] = useState(0);
  // Start time of the current standing ovation (0: none).
  const [applauseAt, setApplauseAt] = useState(0);
  const [onHold, setOnHold] = useState(false);
  const [ovationUrl, setOvationUrl] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void loadOvationPhoto().then((blob) => {
      if (blob) {
        url = URL.createObjectURL(blob);
        setOvationUrl(url);
      }
    });
    return () => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);
  const celebrateRef = useRef(settings.celebrate);
  celebrateRef.current = settings.celebrate;
  const programRef = useRef({ awards, settings });
  programRef.current = { awards, settings };

  useScreenWakeLock();
  useClientLog(room);

  // Tells Tina about media playing through the PA, so she doesn't take it for the host.
  const sendMedia = useCallback(
    (kind: 'video' | 'music', playing: boolean) => {
      void room.localParticipant
        .sendText(JSON.stringify({ type: 'media', kind, playing }), {
          topic: CEREMONY_EVENTS_TOPIC,
        })
        .catch(() => {});
    },
    [room]
  );
  const music = useWalkupMusic(settings, agent.state === 'speaking', (playing) =>
    sendMedia('music', playing)
  );
  const musicRef = useRef(music);
  musicRef.current = music;
  // The music link of the winner last announced: M plays it.
  const lastMusic = useRef('');

  const openCurtain = useCallback(() => setCurtain((c) => (c === 'closed' ? 'opening' : c)), []);

  const reveal = useCallback(() => {
    setHiddenTitle(null);
    setCountdown(null);
    setRevealedAt(Date.now());
    openCurtain();
  }, [openCurtain]);

  // Once open, the curtains are gone for the rest of the ceremony.
  useEffect(() => {
    if (curtain !== 'opening') {
      return;
    }
    const timer = setTimeout(() => setCurtain(null), CURTAIN_OPEN_MS);
    return () => clearTimeout(timer);
  }, [curtain]);

  const endVideo = useCallback(() => {
    setVideos([]);
    setVideoIndex(0);
    setVideoLarge(false);
    setView('tina');
    sendMedia('video', false);
  }, [sendMedia]);

  const nextVideo = useCallback(() => {
    setVideoIndex((i) => i + 1);
  }, []);
  // Past the last search result: back to Tina.
  useEffect(() => {
    if (videos.length && videoIndex >= videos.length) {
      endVideo();
    }
  }, [videos.length, videoIndex, endVideo]);

  useEffect(() => {
    if (!hiddenTitle) {
      return;
    }
    const timer = setTimeout(reveal, REVEAL_FAILSAFE_MS);
    return () => clearTimeout(timer);
  }, [hiddenTitle, reveal]);

  const goTo = useCallback(
    (n: number) => setSlide(Math.min(Math.max(1, n), deck.numPages)),
    [deck.numPages]
  );

  const showSlide = useCallback(
    (n?: number) => {
      if (n !== undefined) {
        goTo(n);
      }
      setView('slide');
      setSlideShownAt(Date.now());
    },
    [goTo]
  );

  // After an announcement, keep the slide up for the winner's walk-up and photos,
  // then bring Tina back to the middle of the screen for the break.
  useEffect(() => {
    if (view !== 'slide' || !slideShownAt) {
      return;
    }
    const timer = setTimeout(() => setView('tina'), SLIDE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [view, slideShownAt]);

  useEffect(() => {
    if (!applauseAt) {
      return;
    }
    const timer = setTimeout(() => setApplauseAt(0), APPLAUSE_MS);
    return () => clearTimeout(timer);
  }, [applauseAt]);

  // Tina asks for the award list when she's ready, and tells us which slide to show.
  useEffect(() => {
    room.registerTextStreamHandler(UI_STATUS_TOPIC, async (reader) => {
      try {
        const status = JSON.parse(await reader.readAll());
        if (status.type === 'ceremony_ready') {
          await room.localParticipant.sendText(JSON.stringify(programRef.current), {
            topic: CEREMONY_AWARDS_TOPIC,
          });
        } else if (status.type === 'ceremony_live') {
          setIsLive(true);
        } else if (status.type === 'slide') {
          showSlide(Number(status.slide) || 1);
          // Award slides carry their category; the first one opens with curtains, on
          // the winner's name (or shortly, without the suspense reveal).
          if (status.title && !curtainUsed.current) {
            curtainUsed.current = true;
            setCurtain('closed');
            if (!status.hidden) {
              setTimeout(openCurtain, CURTAIN_CLOSED_MS);
            }
          }
          if (status.hidden) {
            // A new award: the music of the last one makes way.
            musicRef.current.stop();
            setCountdown(null);
            setHiddenTitle(String(status.title || ''));
          } else {
            setHiddenTitle(null);
          }
        } else if (status.type === 'song') {
          // A song the host asked for by name, e.g. during a break; it ends a video.
          if (viewRef.current === 'video') {
            endVideo();
          }
          musicRef.current.playSong(String(status.url || ''), String(status.name || ''));
        } else if (status.type === 'music_stop') {
          musicRef.current.stop();
        } else if (status.type === 'suspense') {
          setCountdown({ seconds: Number(status.seconds) || 5, startedAt: Date.now() });
        } else if (status.type === 'reveal') {
          reveal();
        } else if (status.type === 'video' && Array.isArray(status.videos)) {
          musicRef.current.stop();
          setVideos(status.videos as StageVideo[]);
          setVideoIndex(Number(status.index) || 0);
          setView('video');
          sendMedia('video', true);
        } else if (status.type === 'video_control') {
          if (status.action === 'stop') {
            endVideo();
          } else if (status.action === 'next') {
            nextVideo();
          } else if (status.action === 'pause') {
            videoControls.current?.pause();
          } else if (status.action === 'play') {
            videoControls.current?.play();
          }
        } else if (status.type === 'view') {
          if (status.view === 'tina') {
            setView('tina');
          } else {
            showSlide();
          }
        } else if (status.type === 'applause') {
          if (celebrateRef.current) {
            setApplauseAt(Date.now());
          }
          // The winner's own music link, if the announcement has one.
          const same = (a: string, b: unknown) =>
            a.replace(/\s+/g, ' ').trim().toLowerCase() ===
            String(b ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
          const award = programRef.current.awards.find(
            (a) => same(a.category, status.category) && same(a.winner, status.winner)
          );
          lastMusic.current = award?.music ?? '';
          musicRef.current.start(lastMusic.current);
        } else if (status.type === 'hold') {
          setOnHold(Boolean(status.on));
        } else if (status.type === 'busy') {
          toastAlert({
            title: 'The avatar is busy or unavailable',
            description: 'Check the Anam and Simli plan minutes, then reconnect Tina.',
          });
        }
      } catch (error) {
        console.error('invalid status from Tina', error);
      }
    });
    return () => room.unregisterTextStreamHandler(UI_STATUS_TOPIC);
  }, [room, showSlide, reveal, openCurtain, sendMedia, endVideo, nextVideo]);

  useEffect(() => {
    if (!isConnected) {
      setIsLive(false);
    }
  }, [isConnected]);

  // Operator keyboard controls: ← → to change slides, Home for the first slide, F for full screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (view === 'video') {
        if (e.key.toLowerCase() === 'v' || e.key === 'Escape') {
          endVideo();
          return;
        } else if (e.key.toLowerCase() === 'n') {
          nextVideo();
          return;
        } else if (e.key.toLowerCase() === 'e') {
          setVideoLarge((large) => !large);
          return;
        } else if (e.key === ' ') {
          e.preventDefault();
          videoControls.current?.toggle();
          return;
        }
      }
      if (e.key.toLowerCase() === 'r') {
        reveal();
      } else if (e.key.toLowerCase() === 'm') {
        musicRef.current.toggle(lastMusic.current);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        showSlide(slide + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        showSlide(slide - 1);
      } else if (e.key === 'Home') {
        showSlide(1);
      } else if (e.key.toLowerCase() === 's') {
        showSlide();
      } else if (e.key.toLowerCase() === 'c') {
        setCorner((c) => (c + 1) % CORNERS.length);
      } else if (e.key.toLowerCase() === 't') {
        setView('tina');
      } else if (e.key.toLowerCase() === 'a') {
        setApplauseAt(Date.now());
      } else if (e.key.toLowerCase() === 'f') {
        void (document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slide, showSlide, view, endVideo, nextVideo, reveal]);

  // Tina fills the middle unless a slide (or an enlarged video) takes the screen.
  const tinaInCorner = view === 'slide' || (view === 'video' && videoLarge);
  // Videos and music cards go in a corner Tina isn't using.
  const mediaCorner =
    tinaInCorner && CORNERS[corner].includes('right') ? 'left-3 bottom-16' : 'right-3 bottom-3';

  const statusText = !isConnected
    ? connectionState === 'disconnected'
      ? 'Disconnected'
      : 'Connecting…'
    : !isLive
      ? 'Tina is getting ready…'
      : (STATE_LABELS[agent.state] ?? 'Tina is ready');

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-black">
      {!tinaInCorner && (
        // Slow, soft stage lights behind Tina.
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-60">
          <div className="stage-light absolute -top-1/4 -left-1/4 size-[70vmax] rounded-full bg-[radial-gradient(circle,rgb(168_85_247/0.35),transparent_60%)]" />
          <div
            className="stage-light absolute -right-1/4 -bottom-1/4 size-[70vmax] rounded-full bg-[radial-gradient(circle,rgb(59_130_246/0.3),transparent_60%)]"
            style={{ animationDelay: '-7s' }}
          />
        </div>
      )}
      <div className={view === 'slide' ? 'relative size-full' : 'hidden'}>
        <div
          key={revealedAt}
          className={`size-full ${hiddenTitle !== null ? 'slide-hidden' : revealedAt ? 'slide-reveal' : ''}`}
        >
          <SlideCanvas deck={deck} slide={slide} />
        </div>
        {curtain && <Curtains opening={curtain === 'opening'} />}
        {hiddenTitle !== null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 text-center">
            <p className="max-w-[80vw] text-[6vh] font-semibold text-white drop-shadow-lg">
              {curtain ? (
                hiddenTitle
              ) : (
                // Awards after the first (which has the curtains): the title types in.
                <TypedTitle key={hiddenTitle} text={hiddenTitle} />
              )}
            </p>
            {countdown && <Countdown seconds={countdown.seconds} startedAt={countdown.startedAt} />}
          </div>
        )}
      </div>
      {view === 'video' && videos[videoIndex] && (
        <VideoPlayer
          video={videos[videoIndex]}
          onEnded={endVideo}
          onError={nextVideo}
          controlsRef={videoControls}
          className={
            videoLarge
              ? 'absolute inset-0'
              : `absolute ${mediaCorner} z-10 w-[30vw] min-w-72 rounded-xl shadow-2xl ring-1 ring-white/20`
          }
        />
      )}

      {videoTrack && (
        <div
          style={{ aspectRatio: tinaRatio }}
          className={`${
            tinaInCorner
              ? `absolute ${CORNERS[corner]} ${TINA_CORNER_SIZE[shape(tinaRatio)]} overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/20 transition-all duration-500`
              : `absolute top-1/2 left-1/2 ${TINA_LARGE_SIZE[shape(tinaRatio)]} -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl shadow-2xl ring-1 ring-white/20 transition-all duration-500`
          } ${agent.state === 'speaking' && settings.style === 'lively' ? 'speaking-glow ring-amber-300/60' : ''}`}
        >
          <VideoTrack
            trackRef={videoTrack}
            className="size-full object-cover"
            onResize={(e) => {
              const { videoWidth, videoHeight } = e.currentTarget;
              if (videoWidth && videoHeight) {
                setTinaRatio(videoWidth / videoHeight);
              }
            }}
          />
        </div>
      )}

      <div className="absolute top-3 left-3 rounded-full bg-black/60 px-3 py-1 text-xs text-white/90">
        {statusText} ·{' '}
        {view === 'slide'
          ? `Slide ${slide}/${deck.numPages}`
          : view === 'video'
            ? `Video (E: ${videoLarge ? 'smaller' : 'enlarge'} · V: stop)`
            : 'Tina view (S: slide)'}
        {onHold && ' · On hold (say “continue”)'}
        {music.playing && ` · ${music.song ? `♪ ${music.song}` : 'Music'} (M: stop)`}
      </div>

      {applauseAt > 0 && <ApplauseCrowd key={applauseAt} photoUrl={ovationUrl} />}
      {music.youtube && (
        <MusicCard
          id={music.youtube.id}
          start={music.youtube.start}
          onPlayer={music.onYouTubePlayer}
          onEnded={music.stop}
          title={music.song ?? 'Walk-up music'}
          className={`fixed ${mediaCorner} z-50`}
        />
      )}

      {/* Operator controls: faint until hovered, so they don't distract the audience. */}
      <div className="absolute bottom-4 left-4 flex gap-2 opacity-20 transition-opacity focus-within:opacity-100 hover:opacity-100">
        <Button
          size="icon"
          variant="secondary"
          aria-label="Previous slide"
          onClick={() => goTo(slide - 1)}
        >
          <CaretLeftIcon />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          aria-label="Next slide"
          onClick={() => goTo(slide + 1)}
        >
          <CaretRightIcon />
        </Button>
        <Button
          variant="secondary"
          onClick={() => (view === 'slide' ? setView('tina') : showSlide())}
        >
          {view === 'slide' ? 'Show Tina (T)' : 'Show slide (S)'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setCorner((c) => (c + 1) % CORNERS.length)}
          disabled={!tinaInCorner}
        >
          Move Tina (C)
        </Button>
        <Button
          size="icon"
          variant="secondary"
          aria-label="Full screen"
          onClick={() => void document.documentElement.requestFullscreen()}
        >
          <ArrowsOutIcon />
        </Button>
        <Button variant="destructive" onClick={onEnd}>
          <StopIcon /> End ceremony
        </Button>
      </div>

      {connectionState === 'disconnected' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <div className="bg-background text-foreground flex flex-col items-center gap-3 rounded-xl p-6 text-center">
            <p className="font-semibold">Tina got disconnected</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              Reconnect to continue. Awards already announced stay on this laptop; Tina will pick up
              the list again.
            </p>
            <div className="flex gap-2">
              <Button onClick={onReconnect}>Reconnect Tina</Button>
              <Button variant="outline" onClick={onEnd}>
                Back to setup
              </Button>
            </div>
          </div>
        </div>
      )}
      {connectionState === 'connecting' && (
        <div className="absolute top-3 right-3 text-white/80">
          <CircleNotchIcon weight="bold" className="size-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
