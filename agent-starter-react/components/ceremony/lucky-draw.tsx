'use client';

import { useEffect, useState } from 'react';

// Balls in the jar: position around the jar's middle (100, 155), radius and colour.
const BALL_COLOURS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#a855f7', '#f5f5f4', '#ec4899'];
const BALLS = Array.from({ length: 28 }, (_, i) => {
  // A fixed spiral, so the balls fill the jar evenly and look the same every time.
  const angle = i * 2.4;
  const distance = 12 + ((i * 37) % 58);
  return {
    x: 100 + Math.cos(angle) * distance,
    y: 155 + Math.sin(angle) * distance * 0.95,
    r: 9 + (i % 3) * 1.5,
    colour: BALL_COLOURS[i % BALL_COLOURS.length],
  };
});

// The jar's glass: a neck under the lid, round shoulders, a wide body.
const JAR_PATH =
  'M58 44 L58 62 Q14 72 14 114 L14 206 Q14 232 40 232 L160 232 Q186 232 186 206 L186 114 Q186 72 142 62 L142 44 Z';

/**
 * The lucky draw on the stage: a jar of balls spinning to the suspense music, then the
 * number's digits falling out of it one by one, left to right, into their places.
 */
export function LuckyDraw({
  seconds,
  startedAt,
  digits,
  shown,
  from,
  to,
  round,
  rounds,
}: {
  seconds: number;
  startedAt: number;
  /** How many digits the number has (the empty places). */
  digits: number;
  /** The digits fallen so far, left to right. */
  shown: string[];
  from?: number;
  to?: number;
  /** Which draw this is, of how many planned ("Draw 2 of 5"). */
  round?: number;
  rounds?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const spinning = shown.length === 0 && now - startedAt < seconds * 1000;
  const complete = digits > 0 && shown.length >= digits;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[3vh] pt-[12vh] pb-[4vh]">
      {/* A warm spotlight on the jar. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-[8vh] left-1/2 size-[80vh] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgb(251_191_36/0.18),transparent_65%)]"
      />
      {round && rounds && rounds > 1 && (
        <p className="absolute top-[11vh] right-[4vw] rounded-full border border-amber-300/50 px-4 py-1 text-[2.4vh] font-semibold text-amber-200">
          Draw {round} of {Math.max(round, rounds)}
        </p>
      )}
      <div
        className={`relative h-[42vh] ${spinning ? 'lucky-jar-rock' : complete ? '' : 'lucky-jar-pour'}`}
      >
        <svg viewBox="0 0 200 240" className="h-full" aria-label="Lucky jar">
          <defs>
            <clipPath id="lucky-jar-inside">
              <path d={JAR_PATH} />
            </clipPath>
            <linearGradient id="lucky-jar-glass" x1="0" x2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.28" />
              <stop offset="0.25" stopColor="#ffffff" stopOpacity="0.06" />
              <stop offset="0.8" stopColor="#ffffff" stopOpacity="0.04" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0.22" />
            </linearGradient>
            <linearGradient id="lucky-jar-lid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fde68a" />
              <stop offset="0.5" stopColor="#d4a52a" />
              <stop offset="1" stopColor="#92650c" />
            </linearGradient>
            <radialGradient id="lucky-ball-shine" cx="0.35" cy="0.3" r="0.7">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
              <stop offset="0.35" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <g clipPath="url(#lucky-jar-inside)">
            <g
              className={spinning ? 'lucky-balls-spin' : ''}
              style={{ transformOrigin: '100px 155px', transformBox: 'view-box' }}
            >
              {BALLS.map((ball, i) => (
                <g key={i}>
                  <circle cx={ball.x} cy={ball.y} r={ball.r} fill={ball.colour} />
                  <circle cx={ball.x} cy={ball.y} r={ball.r} fill="url(#lucky-ball-shine)" />
                </g>
              ))}
            </g>
          </g>
          <path
            d={JAR_PATH}
            fill="url(#lucky-jar-glass)"
            stroke="rgb(255 255 255 / 0.65)"
            strokeWidth="2.5"
          />
          <path
            d="M30 120 Q28 170 34 210"
            stroke="rgb(255 255 255 / 0.45)"
            strokeWidth="5"
            strokeLinecap="round"
            fill="none"
          />
          <rect x="50" y="24" width="100" height="24" rx="7" fill="url(#lucky-jar-lid)" />
        </svg>
      </div>

      <div
        className={`flex items-center gap-[2vw] rounded-3xl px-[2vw] py-[2vh] ${
          complete ? 'lucky-win' : ''
        }`}
      >
        {Array.from({ length: digits }, (_, i) => (
          <div
            key={i}
            className="relative flex size-[15vh] items-center justify-center rounded-full border-2 border-dashed border-amber-300/40"
          >
            {shown[i] !== undefined && (
              <span
                className="lucky-ball-fall absolute inset-0 flex items-center justify-center rounded-full bg-[radial-gradient(circle_at_35%_30%,#fff7d6,#f5c542_45%,#b07d10)] text-[10vh] leading-none font-bold text-amber-950 shadow-[0_0_4vh_rgb(251_191_36/0.6)]"
                style={
                  {
                    // From the jar above the middle of the row into this place.
                    '--fall-x': `calc(${(digits - 1) / 2 - i} * (15vh + 2vw))`,
                  } as React.CSSProperties
                }
              >
                {shown[i]}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="h-[4vh] text-[3vh] text-amber-200/90">
        {complete
          ? 'Our lucky number!'
          : spinning && from !== undefined && to !== undefined
            ? `A number from ${from.toLocaleString()} to ${to.toLocaleString()}…`
            : ''}
      </p>
    </div>
  );
}
