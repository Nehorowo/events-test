/**
 * Owns the server-side truth: drives the simulator, publishes every delta to
 * the `/live_events` channel, and rebuilds the intentionally-stale `/events`
 * snapshot.
 *
 * The snapshot is not a cached response — it is the live state *rewound* to
 * `now - SNAPSHOT_LAG_MS`, reconstructed with the same `foldLiveEvents` the
 * browser uses. A materialised cursor walks forward as time passes, so only the
 * deltas newer than the cursor are ever retained in memory.
 */

import {
  foldLiveEvents,
  sortEarningsForDisplay,
  type Earning,
  type EventsSnapshot,
  type LiveEvent,
} from '@earnings/shared';
import type { ChannelBroker } from '../broker/channelBroker.js';
import { ALL_SYMBOLS } from './catalog.js';
import { EarningsSimulator } from './simulator.js';

export interface EventsServiceOptions {
  broker: ChannelBroker;
  snapshotLagMs: number;
  cycleMs: number;
  historyMs: number;
  tickMs: number;
  /** Terminal events older than this drop out of the calendar window. */
  retentionMs: number;
  now?: () => number;
  onPublish?: (event: LiveEvent) => void;
}

export class EventsService {
  private readonly options: EventsServiceOptions;
  private readonly simulator: EarningsSimulator;
  private readonly now: () => number;

  /** Deltas newer than `materialisedAtMs`, kept so the cursor can catch up. */
  private pending: LiveEvent[] = [];
  private materialised: Map<string, Earning>;
  private materialisedAtMs: number;

  private lastTickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private publishedCount = 0;

  constructor(options: EventsServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;

    const bootMs = this.now();
    const genesisMs = bootMs - options.historyMs;

    this.simulator = new EarningsSimulator({ genesisMs, cycleMs: options.cycleMs });
    this.materialised = new Map(this.simulator.baseEvents().map((e) => [e.id, e]));
    this.materialisedAtMs = genesisMs;
    this.lastTickMs = genesisMs;
  }

  get symbols(): string[] {
    return this.simulator.symbols;
  }

  get stats() {
    return {
      publishedCount: this.publishedCount,
      pendingCount: this.pending.length,
      trackedEvents: this.materialised.size,
      genesis: new Date(this.simulator.genesis).toISOString(),
      materialisedAt: new Date(this.materialisedAtMs).toISOString(),
    };
  }

  /** Backfills history so the channel and the snapshot are immediately useful. */
  start(): void {
    this.drainSimulator(this.now());
    this.timer = setInterval(() => this.drainSimulator(this.now()), this.options.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What an HTTP caller sees: the calendar as of `now - snapshotLagMs`. */
  getSnapshot(symbols: readonly string[] = ALL_SYMBOLS): EventsSnapshot {
    const nowMs = this.now();
    const cutoffMs = Math.max(this.simulator.genesis, nowMs - this.options.snapshotLagMs);
    this.advanceTo(cutoffMs);

    const wanted = new Set(symbols);
    const events = sortEarningsForDisplay(
      [...this.materialised.values()].filter((e) => wanted.has(e.symbol)),
    );

    return {
      snapshotAt: new Date(cutoffMs).toISOString(),
      ageMs: nowMs - cutoffMs,
      serverTime: new Date(nowMs).toISOString(),
      symbols: [...wanted],
      events,
    };
  }

  /** Current server-side truth. Used to verify the client's merged state. */
  getLiveState(symbols: readonly string[] = ALL_SYMBOLS): Earning[] {
    const { events } = foldLiveEvents(this.materialised, this.pending);
    const wanted = new Set(symbols);
    return sortEarningsForDisplay([...events.values()].filter((e) => wanted.has(e.symbol)));
  }

  // --- internals ---------------------------------------------------------

  private drainSimulator(nowMs: number): void {
    const drafts = this.simulator.eventsInWindow(this.lastTickMs, nowMs);
    this.lastTickMs = nowMs;

    for (const draft of drafts) {
      const event = this.options.broker.publish(draft);
      this.pending.push(event);
      this.publishedCount += 1;
      this.options.onPublish?.(event);
    }
  }

  /** Moves the materialised cursor forward, consuming the deltas it passes. */
  private advanceTo(cutoffMs: number): void {
    if (cutoffMs <= this.materialisedAtMs) return;

    const consumed: LiveEvent[] = [];
    const rest: LiveEvent[] = [];
    for (const event of this.pending) {
      (Date.parse(event.tsSent) <= cutoffMs ? consumed : rest).push(event);
    }

    if (consumed.length > 0) {
      this.materialised = foldLiveEvents(this.materialised, consumed).events;
      this.pending = rest;
    }
    this.materialisedAtMs = cutoffMs;
    this.evictTerminal(cutoffMs);
  }

  /**
   * A calendar page shows a window, not all history. Terminal events
   * (`completed` / failed) drop out once they are old enough — they receive no
   * further deltas, so dropping them cannot orphan anything.
   */
  private evictTerminal(cutoffMs: number): void {
    const horizon = cutoffMs - this.options.retentionMs;
    for (const [id, event] of this.materialised) {
      const terminal = event.state === 'completed' || event.failureReason !== null;
      if (terminal && Date.parse(event.updatedAt) < horizon) {
        this.materialised.delete(id);
      }
    }
  }
}
