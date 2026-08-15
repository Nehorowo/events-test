const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 4000),

  /**
   * How stale `GET /events` is. Models a snapshot served from a cache or a read
   * replica — it is the entire reason the client has to reconcile.
   */
  snapshotLagMs: num(process.env.SNAPSHOT_LAG_MS, 10 * 60_000),

  /** Replay window the channel retains, mirroring `nchan_message_timeout`. */
  replayWindowMs: num(process.env.REPLAY_WINDOW_MS, 10 * 60_000),

  /** Hard cap on buffered messages, mirroring `nchan_message_buffer_length`. */
  replayMaxMessages: num(process.env.REPLAY_MAX_MESSAGES, 5_000),

  /**
   * Length of one full lifecycle (scheduled → … → recording) in the simulator.
   * Short on purpose so the page visibly moves.
   */
  cycleMs: num(process.env.SIM_CYCLE_MS, 4 * 60_000),

  /** History generated at boot, so a fresh server is already warm. */
  historyMs: num(process.env.SIM_HISTORY_MS, 30 * 60_000),

  /** How often new deltas are produced and published. */
  tickMs: num(process.env.SIM_TICK_MS, 1_000),

  /** How long finished events stay in the calendar window. */
  retentionMs: num(process.env.EVENT_RETENTION_MS, 12 * 60_000),

  /** SSE keep-alive comment interval. */
  heartbeatMs: num(process.env.SSE_HEARTBEAT_MS, 15_000),

  /**
   * When set, deltas are also POSTed to a real nginx+nchan publisher endpoint
   * (e.g. http://localhost:8080/pub/live_events). The built-in broker keeps
   * working either way.
   */
  nchanPublishUrl: process.env.NCHAN_PUBLISH_URL ?? null,
} as const;

export const CHANNEL_NAME = 'live_events';
