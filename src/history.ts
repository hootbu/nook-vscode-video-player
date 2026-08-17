// Only the Memento shape is needed, and importing it as a type keeps this module loadable — and
// so testable — outside an extension host.
import type * as vscode from 'vscode';

const KEY = 'player.history';
/** Kept small on purpose: the whole list is read into memory at startup. */
const LIMIT = 50;
/** A position this close to either end is not worth returning to. */
const EDGE_SECONDS = 15;
/** Positions arrive every second; writing to disk that often would be pointless. */
const FLUSH_MS = 5000;

export interface Watched {
  id: string;
  title: string;
  channel: string;
  /** Seconds into the video when it was last left. */
  position: number;
  /** Seconds. */
  duration: number;
  /** Epoch milliseconds of the last watch. */
  at: number;
}

/**
 * What has been watched and how far. Roughly 130 bytes an entry, so the whole list is a handful
 * of kilobytes — small enough to hold in memory and hand to the webview whole. Thumbnails are
 * derived from the id rather than stored, and nothing else about a video is kept.
 */
export class History {
  private entries: Watched[];
  private timer?: NodeJS.Timeout;

  constructor(private readonly memento: vscode.Memento) {
    this.entries = memento.get<Watched[]>(KEY, []);
  }

  list(): readonly Watched[] {
    return this.entries;
  }

  /** Where playback should pick up, or 0 for a video that was finished or barely started. */
  resumeAt(id: string): number {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry || entry.position < EDGE_SECONDS) {
      return 0;
    }
    return entry.duration && entry.position > entry.duration - EDGE_SECONDS ? 0 : entry.position;
  }

  /** Moves a video to the front of the list, keeping the position already recorded for it. */
  record(video: { id: string; title: string; channel: string; duration: number }) {
    const previous = this.entries.find((item) => item.id === video.id);
    this.entries = [
      { ...video, position: previous?.position ?? 0, at: Date.now() },
      ...this.entries.filter((item) => item.id !== video.id)
    ].slice(0, LIMIT);
    this.flush();
  }

  position(id: string, seconds: number) {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    entry.position = seconds;
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  clear() {
    this.entries = [];
    this.flush();
  }

  dispose() {
    this.flush();
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    void this.memento.update(KEY, this.entries);
  }
}
