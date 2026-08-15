/**
 * Pure reconciliation logic, shared by the server (which rebuilds the snapshot
 * "as of" a past instant) and the browser (which folds buffered deltas onto a
 * snapshot that arrived late). One implementation for both sides means the
 * client can never disagree with the server about what a delta means.
 *
 * Two rules decide everything:
 *
 *   1. **Dedupe** on `eventId|type|tsSent` — O(1) `Set` lookup on the client.
 *   2. **Staleness** on `tsSent` vs the entity's `updatedAt`: a delta older
 *      than the entity it targets is already reflected in it. This is what
 *      makes folding a 10-minute replay buffer onto a 10-minute-old snapshot
 *      idempotent, no matter how much the two overlap.
 */

import type {
  Earning,
  EarningState,
  EventsSnapshot,
  LiveEvent,
  LiveEventType,
} from './types.js';

/** Why a delta did or did not change the state. Surfaced in the client's log. */
export type ApplyOutcome =
  | 'applied'
  /** Created the entity from an `event_scheduled` payload. */
  | 'created'
  /** The snapshot (or an earlier delta) is already at or past this `tsSent`. */
  | 'stale'
  /** A partial delta for an event we have no base for — keep it buffered. */
  | 'orphan'
  /** Same `eventId|type|tsSent` seen before. */
  | 'duplicate'
  /** The event is not on this client's watchlist. */
  | 'filtered';

export interface ApplyResult {
  outcome: ApplyOutcome;
  earning: Earning | null;
}

/**
 * Applies one delta to one entity. `current` is `undefined` when the client has
 * never seen the event — only `event_scheduled` can materialise it from
 * nothing, everything else is reported as `orphan` and stays in the buffer for
 * the next snapshot.
 */
export function applyLiveEvent(current: Earning | undefined, event: LiveEvent): ApplyResult {
  if (!current) {
    if (event.type === 'event_scheduled') {
      return {
        outcome: 'created',
        earning: { ...event.event, updatedAt: event.tsSent },
      };
    }
    return { outcome: 'orphan', earning: null };
  }

  // Per-entity last-write-wins on the publication timestamp.
  if (Date.parse(event.tsSent) <= Date.parse(current.updatedAt)) {
    return { outcome: 'stale', earning: current };
  }

  const next = transition(current, event);
  return { outcome: 'applied', earning: { ...next, updatedAt: event.tsSent } };
}

function transition(current: Earning, event: LiveEvent): Earning {
  switch (event.type) {
    case 'event_scheduled':
      // Re-announcement of an event we already track: take the newer payload.
      return { ...event.event };

    case 'event_updated':
      return { ...current, ...event.changes };

    case 'live_started':
      return {
        ...current,
        state: 'live',
        liveAudio: { ...event.liveAudio, startedAt: event.startedAt, isReplay: false },
      };

    case 'live_ended':
      return {
        ...current,
        state: 'ended',
        liveAudio: current.liveAudio
          ? { ...current.liveAudio, durationSec: event.durationSec }
          : null,
      };

    case 'recording_available':
      return {
        ...current,
        state: 'completed',
        liveAudio: {
          url: event.recording.url,
          title: event.recording.title,
          startedAt: current.liveAudio?.startedAt ?? null,
          durationSec: event.recording.durationSec,
          isReplay: true,
        },
      };

    case 'live_failed':
      return {
        ...current,
        state: 'ended',
        liveAudio: null,
        failureReason: event.reason,
      };
  }
}

/** Total order for the channel: nchan's monotonic message counter. */
export function compareLiveEvents(a: LiveEvent, b: LiveEvent): number {
  if (a.id !== b.id) return a.id - b.id;
  return Date.parse(a.tsSent) - Date.parse(b.tsSent);
}

export function sortLiveEvents(events: readonly LiveEvent[]): LiveEvent[] {
  return [...events].sort(compareLiveEvents);
}

export interface FoldOptions {
  /** Watchlist. Deltas for anything else are reported as `filtered`. */
  symbols?: ReadonlySet<string> | readonly string[];
  onOutcome?: (event: LiveEvent, outcome: ApplyOutcome) => void;
}

export type OutcomeCounts = Record<ApplyOutcome, number>;

export interface FoldResult {
  events: Map<string, Earning>;
  counts: OutcomeCounts;
  /** Deltas that found no base entity — worth retrying after a fresh snapshot. */
  orphans: LiveEvent[];
}

export const emptyCounts = (): OutcomeCounts => ({
  applied: 0,
  created: 0,
  stale: 0,
  orphan: 0,
  duplicate: 0,
  filtered: 0,
});

