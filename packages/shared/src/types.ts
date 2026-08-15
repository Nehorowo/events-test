/**
 * Wire contract shared by the HTTP snapshot API, the `/live_events` SSE channel
 * and the React client.
 *
 * Payload rules that every message obeys:
 *
 *  - `eventId`   — present in every type; part of the client dedupe key.
 *  - `companyId` + `symbol` — present in every type, so the client can decide
 *    on its own whether a message is worth showing (the channel is not
 *    filtered server-side: nchan just replays a channel verbatim).
 *  - `tsSent`    — server-side publication timestamp (ISO-8601 UTC) taken at
 *    the moment the message is handed to nchan. The client uses it for two
 *    things: end-to-end latency, and deciding whether a buffered delta is
 *    newer than the snapshot it is being folded onto.
 *  - `type`      — duplicated in the body *and* in the SSE `event:` header,
 *    so a consumer that only parses `data:` (e.g. behind a proxy that drops
 *    SSE semantics) still knows what it received.
 *  - `id`        — the SSE `id:` field: nchan's global monotonic counter.
 *    Total order for the channel and the resume cursor. The client treats it
 *    as an opaque cursor and echoes it back; only the broker interprets it.
 */

export type EarningState = 'scheduled' | 'starting_soon' | 'live' | 'ended' | 'completed';

export const EARNING_STATES: readonly EarningState[] = [
  'scheduled',
  'starting_soon',
  'live',
  'ended',
  'completed',
];

export type FiscalPeriod = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'FY';

export interface LiveAudio {
  /** Live stream URL, or the recording URL once `isReplay` is set. */
  url: string;
  title: string;
  /** ISO timestamp of the moment the audio went live, `null` before that. */
  startedAt: string | null;
  /** Filled in once the call is over. */
  durationSec: number | null;
  /** `true` once the live stream has been replaced by a recording. */
  isReplay: boolean;
}

export interface Earning {
  /** Same value as `LiveEvent.eventId` — one calendar event, one id. */
  id: string;
  companyId: string;
  symbol: string;
  title: string;
  /** Scheduled start of the call, ISO 8601. */
  date: string;
  typeId: number;
  fiscalYear: number;
  fiscalPeriod: FiscalPeriod;
  state: EarningState;
  liveAudio: LiveAudio | null;

  /** Set by `live_failed`; the call is terminal and never went live. */
  failureReason: string | null;

  /**
   * Server metadata: `tsSent` of the last delta folded into this entity (or the
   * snapshot's own build time for untouched entities). This is the value every
   * "is this delta newer?" decision compares against.
   */
  updatedAt: string;
}

/** Fields `event_updated` may change. `liveAudio` is replaced wholesale. */
export type EarningPatch = Partial<
  Pick<Earning, 'title' | 'date' | 'state' | 'liveAudio' | 'fiscalYear' | 'fiscalPeriod' | 'typeId'>
>;

export type LiveEventType =
  /** New event in the calendar. Carries the full entity. */
  | 'event_scheduled'
  /** Date/time (or other field) changed. */
  | 'event_updated'
  /** The call went live. */
  | 'live_started'
  /** The call finished. */
  | 'live_ended'
  /** The recording is ready. */
  | 'recording_available'
  /** Terminal failure, with a reason. */
  | 'live_failed';

export const LIVE_EVENT_TYPES: readonly LiveEventType[] = [
  'event_scheduled',
  'event_updated',
  'live_started',
  'live_ended',
  'recording_available',
  'live_failed',
];

export interface LiveEventBase {
  /** nchan's global monotonic message counter; mirrored into the SSE `id:`. */
  id: number;
  type: LiveEventType;
  /** Id of the calendar event this delta belongs to (`Earning.id`). */
  eventId: string;
  companyId: string;
  symbol: string;
  /** ISO-8601 UTC, taken when the message is published to nchan. */
  tsSent: string;
}

export interface EventScheduledMessage extends LiveEventBase {
  type: 'event_scheduled';
  /** Full entity: a snapshot older than this message has never seen it. */
  event: Earning;
}

