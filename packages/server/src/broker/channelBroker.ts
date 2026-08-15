/**
 * In-process pub/sub that mimics the parts of nchan the client depends on:
 *
 *  - a bounded per-channel message buffer (`nchan_message_buffer_length` /
 *    `nchan_message_timeout`), replayed to new subscribers;
 *  - a global monotonic message counter exposed as the SSE `id:` field;
 *  - resuming from `Last-Event-ID` (header, or `?last_event_id=` for browsers,
 *    which cannot set headers on `EventSource`);
 *  - a `gap` notice when the requested id has already been evicted — the
 *    client's cue that its buffer is no longer contiguous with the channel and
 *    that it must refetch a snapshot.
 *
 * The channel is *not* filtered server-side. That is deliberate: nchan replays
 * a channel verbatim, so every subscriber gets every message and decides for
 * itself what to show. `companyId`/`symbol` are in every payload for exactly
 * that reason.
 */

import { compareMessageIds, parseMessageId, type DraftLiveEvent, type LiveEvent } from '@earnings/shared';

export interface BrokerOptions {
  channel: string;
  windowMs: number;
  maxMessages: number;
}

export interface ReplayRequest {
  lastEventId?: string | null;
  /** `false` skips the replay buffer and delivers only future messages. */
  replay?: boolean;
}

export interface ReplayResult {
  events: LiveEvent[];
  gap: null | { oldestAvailableId: number | null; reason: 'buffer_evicted' | 'unknown_message_id' };
}

type Listener = (event: LiveEvent) => void;

export class ChannelBroker {
  private readonly options: BrokerOptions;
  private readonly buffer: LiveEvent[] = [];
  private readonly subscribers = new Set<Listener>();

  /** nchan's autoincrementing per-channel message counter. */
  private nextId = 1;

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  get channel(): string {
    return this.options.channel;
  }

  get windowMs(): number {
    return this.options.windowMs;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get oldestId(): number | null {
    return this.buffer[0]?.id ?? null;
  }

  get newestId(): number | null {
    return this.buffer[this.buffer.length - 1]?.id ?? null;
  }

  /**
   * Stamps a draft with the channel's next id, buffers it and fans it out.
   * Drafts must be published in chronological order (which is how both the
   * backfill and the ticker feed this method), so ids and `tsSent` agree.
   */
  publish(draft: DraftLiveEvent): LiveEvent {
    const event = { ...draft, id: this.nextId } as LiveEvent;
    this.nextId += 1;

    this.buffer.push(event);
    this.trim(Date.parse(event.tsSent));

    for (const listener of this.subscribers) listener(event);

    return event;
  }

  /** The messages a subscriber resuming from `lastEventId` still needs. */
  replay(request: ReplayRequest = {}): ReplayResult {
    if (request.replay === false) return { events: [], gap: null };

    const lastEventId = request.lastEventId ?? null;
    if (!lastEventId) {
      // No cursor: behave like `nchan_subscriber_first_message oldest` and hand
      // over the whole retained window. This is what lets a page that
      // subscribes *before* fetching cover the snapshot's staleness.
      return { events: [...this.buffer], gap: null };
    }

    const cursor = parseMessageId(lastEventId);
    const oldest = this.oldestId;

    if (cursor === null) {
      return {
        events: [...this.buffer],
        gap: { oldestAvailableId: oldest, reason: 'unknown_message_id' },
      };
    }

    if (oldest !== null && cursor < oldest - 1) {
      // Everything between the cursor and the buffer has been evicted.
      return {
        events: [...this.buffer],
        gap: { oldestAvailableId: oldest, reason: 'buffer_evicted' },
      };
    }

    return {
      events: this.buffer.filter((event) => compareMessageIds(event.id, cursor) > 0),
      gap: null,
    };
  }

  subscribe(listener: Listener): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - this.options.windowMs;
    let drop = 0;
    while (drop < this.buffer.length && Date.parse(this.buffer[drop]!.tsSent) < cutoff) {
      drop += 1;
    }
    if (this.buffer.length - drop > this.options.maxMessages) {
      drop = this.buffer.length - this.options.maxMessages;
    }
    if (drop > 0) this.buffer.splice(0, drop);
  }
}
