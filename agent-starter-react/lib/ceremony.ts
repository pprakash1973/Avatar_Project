// Award ceremony mode: shared types, defaults and on-device storage.
// The award list and the slides stay on the host laptop; the list is sent to
// Tina only when the ceremony starts.

export const CEREMONY_AWARDS_TOPIC = 'ceremony-awards';

export type Award = {
  category: string;
  winner: string;
  /** Exactly what Tina says, word-for-word. */
  script: string;
  /** 1-based slide number shown while announcing. */
  slide: number;
};

export type ExtractedAward = {
  category: string;
  winner: string;
  citation: string;
  slide: number;
};

// Slide text keeps its line breaks; collapse them so the script reads as one passage.
export const defaultScript = (a: ExtractedAward) =>
  [`The award for ${a.category} goes to ${a.winner}.`, a.citation]
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');

const AWARDS_KEY = 'avatar.ceremony.awards';
const DB_NAME = 'avatar-ceremony';
const STORE = 'files';
const PDF_KEY = 'deck';

export function loadAwards(): Award[] {
  try {
    const raw = window.localStorage.getItem(AWARDS_KEY);
    return raw ? (JSON.parse(raw) as Award[]) : [];
  } catch {
    return [];
  }
}

export function saveAwards(awards: Award[]) {
  try {
    window.localStorage.setItem(AWARDS_KEY, JSON.stringify(awards));
  } catch {
    // Not persisted; still usable for this session.
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Keeps the deck in the browser so a page reload doesn't lose it. */
export async function saveDeck(file: Blob): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(file, PDF_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Storage unavailable: the deck must be re-uploaded after a reload.
  }
}

export async function loadDeck(): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(PDF_KEY);
      request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}
