'use client';

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// The remote's size; the host can resize and move it.
const WIDTH = 380;
const HEIGHT = 660;

type DocumentPictureInPicture = {
  requestWindow: (options: { width: number; height: number }) => Promise<Window>;
  window: Window | null;
};

const pictureInPicture = () =>
  (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture;

/** The page's styles (Tailwind, fonts, theme) in the remote's document. */
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement('style');
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
      target.head.appendChild(style);
    } catch {
      // A sheet from another origin: link it instead.
      if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
  target.documentElement.className = document.documentElement.className;
  target.body.className = 'bg-background text-foreground antialiased';
}

/**
 * A small floating window for the host's remote: always on top of other windows (Chrome
 * and Edge's Document Picture-in-Picture), so the host can place it beside Tina's stage
 * window; elsewhere a small ordinary window. It shows what's rendered into it.
 */
export function useFloatingRemote() {
  const [win, setWin] = useState<Window | null>(null);

  const open = useCallback(async () => {
    const api = pictureInPicture();
    let remote: Window | null = null;
    if (api?.window) {
      api.window.focus();
      return;
    }
    if (api) {
      try {
        remote = await api.requestWindow({ width: WIDTH, height: HEIGHT });
      } catch (error) {
        console.warn('no always-on-top window; using a small window instead', error);
      }
    }
    if (!remote) {
      remote = window.open('', 'tina-remote', `popup,width=${WIDTH},height=${HEIGHT}`);
      if (!remote) {
        return;
      }
      remote.document.body.replaceChildren();
    }
    remote.document.title = 'Tina remote';
    copyStyles(remote.document);
    remote.addEventListener('pagehide', () => setWin(null), { once: true });
    setWin(remote);
  }, []);

  // The remote belongs to this page: it closes with it.
  useEffect(() => () => win?.close(), [win]);

  return { win, open };
}

/** Renders `children` into the floating remote, if it's open. */
export function FloatingRemote({ win, children }: { win: Window | null; children: ReactNode }) {
  return win ? createPortal(children, win.document.body) : null;
}
