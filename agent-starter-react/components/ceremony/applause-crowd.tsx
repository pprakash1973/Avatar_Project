'use client';

// After each winner, the operator's ovation photo (if any) rises along the bottom of
// the screen for a few seconds. No sound: it would compete with the hall's PA.

export const APPLAUSE_MS = 5000;

export function ApplauseCrowd({ photoUrl }: { photoUrl: string | null }) {
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
