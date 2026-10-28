'use client';

import { useEffect, useRef } from 'react';
import { getSavedSpeakerId } from '@/lib/visitor';

type SinkableAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/** The spotlight entrance's music, each landing its big moment on FINAL_FLASH (18 s):
 * rock (a riff building into the full band, a crash on each big flash, a snare build
 * and a big hit) or cinematic (a drum roll and swelling chords, a pop for each flash
 * and a burst and chime). */
export const SPOTLIGHT_SOUNDS = {
  rock: '/sounds/tina_rock.mp3',
  cinematic: '/sounds/tina_spotlight.mp3',
} as const;
export type SpotlightMusic = keyof typeof SPOTLIGHT_SOUNDS;

// Fractions of the entrance: the big camera flashes that light Tina up a little more
// each time (the same moments as `spotlight-materialize` in globals.css and the sound),
// and the final burst that leaves her fully visible.
const BIG_FLASHES = [0.45, 0.55, 0.62, 0.68, 0.73, 0.78, 0.83];
const FINAL_FLASH = 0.9;
// The spotlights sweep until SWEEP_END, then swing onto Tina by LOCK_AT.
const SWEEP_END = 0.42;
const LOCK_AT = 0.68;

const BEAMS = 6;
const BEAM_HUES = [45, 300, 190, 45, 330, 200];
const GLITTER = 240;
const SMALL_FLASHES = 44;
const CONFETTI = 70;

/** Plays the spotlight entrance's music on the hall speaker. */
export function playSpotlightSound(volume: number, music: SpotlightMusic = 'rock') {
  const audio: SinkableAudio = new Audio(SPOTLIGHT_SOUNDS[music] ?? SPOTLIGHT_SOUNDS.rock);
  audio.volume = Math.min(1, Math.max(0, volume));
  const speakerId = getSavedSpeakerId();
  if (speakerId && audio.setSinkId) {
    void audio.setSinkId(speakerId).catch(() => {});
  }
  void audio.play().catch(() => {});
  return audio;
}

const clamp = (t: number) => Math.min(1, Math.max(0, t));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Tina's spotlight entrance, over the stage: coloured spotlights sweep and flicker
 * across the dark stage while glittering lights rain down and camera flashes pop, then
 * the spotlights swing onto her. Each big flash shows her a little more (the
 * `spotlight-materialize` class on her video), until a final burst leaves her fully
 * lit, with confetti and her name.
 */
