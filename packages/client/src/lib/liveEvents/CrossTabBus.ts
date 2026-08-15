/**
 * The cross-tab wire: a `BroadcastChannel` carrying everything a follower tab
 * needs so that only the leader holds an SSE connection.
 *
 * Traffic is deliberately small: individual messages as they arrive, plus a
 * one-off buffer transfer when a tab joins mid-session (it has to reconcile its
 * own `/events` snapshot and cannot do that from an empty buffer).
 */

import type { LiveEventsMessage, ReconnectInfo } from '@earnings/shared';

export type CrossTabMessage =
  /** Leader → all: a message straight off the channel. */
  | { kind: 'live'; message: LiveEventsMessage }
  /** Follower → leader: "I just opened, send me what you have". */
  | { kind: 'buffer_request'; from: string }
  /** Leader → all: the retained buffer, answering a `buffer_request`. */
  | { kind: 'buffer_sync'; to: string; messages: LiveEventsMessage[]; lastEventId: string | null }
  /** Leader → all: connection state changed. */
  | { kind: 'status'; connected: boolean; leaderId: string }
  /** Leader → all: the stream reconnected (possibly with a gap). */
  | { kind: 'reconnect'; info: ReconnectInfo }
  /** Leader → all: "I am the leader" (sent on promotion and on request). */
  | { kind: 'leader'; leaderId: string; connected: boolean };

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface CrossTabBusOptions {
  channelName?: string;
  createChannel?: (name: string) => BroadcastChannelLike | null;
}

const defaultFactory = (name: string): BroadcastChannelLike | null =>
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name);

export class CrossTabBus {
  private readonly channel: BroadcastChannelLike | null;
  private readonly listeners = new Set<(message: CrossTabMessage) => void>();

  constructor(options: CrossTabBusOptions = {}) {
    const factory = options.createChannel ?? defaultFactory;
    this.channel = factory(options.channelName ?? 'live_events');

    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent) => {
        const message = event.data as CrossTabMessage;
        if (!message || typeof message.kind !== 'string') return;
        for (const listener of this.listeners) listener(message);
      };
    }
  }

  /** `false` when `BroadcastChannel` is unavailable — tabs then work alone. */
  get supported(): boolean {
    return this.channel !== null;
  }

  post(message: CrossTabMessage): void {
    this.channel?.postMessage(message);
  }

  on(listener: (message: CrossTabMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.listeners.clear();
    this.channel?.close();
  }
}