/**
 * Folds deltas onto a base map. The base is not mutated.
 *
 * Deltas may arrive out of order, duplicated, or already reflected in the base;
 * the `tsSent` guard makes the fold idempotent for anything the base knows.
 */
export function foldLiveEvents(
  base: ReadonlyMap<string, Earning> | readonly Earning[],
  events: readonly LiveEvent[],
  options: FoldOptions = {},
): FoldResult {
  const result = new Map<string, Earning>(
    Array.isArray(base)
      ? (base as readonly Earning[]).map((e) => [e.id, e])
      : (base as ReadonlyMap<string, Earning>),
  );
  const watchlist =
    options.symbols instanceof Set
      ? options.symbols
      : options.symbols
        ? new Set(options.symbols as readonly string[])
        : null;

  const counts = emptyCounts();
  const orphans: LiveEvent[] = [];

  for (const event of sortLiveEvents(events)) {
    if (watchlist && !watchlist.has(event.symbol)) {
      counts.filtered += 1;
      options.onOutcome?.(event, 'filtered');
      continue;
    }

    const { outcome, earning } = applyLiveEvent(result.get(event.eventId), event);
    counts[outcome] += 1;
    if (outcome === 'applied' || outcome === 'created') {
      result.set(event.eventId, earning!);
    } else if (outcome === 'orphan') {
      orphans.push(event);
    }
    options.onOutcome?.(event, outcome);
  }

  return { events: result, counts, orphans };
}

/**
 * The client-side entry point: the snapshot plus everything buffered from SSE
 * since the page subscribed. Buffered deltas older than the snapshot are
 * dropped by the `tsSent` guard, so the two are free to overlap — and they
 * must, otherwise there is a hole (see `assessCoverage`).
 */
export function mergeSnapshotWithBuffer(
  snapshot: EventsSnapshot,
  buffered: readonly LiveEvent[],
  options: FoldOptions = {},
): FoldResult {
  return foldLiveEvents(snapshot.events, buffered, options);
}

export interface Coverage {
  /** The buffer reaches back to (or past) the snapshot instant. */
  covered: boolean;
  /** Length of the uncovered window, in ms. `0` when covered. */
  holeMs: number;
  snapshotAt: string;
  oldestBufferedAt: string | null;
}

/**
 * Decides whether the buffer actually bridges the snapshot's staleness.
 *
 * The client subscribes before it fetches, so normally the buffer starts
 * *before* `snapshotAt` and the two overlap. If the oldest buffered delta is
 * newer than the snapshot — a late subscription, an outage longer than the
 * replay window, an empty channel — the window in between is unaccounted for
 * and the page must refetch instead of rendering a state it cannot vouch for.
 */
export function assessCoverage(
  snapshot: Pick<EventsSnapshot, 'snapshotAt'>,
  buffered: readonly LiveEvent[],
): Coverage {
  const snapshotAt = Date.parse(snapshot.snapshotAt);
  const oldest = buffered.reduce<number | null>((min, event) => {
    const ts = Date.parse(event.tsSent);
    return min === null || ts < min ? ts : min;
  }, null);

  if (oldest === null) {
    // Nothing buffered: either the channel is idle (fine) or we subscribed too
    // late to tell. Treat as covered only if the snapshot is fresh.
    return { covered: true, holeMs: 0, snapshotAt: snapshot.snapshotAt, oldestBufferedAt: null };
  }

  const holeMs = Math.max(0, oldest - snapshotAt);
  return {
    covered: holeMs === 0,
    holeMs,
    snapshotAt: snapshot.snapshotAt,
    oldestBufferedAt: new Date(oldest).toISOString(),
  };
}

/** End-to-end latency of one delta, measured against the local clock. */
export function latencyMs(event: Pick<LiveEvent, 'tsSent'>, now: number = Date.now()): number {
  return now - Date.parse(event.tsSent);
}

const STATE_WEIGHT: Record<EarningState, number> = {
  live: 0,
  starting_soon: 1,
  scheduled: 2,
  ended: 3,
  completed: 4,
};

/** Stable display order: live calls first, then by scheduled date. */
export function sortEarningsForDisplay(earnings: Iterable<Earning>): Earning[] {
  return [...earnings].sort((a, b) => {
    const byState = STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state];
    if (byState !== 0) return byState;
    const byDate = Date.parse(a.date) - Date.parse(b.date);
    if (byDate !== 0) return byDate;
    return a.symbol.localeCompare(b.symbol);
  });
}

/** Human-readable label for a message type, used by the UI log. */
export const LIVE_EVENT_LABELS: Record<LiveEventType, string> = {
  event_scheduled: 'scheduled',
  event_updated: 'updated',
  live_started: 'live started',
  live_ended: 'live ended',
  recording_available: 'recording ready',
  live_failed: 'failed',
};
