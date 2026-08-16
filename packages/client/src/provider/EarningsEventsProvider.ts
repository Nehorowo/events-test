/**
 * `IEarningsEventsProvider` — the piece that makes a 10-minute-old snapshot and
 * a live delta stream agree.
 *
 * The order of operations is the whole point:
 *
 *   1. the provider subscribes to the live channel and starts buffering
 *      *before* anyone asks for a snapshot;
 *   2. `actualizeSnapshot(snapshot)` folds that buffer onto the snapshot the
 *      moment it arrives — deltas older than the snapshot fall out on the
 *      `tsSent` guard, newer ones are applied;
 *   3. from then on every message is applied straight to the held snapshot.
 *
 * If the page fetched first and subscribed after, every delta produced in
 * between would be lost and nothing downstream could tell. Because it
 * subscribes first, the buffer always overlaps the snapshot — and when it does
 * not (`assessCoverage`), that is detectable and the provider asks for a
 * refetch instead of rendering a state it cannot vouch for.
 */

import {
  applyLiveEvent,
  assessCoverage,
  emptyCounts,
  foldLiveEvents,
  latencyMs,
  sortEarningsForDisplay,
  type ApplyOutcome,
  type Coverage,
  type Earning,
  type EarningsEventsSnapshot,
  type IEarningsEventsProvider,
  type ILiveEventsClient,
  type LiveEventsMessage,
  type MessageMeta,
  type OutcomeCounts,
  type ReconnectInfo,
} from '@earnings/shared';
import { LiveEventBuffer, type BufferStats } from '../lib/LiveEventBuffer.js';

export interface ProviderOptions {
  client: ILiveEventsClient;
  /** Watchlist. Messages for other symbols are dropped on arrival (O(1)). */
  symbols: readonly string[];
  bufferRetentionMs?: number;
  /** Terminal events older than this leave the rendered calendar window. */
  eventRetentionMs?: number;
  now?: () => number;
}

export interface LogEntry {
  id: number;
  at: string;
  kind: 'stream' | 'snapshot' | 'merge' | 'delta' | 'error';
  message: string;
  outcome?: ApplyOutcome;
  symbol?: string;
}

export interface ProviderState {
  phase: 'buffering' | 'ready';
  snapshot: EarningsEventsSnapshot | null;
  /** Display-ordered view of the actualized snapshot. */
  events: Earning[];
  counters: OutcomeCounts & { received: number; bufferedBeforeSnapshot: number };
  buffer: BufferStats;
  coverage: Coverage | null;
  latency: {
    /** Latency of the last *live* message; replayed ones are excluded. */
    lastMs: number | null;
    p50Ms: number | null;
    maxMs: number | null;
    samples: number;
    /** Messages that arrived older than the freshness threshold (replay). */
    replayedCount: number;
  };
  connection: { connected: boolean; reconnects: number; last: ReconnectInfo | null };
  log: LogEntry[];
}

const LOG_LIMIT = 120;
const NOTABLE_LOG_LIMIT = 20;
const LATENCY_WINDOW = 100;

/**
 * Fallback for clients that deliver no `MessageMeta`: a message this old cannot
 * have travelled to us in real time, so it must have come from the buffer.
 */
const REPLAY_THRESHOLD_MS = 30_000;

export class EarningsEventsProvider implements IEarningsEventsProvider {
  private readonly client: ILiveEventsClient;
  private readonly watchlist: Set<string>;
  private readonly buffer: LiveEventBuffer;
  private readonly eventRetentionMs: number;
  private readonly now: () => number;

  private readonly stateListeners = new Set<() => void>();
  private readonly refetchListeners = new Set<(reason: string) => void>();

  private latencies: number[] = [];
  private logSeq = 0;
  private state: ProviderState;
  private offReconnect: (() => void) | null = null;
  private readonly onMessage = (message: LiveEventsMessage, meta?: MessageMeta): void =>
    this.ingest(message, meta);

  constructor(options: ProviderOptions) {
    this.client = options.client;
    this.watchlist = new Set(options.symbols);
    this.now = options.now ?? Date.now;
    this.eventRetentionMs = options.eventRetentionMs ?? 12 * 60_000;
    this.buffer = new LiveEventBuffer({
      retentionMs: options.bufferRetentionMs ?? 15 * 60_000,
      now: this.now,
    });

    this.state = {
      phase: 'buffering',
      snapshot: null,
      events: [],
      counters: { ...emptyCounts(), received: 0, bufferedBeforeSnapshot: 0 },
      buffer: this.buffer.stats,
      coverage: null,
      latency: { lastMs: null, p50Ms: null, maxMs: null, samples: 0, replayedCount: 0 },
      connection: { connected: false, reconnects: 0, last: null },
      log: [],
    };
  }

  // --- IEarningsEventsProvider -------------------------------------------

  get snapshot(): EarningsEventsSnapshot | null {
    return this.state.snapshot;
  }

