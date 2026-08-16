/**
 * The three interfaces the browser side is built around. They live in the
 * shared package so the wire contract and the consumer contract cannot drift
 * apart, and so a non-React consumer (a widget, a test harness, another app)
 * can implement or stub them without pulling in the UI.
 */

import type {
  EarningsEventsSnapshot,
  LiveEventsMessage,
  SnapshotQuery,
  StreamGap,
} from './types.js';

/** Why the underlying stream came back, and what the consumer must do about it. */
export interface ReconnectInfo {
  /** 1-based reconnect attempt that succeeded. */
  attempt: number;
  at: string;
  /** How long the channel was down, in ms. */
  downtimeMs: number;
  /** Cursor the resume was requested from (the SSE `id:` last seen). */
  lastEventId: string | null;
  /** Messages the channel replayed on resume. */
  replayed: number;
  /**
   * Set when the broker could not replay from `lastEventId`: the local buffer
   * is no longer contiguous with the channel and a fresh snapshot is required.
   */
  gap: StreamGap | null;
  /** Whether this tab holds the single cross-tab subscription. */
  role: 'leader' | 'follower';
}

/** Per-message delivery metadata, passed alongside the payload. */
export interface MessageMeta {
  /**
   * `true` when the message came out of the channel's replay buffer rather
   * than over the wire in real time. Latency measurements must exclude these:
   * a replayed message is as old as the replay window, which says nothing
   * about the delivery path.
   */
  replayed: boolean;
}

/**
 * The one SSE subscription of the app.
 *
 * Implementations are singletons: many components (and many browser tabs) share
 * a single `/live_events` connection. `subscribe`/`unsubscribe` take the same
 * callback identity — keep a reference to it.
 */
export interface ILiveEventsClient {
  subscribe(cb: (message: LiveEventsMessage, meta?: MessageMeta) => void): void;
  unsubscribe(cb: (message: LiveEventsMessage, meta?: MessageMeta) => void): void;
  /** Returns an unsubscribe function, unlike `subscribe`. */
  onReconnect(cb: (info: ReconnectInfo) => void): () => void;
  readonly connected: boolean;
}

/** Thin HTTP client — one call, no caching, no state. */
export interface ILiveEventsHttpApi {
  fetchSnapshot(query?: SnapshotQuery): Promise<EarningsEventsSnapshot>;
}

/**
 * Holds the in-memory delta buffer and knows how to bring a snapshot up to
 * date with it.
 */
export interface IEarningsEventsProvider {
  /** The current, already-actualized snapshot; `null` before the first fetch. */
  readonly snapshot: EarningsEventsSnapshot | null;
  /** Folds the buffered deltas onto `snapshot` and adopts the result. */
  actualizeSnapshot(snapshot: EarningsEventsSnapshot): EarningsEventsSnapshot;
}
