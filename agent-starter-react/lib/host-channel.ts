// The settings page (with the host panel, on the laptop screen) and the stage (its own
// window, on the TV) are two windows of the same browser: they talk over a
// BroadcastChannel. The stage forwards the host's clicks to Tina and tells the panel
// what's happening; the settings page tells the stage when the settings were saved.
import type { Award, CeremonySettings } from '@/lib/ceremony';

export const HOST_CHANNEL = 'tina-host';
export const STAGE_PATH = '/ceremony/stage';

/** What the host can click; the agent's CeremonyHost.run_command does it at once. */
export type HostAction =
  | 'event'
  | 'next_award'
  | 'award'
  | 'pause'
  | 'resume'
  | 'end_awards'
  | 'end_ask_ai'
  | 'stop_music'
  // Played by the stage itself, straight away: a song from the settings, the suspense music.
  | 'song'
  | 'suspense';

export type HostCommand = { kind: 'command'; action: HostAction; name?: string };

/** The events, awards and songs the host panel lists. */
export type HostLists = {
  /** Events the host can call, in programme order. */
  events: { name: string; kind: 'say' | 'ask_ai' }[];
  /** Award categories in presentation order, with their number of winners. */
  awards: { category: string; winners: number }[];
  /** The songs on the Customise tab, by name. */
  songs: string[];
};

/** The stage's state, for the panel. */
export type HostState = HostLists & {
  kind: 'state';
  /** Connected to Tina and her ceremony has started. */
  live: boolean;
  connection: string;
  /** listening / thinking / speaking / ... */
  agentState: string;
  /** The event or award title on screen, if any. */
  now: string | null;
  music: string | null;
  onHold: boolean;
  askAi: boolean;
  eventsDone: string[];
  /** Winners announced per category. */
  awardsDone: Record<string, number>;
};

export type HostMessage =
  | HostCommand
  | HostState
  | { kind: 'hello' }
  // The settings page saved the settings: the stage reloads them and tells Tina.
  | { kind: 'settings' };

/** The panel's lists from the settings and the award list. */
export function hostLists(settings: CeremonySettings, awards: Award[]): HostLists {
  const categories: HostLists['awards'] = [];
  for (const award of awards) {
    const category = award.category.trim();
    const same = categories.find((c) => c.category.toLowerCase() === category.toLowerCase());
    if (same) {
      same.winners += 1;
    } else if (category) {
      categories.push({ category, winners: 1 });
    }
  }
  return {
    events: settings.events
      .filter((e) => (e.trigger ?? 'called') === 'called' && e.name.trim() && e.script.trim())
      .map((e) => ({ name: e.name.trim(), kind: e.kind === 'ask_ai' ? 'ask_ai' : 'say' })),
    awards: categories,
    songs: settings.songs.filter((s) => s.name.trim() && s.url.trim()).map((s) => s.name.trim()),
  };
}

/** Opens (or brings back) the stage in its own window, for the TV. Call it from a click. */
export function openStageWindow() {
  window.open(STAGE_PATH, 'tina-stage', 'popup,width=1280,height=720');
}

/** Tells the stage the settings were saved, so it reloads them and updates Tina. */
export function announceSettingsSaved() {
  const channel = new BroadcastChannel(HOST_CHANNEL);
  channel.postMessage({ kind: 'settings' } satisfies HostMessage);
  channel.close();
}
