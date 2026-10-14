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

/** Renders a page into the canvas, scaled to fit within width x height CSS pixels. */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  width: number,
  height: number
) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const fit = Math.min(width / base.width, height / base.height);
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: fit * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
  canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  await page.render({ canvas, canvasContext: context, viewport }).promise;
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