export interface EventUpdatedMessage extends LiveEventBase {
  type: 'event_updated';
  changes: EarningPatch;
  /** What triggered the change, for the UI ("moved", "confirmed", …). */
  reason?: string;
}

export interface LiveStartedMessage extends LiveEventBase {
  type: 'live_started';
  startedAt: string;
  liveAudio: LiveAudio;
}

export interface LiveEndedMessage extends LiveEventBase {
  type: 'live_ended';
  endedAt: string;
  durationSec: number;
}

export interface RecordingAvailableMessage extends LiveEventBase {
  type: 'recording_available';
  recording: {
    url: string;
    title: string;
    durationSec: number;
  };
}

export interface LiveFailedMessage extends LiveEventBase {
  type: 'live_failed';
  failedAt: string;
  reason: string;
}

/** A delta on top of an `Earning`, delivered over the `/live_events` channel. */
export type LiveEventsMessage =
  | EventScheduledMessage
  | EventUpdatedMessage
  | LiveStartedMessage
  | LiveEndedMessage
  | RecordingAvailableMessage
  | LiveFailedMessage;

/** Shorthand used throughout the code; identical to `LiveEventsMessage`. */
export type LiveEvent = LiveEventsMessage;

/** `Omit` that keeps a union a union (plain `Omit` would flatten the variants). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A delta before the broker stamps it with the channel's monotonic `id`. */
export type DraftLiveEvent = DistributiveOmit<LiveEvent, 'id'>;

/**
 * Dedupe key. `eventId` alone is not enough (an event gets many deltas) and
 * `id` alone is not safe across a broker restart, so the key is
 * `eventId + type + tsSent` — unique per message, O(1) to check in a `Set`.
 */
export function dedupeKey(event: Pick<LiveEvent, 'eventId' | 'type' | 'tsSent'>): string {
  return `${event.eventId}|${event.type}|${event.tsSent}`;
}

/** Response of `GET /events` — a point-in-time, intentionally stale snapshot. */
export interface EarningsEventsSnapshot {
  /** The instant the snapshot describes. Deltas after it are the client's job. */
  snapshotAt: string;
  /** `serverTime - snapshotAt`, so the UI can show how stale it is. */
  ageMs: number;
  /** When the response was produced (for clock-skew-aware latency math). */
  serverTime: string;
  symbols: string[];
  events: Earning[];
  /**
   * Set by the client once buffered deltas have been folded in — the snapshot
   * is then no longer "as of `snapshotAt`" but current as of this instant.
   */
  actualizedAt?: string;
  /** How many buffered messages were applied during actualization. */
  actualizedFrom?: number;
}

/** Shorthand used throughout the code; identical to `EarningsEventsSnapshot`. */
export type EventsSnapshot = EarningsEventsSnapshot;

/** Query accepted by `GET /events` / `ILiveEventsHttpApi.fetchSnapshot`. */
export interface SnapshotQuery {
  symbols?: readonly string[];
  signal?: AbortSignal;
}

/** Meta frame the stream sends right after the subscription is established. */
export interface StreamHello {
  channel: string;
  serverTime: string;
  /** Size of the replay window the broker retains, in ms. */
  bufferWindowMs: number;
  replayed: number;
  lastEventId: string | null;
  /** Oldest message still retained — the earliest point a client can resume from. */
  oldestId: number | null;
  newestId: number | null;
}

/**
 * Sent when the requested `Last-Event-ID` has already been evicted from the
 * replay buffer: the client missed deltas and must refetch a snapshot.
 */
export interface StreamGap {
  requestedLastEventId: string | null;
  oldestAvailableId: number | null;
  reason: 'buffer_evicted' | 'unknown_message_id';
}

export const SSE_EVENT_NAMES = {
  hello: 'hello',
  gap: 'gap',
} as const;

/** SSE channel path — the nchan subscriber location. */
export const LIVE_EVENTS_CHANNEL = '/live_events';