export function SpotlightReveal({
  seconds,
  volume,
  music,
}: {
  seconds: number;
  volume: number;
  music: SpotlightMusic;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // The sound's tail rings on after the entrance: not stopped on unmount.
    playSpotlightSound(volume, music);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const width = (canvas.width = window.innerWidth);
    const height = (canvas.height = window.innerHeight);
    const cx = width / 2;
    const cy = height / 2;
    // Tina's picture: about 72-84% of the screen height.
    const tina = Math.min(height * 0.8, width * 0.9);
    const reach = Math.hypot(width, height) * 1.1;

    const beams = Array.from({ length: BEAMS }, (_, i) => {
      const x = width * (0.08 + (i * 0.84) / (BEAMS - 1));
      return {
        x,
        y: -height * 0.05,
        // Straight down, swinging either way.
        base: Math.PI / 2 + (i % 2 ? 0.25 : -0.25),
        speed: 0.7 + (i % 3) * 0.25,
        phase: i * 1.7,
        hue: BEAM_HUES[i % BEAM_HUES.length],
        // Pointing at Tina's face, once locked on.
        lock: Math.atan2(cy - height * 0.08 - -height * 0.05, cx - x),
      };
    });
    const glitter = Array.from({ length: GLITTER }, () => ({
      start: 0.18 + Math.random() * 0.75,
      x: cx + (Math.random() - 0.5) * width * (Math.random() < 0.6 ? 0.55 : 1),
      speed: height * (0.12 + Math.random() * 0.22),
      sway: Math.random() * Math.PI * 2,
      size: 0.8 + Math.random() * 2.4,
      gold: Math.random() < 0.65,
    }));
    const flashes = Array.from({ length: SMALL_FLASHES }, () => ({
      at: 0.28 + Math.random() * (FINAL_FLASH - 0.32),
      x: cx + (Math.random() - 0.5) * tina * 1.4,
      y: cy + (Math.random() - 0.5) * tina * 0.9,
      size: tina * (0.04 + Math.random() * 0.05),
    }));
    const confetti = Array.from({ length: CONFETTI }, () => ({
      angle: Math.random() * Math.PI * 2,
      speed: tina * (0.4 + Math.random() * 0.9),
      size: 2 + Math.random() * 4,
      hue: [45, 50, 330, 190, 0][Math.floor(Math.random() * 5)],
    }));

    const started = performance.now();
    let frame = 0;

    // A flash of light; `rays` adds a camera flash's star (the big flashes on Tina go
    // without: their rays crossed her face).
    const starBurst = (x: number, y: number, radius: number, alpha: number, rays = true) => {
      const glow = context.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, `rgba(255,255,255,${alpha})`);
      glow.addColorStop(0.25, `rgba(255,250,220,${alpha * 0.6})`);
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      if (!rays) {
        return;
      }
      context.strokeStyle = `rgba(255,255,255,${alpha * 0.8})`;
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(x - radius * 1.6, y);
      context.lineTo(x + radius * 1.6, y);
      context.moveTo(x, y - radius * 1.6);
      context.lineTo(x, y + radius * 1.6);
      context.stroke();
    };

    const draw = () => {
      const t = (performance.now() - started) / 1000;
      const p = clamp(t / seconds);
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'lighter';

      // The spotlights: sweeping and flickering, then swinging onto Tina, then fading
      // to a soft white glow on her after the final flash.
      const lock = easeInOut(clamp((p - SWEEP_END) / (LOCK_AT - SWEEP_END)));
      const fadeOut = 1 - clamp((p - FINAL_FLASH) / (1 - FINAL_FLASH));
      for (const [i, beam] of beams.entries()) {
        const sweep = beam.base + 0.55 * Math.sin(t * beam.speed + beam.phase);
        const angle =
          sweep + (beam.lock - sweep) * lock + (lock >= 1 ? 0.015 * Math.sin(t * 3 + i) : 0);
        // A flicker while sweeping (at most about twice a second), steady once locked.
        const flicker = lock < 1 && Math.sin(t * Math.PI * 2 * 0.9 + i * 2.1) < -0.55 ? 0.25 : 1;
        const alpha = (0.1 + 0.16 * clamp(p / 0.12) + 0.08 * lock) * flicker * fadeOut;
        if (alpha <= 0.002) {
          continue;
        }
        const spread = 0.085 - 0.03 * lock;
        const endX = beam.x + Math.cos(angle) * reach;
        const endY = beam.y + Math.sin(angle) * reach;
        const gradient = context.createLinearGradient(beam.x, beam.y, endX, endY);
        const hue = lock >= 1 ? 48 : beam.hue;
        const light = lock >= 1 ? 90 : 70;
        gradient.addColorStop(0, `hsla(${hue}, 100%, ${light}%, ${alpha * 1.6})`);
        gradient.addColorStop(0.6, `hsla(${hue}, 100%, ${light}%, ${alpha * 0.6})`);
        gradient.addColorStop(1, `hsla(${hue}, 100%, ${light}%, 0)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.moveTo(beam.x, beam.y);
        context.lineTo(
          beam.x + Math.cos(angle - spread) * reach,
          beam.y + Math.sin(angle - spread) * reach
        );
        context.lineTo(
          beam.x + Math.cos(angle + spread) * reach,
          beam.y + Math.sin(angle + spread) * reach
        );
        context.closePath();
        context.fill();
      }
      // Where the locked spotlights meet: a warm pool of light around her.
      if (lock > 0) {
        const pool = context.createRadialGradient(cx, cy, 0, cx, cy, tina * 0.7);
        pool.addColorStop(0, `rgba(255,236,190,${0.16 * lock * fadeOut})`);
        pool.addColorStop(1, 'rgba(255,236,190,0)');
        context.fillStyle = pool;
        context.fillRect(0, 0, width, height);
      }

      // Glittering lights raining down over the stage (and onto Tina).
      const glitterFade = 1 - clamp((p - 0.95) / 0.05);
      for (const g of glitter) {
        const age = t - g.start * seconds;
        if (age < 0) {
          continue;
        }
        const y = -10 + age * g.speed;
        if (y > height + 10) {
          continue;
        }
        const x = g.x + Math.sin(age * 2 + g.sway) * 12;
        const twinkle = 0.45 + 0.55 * Math.abs(Math.sin(age * 6 + g.sway));
        context.fillStyle = g.gold
          ? `rgba(255,214,120,${twinkle * glitterFade})`
          : `rgba(255,255,255,${twinkle * glitterFade})`;
        context.beginPath();
        context.arc(x, y, g.size, 0, Math.PI * 2);
        context.fill();
      }

      // Camera flashes popping around her.
      for (const f of flashes) {
        const age = t - f.at * seconds;
        if (age >= 0 && age < 0.18) {
          starBurst(f.x, f.y, f.size, 1 - age / 0.18);
        }
      }
      // The big flashes on Tina, and the final burst.
      for (const at of [...BIG_FLASHES, FINAL_FLASH]) {
        const final = at === FINAL_FLASH;
        const length = final ? 0.7 : 0.28;
        const age = t - at * seconds;
        if (age >= 0 && age < length) {
          const k = 1 - age / length;
          starBurst(
            cx,
            cy - tina * 0.1,
            tina * (final ? 0.9 : 0.55),
            (final ? 0.75 : 0.5) * k,
            false
          );
          context.fillStyle = `rgba(255,255,255,${(final ? 0.22 : 0.08) * k})`;
          context.fillRect(0, 0, width, height);
        }
      }

      // Confetti bursting out as she's fully lit.
      const burst = clamp((p - FINAL_FLASH) / (1 - FINAL_FLASH));
      if (burst > 0 && burst < 1) {
        const out = easeInOut(burst);
        for (const c of confetti) {
          const x = cx + Math.cos(c.angle) * c.speed * out;
          const y = cy + Math.sin(c.angle) * c.speed * out + burst * burst * tina * 0.3;
          context.fillStyle = `hsla(${c.hue}, 95%, 65%, ${1 - burst})`;
          context.fillRect(x, y, c.size, c.size * 1.6);
        }
      }

      // Her name in gold under her once she's lit.
      if (p > FINAL_FLASH) {
        const shown = clamp((p - FINAL_FLASH) / 0.04);
        context.globalCompositeOperation = 'source-over';
        context.font = `bold ${Math.round(height * 0.055)}px system-ui, sans-serif`;
        context.textAlign = 'center';
        (context as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0.5em';
        context.shadowColor = 'rgba(251,191,36,0.9)';
        context.shadowBlur = 24;
        context.fillStyle = `rgba(254,243,199,${shown})`;
        context.fillText('TINA', cx, height * 0.97);
        context.shadowBlur = 0;
      }

      if (p < 1) {
        frame = requestAnimationFrame(draw);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [seconds]);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </div>
  );
}