  /**
   * Folds the buffer onto `snapshot` and adopts the result.
   *
   * Safe to call repeatedly: the `tsSent` guard drops everything the snapshot
   * already reflects. On a *re*fetch the held state is kept where it is ahead
   * of the merge result — the snapshot is ten minutes behind by construction,
   * and after a replay gap the buffer may no longer bridge the distance.
   */
  actualizeSnapshot(snapshot: EarningsEventsSnapshot): EarningsEventsSnapshot {
    const buffered = this.buffer.all();
    const merged = foldLiveEvents(snapshot.events, buffered, { symbols: this.watchlist });
    const coverage = assessCoverage(snapshot, buffered);

    const previous = this.state.snapshot;
    const events = previous
      ? keepFreshest(previous.events, merged.events)
      : [...merged.events.values()];

    const actualized: EarningsEventsSnapshot = {
      ...snapshot,
      events: this.prune(sortEarningsForDisplay(events)),
      actualizedAt: new Date(this.now()).toISOString(),
      actualizedFrom: buffered.length,
    };

    const counters = { ...this.state.counters };
    for (const key of Object.keys(merged.counts) as (keyof OutcomeCounts)[]) {
      counters[key] += merged.counts[key];
    }

    this.setState({
      phase: 'ready',
      snapshot: actualized,
      events: actualized.events,
      counters,
      coverage,
      buffer: this.buffer.stats,
      log: this.log('merge', this.describeMerge(snapshot, buffered.length, merged.counts, coverage)),
    });

    if (!coverage.covered) {
      // The buffer starts *after* the snapshot: the window in between is
      // unaccounted for, so this state cannot be trusted as complete.
      this.requestRefetch(`coverage hole of ${Math.round(coverage.holeMs / 1000)}s`);
    }

    return actualized;
  }

  // --- lifecycle ---------------------------------------------------------

  start(): void {
    this.client.subscribe(this.onMessage);
    this.offReconnect = this.client.onReconnect((info) => this.onReconnect(info));
    this.syncConnection();
  }

  stop(): void {
    this.client.unsubscribe(this.onMessage);
    this.offReconnect?.();
    this.offReconnect = null;
    this.stateListeners.clear();
    this.refetchListeners.clear();
  }

  /** React binding (`useSyncExternalStore`). */
  onChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Fires when the provider cannot vouch for its state and needs a fresh
   * snapshot: a replay gap, or a buffer that does not reach back far enough.
   */
  onRefetchNeeded(listener: (reason: string) => void): () => void {
    this.refetchListeners.add(listener);
    return () => {
      this.refetchListeners.delete(listener);
    };
  }

  getState = (): ProviderState => this.state;

  /** Keeps `connected` in the rendered state in sync with the client. */
  syncConnection(): void {
    if (this.state.connection.connected === this.client.connected) return;
    this.setState({
      connection: { ...this.state.connection, connected: this.client.connected },
    });
  }

  // --- internals ---------------------------------------------------------

  private ingest(message: LiveEventsMessage, meta?: MessageMeta): void {
    // Client-side filtering: the channel is unfiltered, every payload carries
    // `symbol`/`companyId`, and this tab decides what concerns it. O(1).
    if (!this.watchlist.has(message.symbol)) {
      this.bump('filtered');
      return;
    }
    if (!this.buffer.add(message)) {
      this.bump('duplicate');
      return;
    }

    // End-to-end latency, measured from the server's `tsSent`. Replayed
    // messages say nothing about the delivery path — they are as old as the
    // replay window — so they are counted separately. The client tells us which
    // is which; the age check is only a fallback for a client that does not.
    const latency = latencyMs(message, this.now());
    const replayed = meta ? meta.replayed : latency > REPLAY_THRESHOLD_MS;
    if (!replayed) {
      this.latencies.push(latency);
      if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
    }

    const counters = {
      ...this.state.counters,
      received: this.state.counters.received + 1,
    };

    if (this.state.phase !== 'ready' || !this.state.snapshot) {
      // Snapshot still in flight: buffer only. Applying now would be guesswork —
      // we do not yet know what the snapshot already contains.
      counters.bufferedBeforeSnapshot += 1;
      this.setState({
        counters,
        buffer: this.buffer.stats,
        latency: this.latencyStats(latency, replayed),
      });
      return;
    }

    const index = new Map(this.state.snapshot.events.map((event) => [event.id, event]));
    const { outcome, earning } = applyLiveEvent(index.get(message.eventId), message);
    counters[outcome] += 1;

    if (outcome === 'applied' || outcome === 'created') {
      index.set(message.eventId, earning!);
    }

    const events = this.prune(sortEarningsForDisplay(index.values()));
    const snapshot: EarningsEventsSnapshot = {
      ...this.state.snapshot,
      events,
      actualizedAt: new Date(this.now()).toISOString(),
    };

    this.setState({
      snapshot,
      events,
      counters,
      buffer: this.buffer.stats,
      latency: this.latencyStats(latency, replayed),
      log: this.log('delta', describeMessage(message, outcome), { outcome, symbol: message.symbol }),
    });
  }

