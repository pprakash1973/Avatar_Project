'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { LoadedEventSlides } from '@/components/ceremony/event-slides';
import { HologramReveal, PreRevealOrb } from '@/components/ceremony/hologram-reveal';
import { LuckyDraw } from '@/components/ceremony/lucky-draw';
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
  EVENT_SLIDE_SECONDS,
  SUSPENSE_TRACKS,
  type SectionDeck,
  loadOvationPhoto,
  programAwards,
  slideOffsets,
} from '@/lib/ceremony';
import { HOST_CHANNEL, type HostMessage, type HostState, hostLists } from '@/lib/host-channel';
import { type PDFDocumentProxy, type PageRender, renderPage } from '@/lib/pdf';

// A slide that fails to draw is tried again this many times, this far apart.
const SLIDE_RETRIES = 3;
const SLIDE_RETRY_MS = 400;

/** The slide, fitted to its box; `redraw` changing draws it afresh ("reload the slide"). */
function SlideCanvas({
  deck,
  slide,
  redraw,
}: {
  deck: PDFDocumentProxy;
  slide: number;
  redraw: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }
    let stopped = false;
    let current: PageRender | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // One drawing at a time: a new one (resize, reload) cancels the last.
    const draw = (attempt = 0) => {
      clearTimeout(retry);
      current?.cancel();
      const { clientWidth: width, clientHeight: height } = container;
      if (stopped || !width || !height) {
        // Hidden: drawn when it's shown (the resize observer fires then).
        return;
      }
      const render = renderPage(deck, slide, width, height);
      current = render;
      render.done.then(
        (image) => {
          if (stopped || current !== render) {
            return;
          }
          // Swap the finished drawing in, all at once.
          const ratio = window.devicePixelRatio || 1;
          canvas.width = image.width;
          canvas.height = image.height;
          canvas.style.width = `${Math.floor(image.width / ratio)}px`;
          canvas.style.height = `${Math.floor(image.height / ratio)}px`;
          canvas.getContext('2d')?.drawImage(image, 0, 0);
        },
        (error) => {
          if (stopped || current !== render) {
            return;
          }
          console.warn('slide did not draw', error);
          if (attempt < SLIDE_RETRIES) {
            retry = setTimeout(() => draw(attempt + 1), SLIDE_RETRY_MS);
          }
        }
      );
    };
    draw();
    const observer = new ResizeObserver(() => draw());
    observer.observe(container);
    return () => {
      stopped = true;
      clearTimeout(retry);
      current?.cancel();
      observer.disconnect();
    };
  }, [deck, slide, redraw]);

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
// Each award's curtains: how long they take to open (matches globals.css), and,
// without the suspense reveal, how long they stay closed on the slide.
const CURTAIN_OPEN_MS = 2600;
// After the reveal, the countdown music's final hit rings this long before fading.
const COUNTDOWN_MUSIC_TAIL_MS = 2500;
// How much "Tina, louder" / "softer" changes the music or video volume.
const VOLUME_STEP = 0.2;
const CURTAIN_CLOSED_MS = 1500;
// Without the entrance's start from Tina (an older agent), she appears anyway this long
// after her video arrives.
const REVEAL_FAILSAFE_AFTER_VIDEO_MS = 20_000;
// An event's name stays over Tina this long (e.g. through the lamp lighting).
const EVENT_TITLE_MS = 2 * 60 * 1000;

/** An event's own slides: one stays up; several take turns every EVENT_SLIDE_SECONDS. */
function EventSlideshow({ slides, startedAt }: { slides: LoadedEventSlides; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (slides.count < 2) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [slides.count]);
  const index =
    slides.count > 1
      ? Math.floor(Math.max(0, now - startedAt) / (EVENT_SLIDE_SECONDS * 1000)) % slides.count
      : 0;
  return (
    <div key={index} className="event-slide-fade absolute inset-0">
      {slides.pdf ? (
        <SlideCanvas deck={slides.pdf} slide={index + 1} redraw={0} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={slides.images?.[index]}
          alt={`Slide ${index + 1}`}
          className="size-full object-contain"
        />
      )}
    </div>
  );
}

