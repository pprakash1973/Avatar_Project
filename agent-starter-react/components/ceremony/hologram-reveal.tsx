'use client';

import { useEffect, useRef } from 'react';
import { getSavedSpeakerId } from '@/lib/visitor';

type SinkableAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/** Tina's entrance sound: a rising shimmer that lands on a chime as she appears. */
export const REVEAL_SOUND = '/sounds/tina_reveal.mp3';

const PARTICLES = 260;
// Fractions of the reveal: particles gather into a beam, Tina forms in it, a ring of
// light marks her arrival.
const GATHER_END = 0.45;
const RING_START = 0.8;

type Particle = {
  angle: number;
  radius: number;
  spin: number;
  x: number;
  y: number;
  size: number;
  hue: number;
};

/** Plays the entrance sound on the hall speaker. */
export function playRevealSound(volume: number) {
  const audio: SinkableAudio = new Audio(REVEAL_SOUND);
  audio.volume = Math.min(1, Math.max(0, volume));
  const speakerId = getSavedSpeakerId();
  if (speakerId && audio.setSinkId) {
    void audio.setSinkId(speakerId).catch(() => {});
  }
  void audio.play().catch(() => {});
  return audio;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp = (t: number) => Math.min(1, Math.max(0, t));

/**
 * The light show of Tina's entrance, over the stage: blue-violet particles swirl in and
 * gather into a beam of light at centre stage, where her picture materializes (the
 * `hologram-materialize` class on her video), then a ring of light and her name.
 */
export function HologramReveal({ seconds, volume }: { seconds: number; volume: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // The sound's tail rings on after the reveal: not stopped on unmount.
    playRevealSound(volume);
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
    // Tina's picture is about 72% of the screen height, square.
    const tina = Math.min(height * 0.72, width * 0.9);
    const far = Math.hypot(width, height) / 2;
    const particles: Particle[] = Array.from({ length: PARTICLES }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: far * (0.75 + Math.random() * 0.45),
      spin: (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 2.5),
      // Where it ends up: in the beam, across Tina's height.
      x: (Math.random() - 0.5) * tina * 0.55,
      y: (Math.random() - 0.5) * tina,
      size: 0.8 + Math.random() * 2.2,
      hue: 185 + Math.random() * 90,
    }));
    const started = performance.now();
    let frame = 0;

    const draw = () => {
      const p = clamp((performance.now() - started) / (seconds * 1000));
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'lighter';

      // The beam: a column of light that widens as the particles arrive, then fades.
      const beamIn = clamp((p - 0.25) / 0.3);
      const beamOut = 1 - clamp((p - 0.7) / 0.3);
      const beamAlpha = beamIn * beamOut;
      if (beamAlpha > 0) {
        const beamWidth = 6 + tina * 0.9 * easeInOut(beamIn);
        const beam = context.createLinearGradient(cx - beamWidth / 2, 0, cx + beamWidth / 2, 0);
        beam.addColorStop(0, 'rgba(103,232,249,0)');
        beam.addColorStop(0.5, `rgba(196,181,253,${0.35 * beamAlpha})`);
        beam.addColorStop(1, 'rgba(103,232,249,0)');
        context.fillStyle = beam;
        context.fillRect(cx - beamWidth / 2, 0, beamWidth, height);
      }

      // The orb at centre stage, growing as the particles gather.
      const orbAlpha = clamp(p / 0.2) * (1 - clamp((p - 0.5) / 0.2));
      if (orbAlpha > 0) {
        const orbRadius = 20 + 80 * easeInOut(clamp(p / GATHER_END));
        const orb = context.createRadialGradient(cx, cy, 0, cx, cy, orbRadius);
        orb.addColorStop(0, `rgba(255,255,255,${0.9 * orbAlpha})`);
        orb.addColorStop(0.35, `rgba(167,139,250,${0.6 * orbAlpha})`);
        orb.addColorStop(1, 'rgba(103,232,249,0)');
        context.fillStyle = orb;
        context.beginPath();
        context.arc(cx, cy, orbRadius, 0, Math.PI * 2);
        context.fill();
      }

      // The particles: swirling in, then drifting up the beam and fading.
      const gather = easeInOut(clamp(p / GATHER_END));
      const fade = 1 - clamp((p - 0.6) / 0.35);
      for (const particle of particles) {
        let x: number;
        let y: number;
        if (p < GATHER_END) {
          const angle = particle.angle + particle.spin * gather;
          const radius = particle.radius * (1 - gather);
          x = cx + particle.x * gather + Math.cos(angle) * radius;
          y = cy + particle.y * gather + Math.sin(angle) * radius;
        } else {
          const rise = (p - GATHER_END) * tina * 0.6;
          x = cx + particle.x + Math.sin((p + particle.angle) * 12) * 3;
          y = cy + particle.y - rise * (0.5 + particle.size / 3);
        }
        const alpha = (0.35 + 0.65 * gather) * fade;
        if (alpha <= 0) {
          continue;
        }
        context.fillStyle = `hsla(${particle.hue}, 95%, 75%, ${alpha})`;
        context.beginPath();
        context.arc(x, y, particle.size * (1 + gather), 0, Math.PI * 2);
        context.fill();
      }

      // The ring of light as she arrives.
      const ring = clamp((p - RING_START) / (1 - RING_START));
      if (ring > 0 && ring < 1) {
        context.strokeStyle = `rgba(165,243,252,${0.7 * (1 - ring)})`;
        context.lineWidth = 3 + 6 * (1 - ring);
        context.beginPath();
        context.arc(cx, cy, tina * (0.45 + 0.6 * ring), 0, Math.PI * 2);
        context.stroke();
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
      <p
        className="reveal-name absolute inset-x-0 bottom-[2vh] text-center text-[5.5vh] font-bold tracking-[0.5em] text-cyan-100"
        style={{ animationDuration: `${seconds}s` }}
      >
        TINA
      </p>
    </div>
  );
}

/** Before her entrance: a dark stage with a softly pulsing orb of light. */
export function PreRevealOrb() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <div className="orb-pulse size-[7vh] rounded-full bg-[radial-gradient(circle,rgb(255_255_255/0.9),rgb(167_139_250/0.55)_40%,transparent_70%)]" />
    </div>
  );
}
