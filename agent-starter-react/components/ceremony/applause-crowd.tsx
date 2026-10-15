'use client';

import { useEffect } from 'react';
import { getSavedSpeakerId } from '@/lib/visitor';

// After each winner: a few seconds of applause, and, if the operator uploaded an
// ovation photo, that photo rising along the bottom of the screen.

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
  // Swell in, hold, then fade out.
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

export function ApplauseCrowd({ photoUrl }: { photoUrl: string | null }) {
  useEffect(() => {
    void playApplause(APPLAUSE_MS / 1000).catch(() => {});
  }, []);

  if (!photoUrl) {
    return null;
  }
  return (
    <div
      aria-hidden
      className="ovation pointer-events-none absolute inset-x-0 bottom-0 z-30 h-[30vh] overflow-hidden"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl}
        alt=""
        className="ovation-photo size-full object-cover object-bottom"
        style={{
          maskImage: 'linear-gradient(to top, black 55%, transparent)',
          WebkitMaskImage: 'linear-gradient(to top, black 55%, transparent)',
        }}
      />
    </div>
  );
}