  private onReconnect(info: ReconnectInfo): void {
    this.setState({
      connection: { connected: this.client.connected, reconnects: info.attempt, last: info },
      log: this.log(
        info.gap ? 'error' : 'stream',
        info.gap
          ? `Reconnected as ${info.role} after ${Math.round(info.downtimeMs / 1000)}s — replay gap (${info.gap.reason})`
          : `Reconnected as ${info.role} after ${Math.round(info.downtimeMs / 1000)}s · ${info.replayed} messages replayed`,
      ),
    });

    // A gap means the channel could not replay from our cursor: the buffer is
    // no longer contiguous, and only a new snapshot can close the hole.
    if (info.gap) this.requestRefetch(`replay gap (${info.gap.reason})`);
  }

  private requestRefetch(reason: string): void {
    for (const listener of this.refetchListeners) listener(reason);
  }

  /** Drops finished events that have aged out of the rendered calendar window. */
  private prune(events: readonly Earning[]): Earning[] {
    const horizon = this.now() - this.eventRetentionMs;
    return events.filter((event) => {
      const terminal = event.state === 'completed' || event.failureReason !== null;
      return !terminal || Date.parse(event.updatedAt) >= horizon;
    });
  }

  private latencyStats(last: number, replayed: boolean): ProviderState['latency'] {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      ...this.state.latency,
      replayedCount: this.state.latency.replayedCount + (replayed ? 1 : 0),
      lastMs: replayed ? this.state.latency.lastMs : last,
      p50Ms: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
      maxMs: sorted.length ? sorted[sorted.length - 1]! : null,
      samples: this.latencies.length,
    };
  }

  /**
   * Counter-only update. Deliberately does not notify subscribers: filtered and
   * duplicate messages change nothing on screen, and a replay burst would
   * otherwise re-render the page once per discarded message.
   */
  private bump(outcome: ApplyOutcome): void {
    this.state = {
      ...this.state,
      counters: { ...this.state.counters, [outcome]: this.state.counters[outcome] + 1 },
    };
  }

  private log(
    kind: LogEntry['kind'],
    message: string,
    extra: Partial<LogEntry> = {},
  ): LogEntry[] {
    this.logSeq += 1;
    const entry: LogEntry = {
      id: this.logSeq,
      at: new Date(this.now()).toISOString(),
      kind,
      message,
      ...extra,
    };
    // Deltas and everything else are capped separately: a replay burst of a few
    // hundred deltas would otherwise push the merge summary — the one line that
    // explains what the page is built from — straight out of the window.
    const merged = [entry, ...this.state.log];
    const deltas = merged.filter((e) => e.kind === 'delta').slice(0, LOG_LIMIT);
    const notable = merged.filter((e) => e.kind !== 'delta').slice(0, NOTABLE_LOG_LIMIT);
    return [...deltas, ...notable].sort((a, b) => b.id - a.id);
  }

  private describeMerge(
    snapshot: EarningsEventsSnapshot,
    buffered: number,
    counts: OutcomeCounts,
    coverage: Coverage,
  ): string {
    const age = Math.round(snapshot.ageMs / 1000);
    const overlap = coverage.covered
      ? 'buffer covers the snapshot'
      : `⚠ ${Math.round(coverage.holeMs / 1000)}s hole between snapshot and buffer`;
    return (
      `Snapshot (${age}s old, ${snapshot.events.length} events) + ${buffered} buffered messages → ` +
      `${counts.applied} applied, ${counts.created} created, ${counts.stale} already in snapshot, ` +
      `${counts.orphan} orphan · ${overlap}`
    );
  }

  private setState(patch: Partial<ProviderState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener();
  }
}

/** Per-event "newest `updatedAt` wins" between the held state and a re-merge. */
function keepFreshest(current: readonly Earning[], merged: ReadonlyMap<string, Earning>): Earning[] {
  const result = new Map(merged);
  for (const event of current) {
    const candidate = merged.get(event.id);
    if (!candidate || Date.parse(candidate.updatedAt) < Date.parse(event.updatedAt)) {
      result.set(event.id, event);
    }
  }
  return [...result.values()];
}

function describeMessage(message: LiveEventsMessage, outcome: ApplyOutcome): string {
  const head = `${message.symbol} · ${message.type}`;
  if (outcome === 'stale') return `${head} — skipped (snapshot already newer)`;
  if (outcome === 'orphan') return `${head} — buffered (event not in snapshot yet)`;
  if (outcome === 'duplicate') return `${head} — duplicate`;

  switch (message.type) {
    case 'event_scheduled':
      return `${head} — ${message.event.fiscalPeriod} ${message.event.fiscalYear}`;
    case 'event_updated':
      return `${head} — ${Object.keys(message.changes).join(', ')}${message.reason ? ` (${message.reason})` : ''}`;
    case 'live_started':
      return `${head} — audio live`;
    case 'live_ended':
      return `${head} — ${Math.round(message.durationSec / 60)} min`;
    case 'recording_available':
      return `${head} — replay ready`;
    case 'live_failed':
      return `${head} — ${message.reason}`;
  }
}