/** Red stage curtains over an award's slide; they part when `opening`. `label`: a new
 * award section's name, in gold on the valance. */
function Curtains({ opening, label }: { opening: boolean; label: string | null }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden ${opening ? 'curtains-opening' : ''}`}
    >
      <div className="curtain curtain-left" />
      <div className="curtain curtain-right" />
      <div className="curtain-valance" />
      {label && <div className="curtain-label">{label}</div>}
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
  muted: 'Tina is muted',
  thinking: 'Tina is thinking…',
  speaking: 'Tina is speaking',
};

// The finished lucky number stays up this long before Tina returns to the middle.
const DRAW_HOLD_MS = 2 * 60 * 1000;

interface CeremonyStageProps {
  /** The award sections' PDFs, in order; Tina numbers their slides one after another. */
  decks: SectionDeck<PDFDocumentProxy>[];
  /** The events' own slides, by their slides' id. */
  eventSlides: Record<string, LoadedEventSlides>;
  awards: Award[];
  settings: CeremonySettings;
  onReconnect: () => void;
  onEnd: () => void;
}

export function CeremonyStage({
  decks,
  eventSlides,
  awards,
  settings,
  onReconnect,
  onEnd,
}: CeremonyStageProps) {
  const { room, isConnected, connectionState } = useSessionContext();
  const agent = useAgent();
  const { videoTrack } = useVoiceAssistant();
  const [slide, setSlide] = useState(1);
  const [isLive, setIsLive] = useState(false);
  // 'tina': Tina large in the middle (default, and during breaks).
  // 'slide': the slide fills the screen and Tina moves to the corner.
  // 'video': Tina large in the middle, a YouTube video in a small corner window
  // (E enlarges it to fill the screen, Tina then in the corner).
  // 'draw': the lucky draw fills the screen, Tina in the corner.
  // 'event': the event's own slides fill the screen until the next event or award.
  const [view, setView] = useState<'tina' | 'slide' | 'video' | 'draw' | 'event'>('tina');
  const [eventShow, setEventShow] = useState<{ id: string; at: number } | null>(null);
  const eventSlidesRef = useRef(eventSlides);
  eventSlidesRef.current = eventSlides;
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
  // Each award's slide opens with stage curtains (further winners on it don't); the
  // first of a new award section shows the section's name on them.
  const [curtain, setCurtain] = useState<'closed' | 'opening' | null>(null);
  const [curtainLabel, setCurtainLabel] = useState<string | null>(null);
  const shownSection = useRef('');
  // The host's mute key: Tina neither hears nor speaks (re-applied after a reconnect).
  const [muted, setMuted] = useState(false);
  const muteWanted = useRef(false);
  // The lucky draw on screen: its digits fall in as Tina calls them.
  const [draw, setDraw] = useState<{
    id: number;
    seconds: number;
    startedAt: number;
    digits: number;
    shown: string[];
    from?: number;
    to?: number;
    round?: number;
    rounds?: number;
  } | null>(null);
  // What's done (from Tina), for the host's panel.
  const [progress, setProgress] = useState<{
    eventsDone: string[];
    awardsDone: Record<string, number>;
    askAi: boolean;
    luckyNumbers: number[];
  }>({ eventsDone: [], awardsDone: {}, askAi: false, luckyNumbers: [] });
  // Tina's entrance: hidden behind a glowing orb until it starts, then she materializes
  // as a hologram for `ms`.
  const [entrance, setEntrance] = useState<{
    phase: 'waiting' | 'playing' | 'done';
    ms: number;
  }>(() => ({ phase: settings.intro_reveal ? 'waiting' : 'done', ms: 0 }));
  // The event Tina is opening ("Lamp Lighting"), typed in above her.
  // sticky: kept up until the event ends (Ask AI), not just for EVENT_TITLE_MS.
  const [eventTitle, setEventTitle] = useState<{
    name: string;
    at: number;
    sticky?: boolean;
  } | null>(null);
  // The slide and award the curtains last opened on: further winners on it (a team)
  // don't get them; every other award does (also one sharing a slide number).
  const curtainFor = useRef('');
  // The award title was just typed above Tina (its introduction): not typed again.
  const [titleTyped, setTitleTyped] = useState(false);
  const eventName = useRef('');
  // Corner for Tina's small window over slides; C moves it if it covers a face or text.
  const [corner, setCorner] = useState(0);
  // Tina's video shape (width / height): square for classic faces; Trinity-2 faces
  // stream tall (standing) or wide.
  const [tinaRatio, setTinaRatio] = useState(1);
  const [slideShownAt, setSlideShownAt] = useState(0);
  // Bumped to draw the slide afresh ("Tina, the slide didn't come up", or L).
  const [slideRedraw, setSlideRedraw] = useState(0);
  const slideRef = useRef(slide);
  slideRef.current = slide;
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
  // Slides are numbered across the sections' PDFs, in order.
  const { offsets, total: totalSlides } = slideOffsets(decks);
  const locate = (n: number) => {
    for (const d of decks) {
      const first = offsets[d.id];
      if (d.doc && n > first && n <= first + d.doc.numPages) {
        return { doc: d.doc, page: n - first };
      }
    }
    return null;
  };
  // The awards as Tina gets them: section names, slides numbered across the PDFs.
  const program = useMemo(() => programAwards(awards, decks), [awards, decks]);
  const programRef = useRef({ awards: program, settings });
  programRef.current = { awards: program, settings };

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
    musicRef.current.endCountdown(COUNTDOWN_MUSIC_TAIL_MS);
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
    (n: number) => setSlide(Math.min(Math.max(1, n), Math.max(1, totalSlides))),
    [totalSlides]
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

  // The entrance ends after its length; without a start from Tina, she appears anyway.
  useEffect(() => {
    if (entrance.phase === 'playing') {
      const timer = setTimeout(() => setEntrance({ phase: 'done', ms: 0 }), entrance.ms);
      return () => clearTimeout(timer);
    }
    if (entrance.phase === 'waiting' && videoTrack) {
      const timer = setTimeout(
        () => setEntrance({ phase: 'done', ms: 0 }),
        REVEAL_FAILSAFE_AFTER_VIDEO_MS
      );
      return () => clearTimeout(timer);
    }
  }, [entrance, videoTrack]);

  // The finished lucky number stays up a while, then Tina returns to the middle.
  const drawComplete = draw !== null && draw.shown.length >= draw.digits;
  useEffect(() => {
    if (view !== 'draw' || !drawComplete) {
      return;
    }
    const timer = setTimeout(() => setView('tina'), DRAW_HOLD_MS);
    return () => clearTimeout(timer);
  }, [view, drawComplete]);

  useEffect(() => {
    if (!eventTitle || eventTitle.sticky) {
      return;
    }
    const timer = setTimeout(() => setEventTitle(null), EVENT_TITLE_MS);
    return () => clearTimeout(timer);
  }, [eventTitle]);

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
          // A new Tina after a reconnect starts unmuted: mute her again if the host had.
          if (muteWanted.current) {
            void room.localParticipant
              .sendText(JSON.stringify({ type: 'command', action: 'mute', name: '' }), {
                topic: CEREMONY_EVENTS_TOPIC,
              })
              .catch(() => {});
          }
        } else if (status.type === 'progress') {
          // What's done, for the host's panel.
          setProgress({
            eventsDone: Array.isArray(status.events_done) ? status.events_done : [],
            awardsDone:
              status.awards_done && typeof status.awards_done === 'object'
                ? status.awards_done
                : {},
            askAi: Boolean(status.ask_ai),
            luckyNumbers: Array.isArray(status.lucky_numbers) ? status.lucky_numbers : [],
          });
          setMuted(Boolean(status.muted));
        } else if (status.type === 'mute') {
          setMuted(Boolean(status.on));
        } else if (status.type === 'lucky_draw') {
          // The jar spins to suspense music; the digits follow one by one.
          if (viewRef.current === 'video') {
            endVideo();
          }
          const seconds = Number(status.seconds) || 30;
          setDraw({
            id: Number(status.id),
            seconds,
            startedAt: Date.now(),
            digits: Number(status.digits) || 4,
            shown: [],
            from: typeof status.from === 'number' ? status.from : undefined,
            to: typeof status.to === 'number' ? status.to : undefined,
            round: Number(status.round) || undefined,
            rounds: Number(status.rounds) || undefined,
          });
          setView('draw');
          musicRef.current.playCountdown(seconds);
        } else if (status.type === 'lucky_digit') {
          if (Number(status.index) === 0) {
            // The jar has stopped: the suspense music's hit rings, then fades.
            musicRef.current.endCountdown(COUNTDOWN_MUSIC_TAIL_MS);
          }
          setDraw((d) => {
            if (!d || d.id !== Number(status.id)) {
              return d;
            }
            const shown = [...d.shown];
            shown[Number(status.index) || 0] = String(status.digit ?? '');
            return { ...d, shown };
          });
        } else if (status.type === 'lucky_draw_cancel') {
          // Muted, or the host moved on, before the number came out.
          setDraw((d) => {
            if (d && d.id === Number(status.id)) {
              musicRef.current.endCountdown(0);
              if (viewRef.current === 'draw') {
                setView('tina');
              }
              return null;
            }
            return d;
          });
        } else if (status.type === 'intro_reveal') {
          setEntrance({ phase: 'playing', ms: (Number(status.seconds) || 10) * 1000 });
        } else if (status.type === 'event') {
          // A programme item, e.g. the lamp lighting: the music or video makes way.
          if (viewRef.current === 'video') {
            endVideo();
          }
          musicRef.current.stop();
          setDraw(null);
          eventName.current = String(status.name || '');
          // The event's own slides, if it has them, until the next event or award.
          const own = programRef.current.settings.events.find(
            (e) => e.name.trim() === eventName.current.trim()
          )?.slides;
          if (own && eventSlidesRef.current[own.id]) {
            setEventShow({ id: own.id, at: Date.now() });
            setView('event');
          } else {
            setEventShow(null);
          }
          setEventTitle({
            name: eventName.current,
            at: Date.now(),
            sticky: Boolean(status.sticky),
          });
        } else if (status.type === 'event_music') {
          // The event's music once Tina has said its text, e.g. for the lamp lighting.
          if (viewRef.current === 'video') {
            endVideo();
          }
          musicRef.current.playFor(
            String(status.url || ''),
            Number(status.seconds) || 60,
            String(status.name || 'Music')
          );
        } else if (status.type === 'event_end') {
          setEventTitle(null);
        } else if (status.type === 'ceremony_end') {
          // "Tina, let's end the award ceremony": Tina says goodbye full screen.
          if (viewRef.current === 'video') {
            endVideo();
          }
          musicRef.current.stop();
          setHiddenTitle(null);
          setDraw(null);
          setView('tina');
          setEventTitle({ name: 'Thank you!', at: Date.now(), sticky: true });
        } else if (status.type === 'slide') {
          if (status.title) {
            setEventTitle(null);
            setTitleTyped(eventName.current === String(status.title));
            eventName.current = '';
          }
          setDraw(null);
          showSlide(Number(status.slide) || 1);
          // Award slides carry their category; each new award opens with curtains, on
          // the winner's name (or shortly, without the suspense reveal). The first of
          // a new award section shows its name on them, and stays closed a little longer.
          const key = `${Number(status.slide)}|${String(status.title || '')}`;
          if (status.title && key !== curtainFor.current) {
            curtainFor.current = key;
            const section = String(status.section || '');
            const newSection = section !== '' && section !== shownSection.current;
            shownSection.current = section;
            setCurtainLabel(newSection ? section : null);
            setCurtain('closed');
            if (!status.hidden) {
              setTimeout(openCurtain, CURTAIN_CLOSED_MS * (newSection ? 2 : 1));
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
        } else if (status.type === 'volume') {
          // "Tina, louder" / "Tina, softer": the video if one plays, else the music.
          const step = status.change === 'down' ? -VOLUME_STEP : VOLUME_STEP;
          if (viewRef.current === 'video' && videoControls.current) {
            videoControls.current.changeVolume(step);
          } else {
            musicRef.current.changeVolume(step);
          }
        } else if (status.type === 'music_stop') {
          musicRef.current.stop();
        } else if (status.type === 'suspense') {
          const seconds = Number(status.seconds) || 5;
          setCountdown({ seconds, startedAt: Date.now() });
          if (programRef.current.settings.suspense_music) {
            musicRef.current.playCountdown(seconds);
          }
        } else if (status.type === 'reveal') {
          reveal();
        } else if (status.type === 'video' && Array.isArray(status.videos)) {
          musicRef.current.stop();
          setDraw(null);
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
        } else if (status.type === 'slide_reload') {
          // The slide came up wrong (blank, garbled, still blurred): show it afresh.
          reveal();
          setCurtain(null);
          setSlideRedraw(Date.now());
          showSlide();
        } else if (status.type === 'slide_step') {
          showSlide(slideRef.current + (Number(status.step) || 0));
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

  // Tina is hosting: her "ceremony live" signal, or simply her listening or speaking (a
  // brief reconnect cleared the signal once and left the host's remote disabled).
  const tinaLive =
    isConnected && (isLive || ['listening', 'thinking', 'speaking'].includes(agent.state));
  // The host's panel (another window on the laptop screen): its clicks go to Tina, and
  // it's kept up to date with what's happening.
  const hostState: HostState = {
    kind: 'state',
    live: tinaLive,
    connection: connectionState,
    agentState: agent.state,
    now:
      view === 'tina' || view === 'draw' || view === 'event'
        ? (eventTitle?.name ?? null)
        : hiddenTitle || null,
    music: music.playing ? (music.song ?? 'Walk-up music') : null,
    onHold,
    muted,
    askAi: progress.askAi,
    ...hostLists(settings, awards, decks),
    eventsDone: progress.eventsDone,
    awardsDone: progress.awardsDone,
    luckyNumbers: progress.luckyNumbers,
  };
  // Settings saved again during the ceremony (on the settings page): Tina gets them too.
  const programKey = JSON.stringify({ awards: program, settings });
  const sentProgram = useRef(programKey);
  useEffect(() => {
    if (!isLive || programKey === sentProgram.current) {
      return;
    }
    sentProgram.current = programKey;
    void room.localParticipant
      .sendText(programKey, { topic: CEREMONY_AWARDS_TOPIC })
      .catch((error) => console.error('could not send the new settings to Tina', error));
  }, [isLive, programKey, room]);
  const hostStateRef = useRef(hostState);
  hostStateRef.current = hostState;
  const hostChannel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    const channel = new BroadcastChannel(HOST_CHANNEL);
    hostChannel.current = channel;
    channel.onmessage = (e: MessageEvent<HostMessage>) => {
      if (e.data.kind === 'command') {
        const { action, name } = e.data;
        // Music is played here, straight away (Tina hears that it's playing).
        if (action === 'song') {
          const song = programRef.current.settings.songs.find((s) => s.name.trim() === name);
          if (song) {
            musicRef.current.playSong(song.url, song.name.trim());
          }
          return;
        }
        if (action === 'suspense') {
          const track = SUSPENSE_TRACKS[Math.floor(Math.random() * SUSPENSE_TRACKS.length)];
          musicRef.current.playSong(track, 'Suspense music');
          return;
        }
        if (action === 'stop_music') {
          musicRef.current.stop();
          return;
        }
        if (action === 'mute' || action === 'unmute') {
          muteWanted.current = action === 'mute';
        }
        void room.localParticipant
          .sendText(JSON.stringify({ type: 'command', action, name: name ?? '' }), {
            topic: CEREMONY_EVENTS_TOPIC,
          })
          .catch((error) => console.error('could not send the click to Tina', error));
      } else if (e.data.kind === 'hello') {
        channel.postMessage(hostStateRef.current);
      }
    };
    // A heartbeat: the panel can tell the stage window is still open.
    const heartbeat = setInterval(() => channel.postMessage(hostStateRef.current), 2000);
    return () => {
      clearInterval(heartbeat);
      channel.close();
      hostChannel.current = null;
    };
  }, [room]);
  const hostStateKey = JSON.stringify(hostState);
  useEffect(() => {
    hostChannel.current?.postMessage(JSON.parse(hostStateKey));
  }, [hostStateKey]);

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
      } else if (e.key.toLowerCase() === 'l') {
        // Reload: the slide came up wrong.
        reveal();
        setSlideRedraw(Date.now());
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
  const tinaInCorner =
    view === 'slide' || view === 'draw' || view === 'event' || (view === 'video' && videoLarge);
  // Videos and music cards go in a corner Tina isn't using.
  const mediaCorner =
    tinaInCorner && CORNERS[corner].includes('right') ? 'left-3 bottom-16' : 'right-3 bottom-3';

  const statusText = !isConnected
    ? connectionState === 'disconnected'
      ? 'Disconnected'
      : 'Connecting…'
    : !tinaLive
      ? 'Tina is getting ready…'
      : muted
        ? STATE_LABELS.muted
        : (STATE_LABELS[agent.state] ?? 'Tina is ready');

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-black">
      {!tinaInCorner && (
        // Slow, soft stage lights behind Tina (dimmed until her entrance).
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 transition-opacity duration-[2000ms] ${
            entrance.phase === 'waiting' ? 'opacity-15' : 'opacity-60'
          }`}
        >
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
          {(() => {
            const at = locate(slide);
            return at ? <SlideCanvas deck={at.doc} slide={at.page} redraw={slideRedraw} /> : null;
          })()}
        </div>
        {curtain && <Curtains opening={curtain === 'opening'} label={curtainLabel} />}
        {hiddenTitle !== null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 text-center">
            <p className="max-w-[80vw] text-[6vh] font-semibold text-white drop-shadow-lg">
              {titleTyped ? (
                // Already typed in above Tina with the award's introduction.
                hiddenTitle
              ) : (
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

      {view === 'event' && eventShow && eventSlides[eventShow.id] && (
        <EventSlideshow
          key={eventShow.at}
          slides={eventSlides[eventShow.id]}
          startedAt={eventShow.at}
        />
      )}
      {view === 'draw' && draw && (
        <LuckyDraw
          key={draw.id}
          seconds={draw.seconds}
          startedAt={draw.startedAt}
          digits={draw.digits}
          shown={draw.shown}
          round={draw.round}
          rounds={draw.rounds}
        />
      )}
      {(view === 'tina' || view === 'draw') && eventTitle?.name && (
        <p className="absolute inset-x-0 top-[3vh] z-10 px-[5vw] text-center text-[5vh] leading-tight font-semibold drop-shadow-lg">
          <TypedTitle key={eventTitle.at} text={eventTitle.name} />
        </p>
      )}
      {entrance.phase === 'waiting' && <PreRevealOrb />}
      {videoTrack && (
        <div
          style={
            {
              aspectRatio: tinaRatio,
              '--reveal-ms': `${entrance.ms}ms`,
            } as React.CSSProperties
          }
          className={`${
            entrance.phase === 'waiting'
              ? 'opacity-0'
              : entrance.phase === 'playing'
                ? 'hologram-materialize'
                : ''
          } ${
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
          {entrance.phase === 'playing' && (
            <div aria-hidden className="hologram-scanlines pointer-events-none absolute inset-0" />
          )}
        </div>
      )}
      {entrance.phase === 'playing' && (
        <HologramReveal seconds={entrance.ms / 1000} volume={settings.walkup_volume} />
      )}

      <div className="absolute top-3 left-3 rounded-full bg-black/60 px-3 py-1 text-xs text-white/90">
        {statusText} ·{' '}
        {view === 'slide'
          ? `Slide ${slide}/${totalSlides} (L: reload)`
          : view === 'video'
            ? `Video (E: ${videoLarge ? 'smaller' : 'enlarge'} · V: stop)`
            : view === 'draw'
              ? 'Lucky draw (T: Tina)'
              : view === 'event'
                ? 'Event slides (T: Tina)'
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
