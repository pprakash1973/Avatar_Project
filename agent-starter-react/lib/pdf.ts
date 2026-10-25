// Client-side PDF helpers (pdf.js). The deck is rendered in the browser, so
// slides never have to be uploaded anywhere.
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type { PDFDocumentProxy };

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
  return pdfjs.getDocument({ data }).promise;
}

/** A page being drawn off screen; cancel() stops it (its promise then rejects). */
export type PageRender = { done: Promise<HTMLCanvasElement>; cancel: () => void };

/**
 * Draws a page, scaled to fit within width x height CSS pixels, into a new canvas
 * that is only handed over once complete. Drawing straight into the canvas on
 * screen let a second render (e.g. after a resize) reset it mid-way, leaving the
 * slide black and upside down.
 */
export function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  width: number,
  height: number
): PageRender {
  let cancelled = false;
  let task: { cancel: () => void } | null = null;
  const done = (async () => {
    const page = await doc.getPage(pageNumber);
    if (cancelled) {
      throw new Error('cancelled');
    }
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(width / base.width, height / base.height);
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: fit * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('no canvas context');
    }
    const render = page.render({ canvas, canvasContext: context, viewport });
    task = render;
    await render.promise;
    return canvas;
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

/** JPEG data URL of a page, at most `maxWidth` pixels wide. */
export async function pageImage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  maxWidth: number,
  quality = 0.7
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: maxWidth / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) {
    return '';
  }
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas.toDataURL('image/jpeg', quality);
}

export async function pageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
