'use client';

import { useEffect, useMemo } from 'react';
import { getSavedSpeakerId } from '@/lib/visitor';

// After each winner: a grey audience, seen from behind, stands up along the bottom
// of the screen and claps for a few seconds (like people getting up after a movie).

export const APPLAUSE_MS = 5000;

type SinkableAudioContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

/** A few seconds of synthesized applause: many short, filtered noise claps. */
async function playApplause(seconds: number) {
  const ctx: SinkableAudioContext = new AudioContext();
  const speakerId = getSavedSpeakerId();
  if (speakerId && ctx.setSinkId) {
    await ctx.setSinkId(speakerId).catch(() => {});
  }
  const clap = ctx.createBuffer(1, ctx.sampleRate * 0.03, ctx.sampleRate);
  const data = clap.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length / 5));
  }
  const master = ctx.createGain();
  // Swell in, hold, then fade out with the crowd.
  master.gain.setValueAtTime(0, ctx.currentTime);
  master.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 0.8);
  master.gain.setValueAtTime(0.35, ctx.currentTime + seconds - 1.2);
  master.gain.linearRampToValueAtTime(0, ctx.currentTime + seconds);
  master.connect(ctx.destination);
  for (let t = 0; t < seconds; t += 0.012) {
    const source = ctx.createBufferSource();
    source.buffer = clap;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900 + Math.random() * 1800;
    const gain = ctx.createGain();
    gain.gain.value = 0.3 + Math.random() * 0.7;
    source.connect(filter).connect(gain).connect(master);
    source.start(ctx.currentTime + t + Math.random() * 0.012);
  }
  setTimeout(() => void ctx.close(), (seconds + 0.5) * 1000);
}

type Person = {
  x: number;
  scale: number;
  delay: number;
  speed: number;
  spread: number;
  reach: number;
};

// People overlap like a packed hall; each raises their hands a little differently.
function makeRow(count: number, scale: number, offset: number): Person[] {
  return Array.from({ length: count }, (_, i) => ({
    x: (i + offset + (Math.random() - 0.5) * 0.5) * (1000 / count),
    scale: scale * (0.85 + Math.random() * 0.3),
    delay: Math.random() * 0.5,
    speed: 0.26 + Math.random() * 0.14,
    // 0: hands together over the head, 1: arms wide in a V.
    spread: Math.random(),
    reach: Math.random() * 25,
  }));
}

/** One person from behind: shoulders, head, and both arms raised high, clapping. */
function Person({ person, color }: { person: Person; color: string }) {
  const style = {
    animationDelay: `${person.delay}s`,
    '--clap-speed': `${person.speed}s`,
  } as React.CSSProperties;
  // Hands from close together over the head (0) to wide apart (1).
  const handX = 6 + person.spread * 30;
  const handY = 6 + person.reach;
  const elbowX = 10 + person.spread * 6;
  const transform = `translate(${person.x - 50 * person.scale} ${300 - 170 * person.scale}) scale(${person.scale})`;
  const arm = (side: 1 | -1) => {
    const x = (dx: number) => 50 + side * dx;
    return (
      <g className={side === -1 ? 'applause-arm-left' : 'applause-arm-right'}>
        <path
          d={`M${x(36)} 124 L${x(36 + elbowX)} 82 L${x(handX)} ${handY + 10}`}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <ellipse cx={x(handX)} cy={handY + 2} rx="5" ry="9" stroke="none" />
      </g>
    );
  };
  return (
    <g transform={transform}>
      <g className="applause-person" style={style} fill={color} stroke={color}>
        <path d="M-6 172 C-6 126 16 110 50 110 C84 110 106 126 106 172 Z" stroke="none" />
        <rect x="43" y="88" width="14" height="26" rx="5" stroke="none" />
        <circle cx="50" cy="74" r="19" stroke="none" />
        {arm(-1)}
        {arm(1)}
      </g>
    </g>
  );
}

export function ApplauseCrowd({ sound }: { sound: boolean }) {
  // New positions each time, so no two ovations look the same.
  const rows = useMemo(() => ({ back: makeRow(24, 0.85, 0), front: makeRow(16, 1.2, 0.5) }), []);

  useEffect(() => {
    if (sound) {
      void playApplause(APPLAUSE_MS / 1000).catch(() => {});
    }
  }, [sound]);

  return (
    <div
      aria-hidden
      className="applause-crowd pointer-events-none absolute inset-x-0 bottom-0 z-30 h-[40vh]"
    >
      <svg viewBox="0 0 1000 300" preserveAspectRatio="xMidYMax slice" className="size-full">
        {rows.back.map((p, i) => (
          <Person key={`b${i}`} person={p} color="#4a4f59" />
        ))}
        {rows.front.map((p, i) => (
          <Person key={`f${i}`} person={p} color="#6b7280" />
        ))}
      </svg>
    </div>
  );
}
