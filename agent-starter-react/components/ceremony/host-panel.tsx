'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircleIcon,
  CircleNotchIcon,
  PauseIcon,
  PlayIcon,
  SpeakerSimpleSlashIcon,
  StopIcon,
  WarningIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import type { Award, CeremonySettings } from '@/lib/ceremony';
import {
  HOST_CHANNEL,
  type HostAction,
  type HostMessage,
  type HostState,
  hostLists,
  openStageWindow,
} from '@/lib/host-channel';

// The stage sends its state every 2 seconds; without it for this long, it's closed.
const STAGE_GONE_MS = 5000;
// A click shows as "sent" until Tina's state changes, or this long.
const CLICK_FEEDBACK_MS = 4000;

const AGENT_LABELS: Record<string, string> = {
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  initializing: 'Getting ready…',
};

/**
 * The host's controls, on the laptop screen (never on the TV): every event and the
 * awards at a click, so the host never has to call Tina twice. Clicks go to Tina
 * through the stage window and are done straight away.
 */
export function HostPanel({
  settings,
  awards: awardList,
}: {
  settings: CeremonySettings;
  awards: Award[];
}) {
  const [state, setState] = useState<HostState | null>(null);
  const [lastSeen, setLastSeen] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [clicked, setClicked] = useState<{ key: string; at: number } | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const ch = new BroadcastChannel(HOST_CHANNEL);
    channel.current = ch;
    ch.onmessage = (e: MessageEvent<HostMessage>) => {
      if (e.data.kind === 'state') {
        setState(e.data);
        setLastSeen(Date.now());
      }
    };
    ch.postMessage({ kind: 'hello' } satisfies HostMessage);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      ch.close();
    };
  }, []);

  const send = useCallback((action: HostAction, name = '') => {
    channel.current?.postMessage({ kind: 'command', action, name } satisfies HostMessage);
    setClicked({ key: `${action}:${name}`, at: Date.now() });
  }, []);
  const sending = (action: HostAction, name = '') =>
    clicked?.key === `${action}:${name}` && now - clicked.at < CLICK_FEEDBACK_MS;

  const stageOpen = state !== null && now - lastSeen < STAGE_GONE_MS;
  const ready = stageOpen && state.live;
  // What Tina has (from the stage), else the saved settings: the lists show before the
  // stage opens, and refresh when the settings are saved.
  const view = stageOpen
    ? state
    : {
        ...hostLists(settings, awardList),
        eventsDone: [] as string[],
        awardsDone: {} as Record<string, number>,
        askAi: false,
        onHold: false,
        music: null as string | null,
        now: null as string | null,
      };
  const winners = view.awards.reduce((n, a) => n + a.winners, 0);
  const announced = view.awards.reduce(
    (n, a) => n + Math.min(a.winners, view.awardsDone[a.category] ?? 0),
    0
  );
  const nextAward = view.awards.find((a) => (view.awardsDone[a.category] ?? 0) < a.winners);

  return (
    <div className="mt-6 flex flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        A click here makes Tina act at once, no need to call her. Keep this page on the laptop
        screen; only the stage window goes on the TV (Windows: Win+P → Extend). Saving the settings
        updates this list and Tina.
      </p>

      <div
        role="status"
        className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border p-3 text-sm ${
          ready ? '' : 'border-amber-500/60 bg-amber-500/10'
        }`}
      >
        {!stageOpen ? (
          <>
            <WarningIcon className="size-5 text-amber-600" />
            <span className="flex-1">The stage isn&rsquo;t open yet.</span>
            <Button size="sm" onClick={openStageWindow}>
              Open the stage window
            </Button>
          </>
        ) : !state.live ? (
          <>
            <CircleNotchIcon className="size-5 animate-spin" /> Tina is getting ready…
          </>
        ) : (
          <>
            <span className="flex items-center gap-2 font-medium">
              <span
                className={`size-2.5 rounded-full ${
                  state.agentState === 'speaking' ? 'bg-green-500' : 'bg-sky-500'
                }`}
              />
              Tina: {AGENT_LABELS[state.agentState] ?? state.agentState}
            </span>
            {state.now && <span className="text-muted-foreground">Now: {state.now}</span>}
            {state.onHold && <span className="font-medium text-amber-600">Paused</span>}
            {state.askAi && <span className="text-muted-foreground">Ask AI on</span>}
            {state.music && <span className="text-muted-foreground">♪ {state.music}</span>}
          </>
        )}
      </div>

      <section className="rounded-xl border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Awards</h2>
          <span className="text-muted-foreground text-xs">
            {announced} of {winners} winners announced
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            size="lg"
            className="col-span-2 h-auto justify-start py-3 text-left whitespace-normal"
            disabled={!ready || !nextAward}
            onClick={() => send('next_award')}
          >
            {sending('next_award') ? (
              <CircleNotchIcon className="size-5 animate-spin" />
            ) : (
              <PlayIcon weight="fill" className="size-5" />
            )}
            <span>
              {!nextAward
                ? winners === 0
                  ? 'No awards loaded (Awards tab)'
                  : 'All awards announced'
                : announced === 0
                  ? `Start the awards: ${nextAward.category}`
                  : `Next award: ${nextAward.category}`}
            </span>
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={!ready || view.onHold}
            onClick={() => send('pause')}
          >
            <PauseIcon weight="fill" className="size-5" /> Pause
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={!ready || !view.onHold}
            onClick={() => send('resume')}
          >
            <PlayIcon weight="fill" className="size-5" /> Resume
          </Button>
          <Button
            variant="destructive"
            size="lg"
            className="col-span-2"
            disabled={!ready}
            onClick={() => {
              const left = winners - announced;
              if (
                window.confirm(
                  left > 0
                    ? `${left} winner${left === 1 ? ' is' : 's are'} not announced yet. End the awards anyway?`
                    : 'End the awards? Tina thanks everyone and the screen shows "Thank you!".'
                )
              ) {
                send('end_awards');
              }
            }}
          >
            <StopIcon weight="fill" className="size-5" /> Exit the awards
          </Button>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          Pause holds the next winner (Tina finishes the sentence she&rsquo;s saying); Resume
          carries on.
        </p>
        {view.awards.length > 0 && (
          <details className="mt-3">
            <summary className="text-muted-foreground cursor-pointer text-xs">
              All awards ({view.awards.length} categories)
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {view.awards.map((a) => {
                const done = Math.min(a.winners, view.awardsDone[a.category] ?? 0);
                return (
                  <li key={a.category} className="flex items-center gap-2 text-sm">
                    <button
                      type="button"
                      aria-label={`Announce ${a.category}`}
                      disabled={!ready}
                      onClick={() => send('award', a.category)}
                      className="hover:bg-accent rounded-full border p-1.5 disabled:opacity-40"
                    >
                      {sending('award', a.category) ? (
                        <CircleNotchIcon className="size-4 animate-spin" />
                      ) : (
                        <PlayIcon weight="fill" className="size-4" />
                      )}
                    </button>
                    <span className="flex-1">{a.category}</span>
                    {done === a.winners ? (
                      <CheckCircleIcon weight="fill" className="size-4 text-green-600" />
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        {done}/{a.winners}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </section>

      <section className="rounded-xl border p-4">
        <h2 className="text-sm font-semibold">Events</h2>
        {view.events.length === 0 && (
          <p className="text-muted-foreground mt-2 text-xs">No events on the Events tab.</p>
        )}
        <ul className="mt-3 flex flex-col gap-2">
          {view.events.map((event) => {
            const done = view.eventsDone.includes(event.name);
            const current = view.now === event.name;
            return (
              <li
                key={event.name}
                className={`flex items-center gap-3 rounded-lg border p-2 ${
                  current ? 'border-sky-500 bg-sky-500/10' : ''
                }`}
              >
                <Button
                  size="icon"
                  aria-label={`Start ${event.name}`}
                  disabled={!ready}
                  onClick={() => send('event', event.name)}
                >
                  {sending('event', event.name) ? (
                    <CircleNotchIcon className="size-4 animate-spin" />
                  ) : (
                    <PlayIcon weight="fill" className="size-4" />
                  )}
                </Button>
                <span className="flex-1 text-sm font-medium">
                  {event.name}
                  {event.kind === 'ask_ai' && (
                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                      audience Q&amp;A
                    </span>
                  )}
                </span>
                {current && <span className="text-xs text-sky-600">Now</span>}
                {done && !current && (
                  <CheckCircleIcon weight="fill" className="size-5 text-green-600" />
                )}
                {event.kind === 'ask_ai' && view.askAi && (
                  <Button variant="outline" size="sm" onClick={() => send('end_ask_ai')}>
                    End Ask AI
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-xl border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Music</h2>
          {view.music && (
            <span className="text-muted-foreground text-xs">Playing: {view.music}</span>
          )}
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {[
            ...(view.songs ?? []).map((name) => ({ action: 'song' as const, name, label: name })),
            {
              action: 'suspense' as const,
              name: '',
              label: 'Suspense music (lucky draw, one minute)',
            },
          ].map((track) => (
            <li key={`${track.action}:${track.name}`} className="flex items-center gap-3">
              <Button
                size="icon"
                variant="secondary"
                aria-label={`Play ${track.label}`}
                disabled={!stageOpen}
                onClick={() => send(track.action, track.name)}
              >
                {sending(track.action, track.name) ? (
                  <CircleNotchIcon className="size-4 animate-spin" />
                ) : (
                  <PlayIcon weight="fill" className="size-4" />
                )}
              </Button>
              <span className="flex-1 text-sm">{track.label}</span>
            </li>
          ))}
        </ul>
        {view.songs.length === 0 && (
          <p className="text-muted-foreground mt-2 text-xs">
            Add songs on the Customise tab (Songs for breaks) to play them from here.
          </p>
        )}
        <Button
          variant="outline"
          className="mt-3 w-full"
          disabled={!stageOpen || !view.music}
          onClick={() => send('stop_music')}
        >
          <SpeakerSimpleSlashIcon className="size-5" /> Stop the music
        </Button>
      </section>
    </div>
  );
}
