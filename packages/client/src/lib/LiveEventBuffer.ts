/**
 * The in-memory delta buffer the page keeps while (and after) the snapshot
 * request is in flight.
 *
 * Retention is a little longer than the server's replay window (15 min vs
 * 10 min): the buffer must cover the snapshot's staleness *plus* the round trip
 * of the `/events` call itself. Anything older is dead weight — the snapshot
 * already contains it.
 *
 * Dedupe is a `Set` of `eventId|type|tsSent` keys: O(1) per message, and it
 * survives the cases that actually produce duplicates — a replay after
 * reconnect, and the same message arriving both from the leader tab's
 * BroadcastChannel and from this tab's own replay right after promotion.
 */

import { dedupeKey, sortLiveEvents, type LiveEventsMessage } from '@earnings/shared';

export interface LiveEventBufferOptions {
  retentionMs?: number;
  maxSize?: number;
  now?: () => number;
}

export interface BufferStats {
  size: number;
  oldestAt: string | null;
  newestAt: string | null;
  retentionMs: number;
  duplicates: number;
  droppedByAge: number;
  droppedBySize: number;
}

export class LiveEventBuffer {
  private readonly retentionMs: number;
  private readonly maxSize: number;
  private readonly now: () => number;

  private messages: LiveEventsMessage[] = [];
  private readonly keys = new Set<string>();

  private droppedByAge = 0;
  private droppedBySize = 0;
  private duplicates = 0;

  constructor(options: LiveEventBufferOptions = {}) {
    this.retentionMs = options.retentionMs ?? 15 * 60_000;
    this.maxSize = options.maxSize ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  /** `true` if the message is new to this buffer. */
  add(message: LiveEventsMessage): boolean {
    const key = dedupeKey(message);
    if (this.keys.has(key)) {
      this.duplicates += 1;
      return false;
    }
    this.keys.add(key);
    this.messages.push(message);
    this.prune();
    return true;
  }

  addMany(messages: readonly LiveEventsMessage[]): number {
    let added = 0;
    for (const message of messages) if (this.add(message)) added += 1;
    return added;
  }

  has(message: LiveEventsMessage): boolean {
    return this.keys.has(dedupeKey(message));
  }

  /** Everything retained, in channel order — ready to fold onto a snapshot. */
  all(): LiveEventsMessage[] {
    this.prune();
    return sortLiveEvents(this.messages);
  }

  /** Messages published strictly after `at`. */
  since(at: string | number): LiveEventsMessage[] {
    const threshold = typeof at === 'number' ? at : Date.parse(at);
    return this.all().filter((message) => Date.parse(message.tsSent) > threshold);
  }

  clear(): void {
    this.messages = [];
    this.keys.clear();
  }

  get size(): number {
    return this.messages.length;
  }

  /** Highest channel id seen — the resume cursor after a promotion. */
  get lastId(): number | null {
    return this.messages.reduce<number | null>(
      (max, message) => (max === null || message.id > max ? message.id : max),
      null,
    );
  }

  get stats(): BufferStats {
    const sorted = this.all();
    return {
      size: sorted.length,
      oldestAt: sorted[0]?.tsSent ?? null,
      newestAt: sorted[sorted.length - 1]?.tsSent ?? null,
      retentionMs: this.retentionMs,
      duplicates: this.duplicates,
      droppedByAge: this.droppedByAge,
      droppedBySize: this.droppedBySize,
    };
  }

  private prune(): void {
    if (this.messages.length === 0) return;
    const cutoff = this.now() - this.retentionMs;

    const kept: LiveEventsMessage[] = [];
    for (const message of this.messages) {
      if (Date.parse(message.tsSent) >= cutoff) {
        kept.push(message);
      } else {
        this.droppedByAge += 1;
        this.keys.delete(dedupeKey(message));
      }
    }

    if (kept.length > this.maxSize) {
      const overflow = kept.length - this.maxSize;
      for (const message of kept.splice(0, overflow)) this.keys.delete(dedupeKey(message));
      this.droppedBySize += overflow;
    }

    this.messages = kept;
  }
}
