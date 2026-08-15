/**
 * The app's single `/live_events` subscription — one connection per *browser*,
 * not per tab, not per component.
 *
 * Two layers of sharing:
 *
 *  - **Within a tab**: this is a singleton (`getLiveEventsClient()`), so every
 *    component fans out from one transport. A subscriber that attaches late is
 *    replayed the retained buffer, so it starts from the same picture as one
 *    that attached at boot.
 *  - **Across tabs**: exactly one tab wins the Web Locks election and owns the
 *    SSE connection; the rest run as followers and receive messages over a
 *    `BroadcastChannel`. A follower that opens mid-session asks the leader for
 *    its buffer, so it can reconcile its own `/events` snapshot without opening
 *    a second connection. When the leader tab goes away the browser releases
 *    the lock, the next tab is promoted, and it resumes the stream from the
 *    highest message id it has seen — so the handover costs at most a replay,
 *    never a hole.
 */

import {
  type ILiveEventsClient,
  type LiveEventsMessage,
  type ReconnectInfo,
  type StreamGap,
  type StreamHello,
} from '@earnings/shared';
import { LiveEventBuffer } from '../LiveEventBuffer.js';
import {
  CrossTabBus,
  type BroadcastChannelLike,
  type CrossTabMessage,
} from './CrossTabBus.js';
import { LeaderElection, type LockManagerLike } from './LeaderElection.js';
import { SseTransport, type EventSourceLike, type TransportStatus } from './SseTransport.js';

export type ClientRole = 'leader' | 'follower';

export interface LiveEventsClientOptions {
  url: string;
  bufferRetentionMs?: number;
  /** Disable cross-tab sharing (tests, or a deliberately isolated instance). */
  crossTab?: boolean;
  channelName?: string;
  lockName?: string;
  createEventSource?: (url: string) => EventSourceLike;
  /** Test seams for the cross-tab layer. */
  createChannel?: (name: string) => BroadcastChannelLike | null;
  lockManager?: LockManagerLike | null;
  now?: () => number;
}

export interface ClientDiagnostics {
  role: ClientRole;
  connected: boolean;
  transportStatus: TransportStatus | 'follower';
  lastEventId: string | null;
  bufferSize: number;
  reconnects: number;
  crossTabSupported: boolean;
  locksSupported: boolean;
  tabId: string;
}

const randomId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `tab-${Math.random().toString(36).slice(2, 10)}`;

export class LiveEventsClient implements ILiveEventsClient {
  private readonly options: LiveEventsClientOptions;
  private readonly now: () => number;
  private readonly tabId = randomId();

  private readonly buffer: LiveEventBuffer;
  private readonly bus: CrossTabBus | null;
  private readonly election: LeaderElection | null;

  private readonly messageSubscribers = new Set<(message: LiveEventsMessage) => void>();
  private readonly reconnectSubscribers = new Set<(info: ReconnectInfo) => void>();

  private transport: SseTransport | null = null;
  private role: ClientRole = 'follower';
  private started = false;

  private connectedValue = false;
  private leaderConnected = false;
  private downSince: number | null = null;
  private pendingGap: StreamGap | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnects = 0;
  private locksSupported = false;

  constructor(options: LiveEventsClientOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.buffer = new LiveEventBuffer({
      retentionMs: options.bufferRetentionMs ?? 15 * 60_000,
      now: this.now,
    });

    const crossTab = options.crossTab ?? true;
    this.bus = crossTab
      ? new CrossTabBus({
          channelName: options.channelName,
          ...(options.createChannel ? { createChannel: options.createChannel } : {}),
        })
      : null;
    this.election = crossTab
      ? new LeaderElection({
          lockName: options.lockName,
          ...(options.lockManager !== undefined ? { lockManager: options.lockManager } : {}),
          onPromoted: () => this.becomeLeader(),
          onUnsupported: () => {
            this.locksSupported = false;
          },
        })
      : null;
  }

  // --- ILiveEventsClient -------------------------------------------------

  get connected(): boolean {
    return this.role === 'leader' ? this.connectedValue : this.leaderConnected;
  }

  subscribe(cb: (message: LiveEventsMessage) => void): void {
    this.messageSubscribers.add(cb);

    // A late subscriber gets the retained buffer, so every consumer starts from
    // the same picture regardless of when it attached. Consumers dedupe by
    // `eventId|type|tsSent`, so replaying to one of them is always safe.
    // Captured *before* `start()`: on the very first subscribe the buffer is
    // filled by the subscription itself, and those messages reach `cb` through
    // the normal fan-out.
    const backlog = this.started ? this.buffer.all() : [];
    this.start();

    if (backlog.length > 0) {
      queueMicrotask(() => {
        if (!this.messageSubscribers.has(cb)) return;
        for (const message of backlog) cb(message);
      });
    }
  }

  unsubscribe(cb: (message: LiveEventsMessage) => void): void {
    this.messageSubscribers.delete(cb);
  }

  onReconnect(cb: (info: ReconnectInfo) => void): () => void {
    this.reconnectSubscribers.add(cb);
    return () => {
      this.reconnectSubscribers.delete(cb);
    };
  }

  // --- lifecycle ---------------------------------------------------------

  /**
   * Idempotent. The connection outlives individual subscribers on purpose: this
   * is an app-level singleton, and tearing the stream down on every unmount
   * would punch holes into the buffer that nothing downstream could detect.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.bus?.supported) {
      this.bus.on((message) => this.onBusMessage(message));
      // Ask whoever is leading for their buffer. If nobody answers, we are
      // about to be promoted anyway and will get everything from the replay.
      this.bus.post({ kind: 'buffer_request', from: this.tabId });
    }

    if (this.election) {
      this.locksSupported = this.election.supported;
      this.election.start();
    } else {
      this.becomeLeader();
    }
  }

  /** Full teardown. Used by tests and by the "isolated instance" escape hatch. */
  stop(): void {
    this.started = false;
    this.transport?.close();
    this.transport = null;
    this.election?.stop();
    this.bus?.close();
    this.messageSubscribers.clear();
    this.reconnectSubscribers.clear();
    if (this.helloTimer) clearTimeout(this.helloTimer);
  }

  get diagnostics(): ClientDiagnostics {
    return {
      role: this.role,
      connected: this.connected,
      transportStatus: this.transport?.status ?? 'follower',
      lastEventId: this.transport?.lastEventId ?? (this.buffer.lastId?.toString() ?? null),
      bufferSize: this.buffer.size,
      reconnects: this.reconnects,
      crossTabSupported: this.bus?.supported ?? false,
      locksSupported: this.locksSupported,
      tabId: this.tabId,
    };
  }

  // --- leader ------------------------------------------------------------

  private becomeLeader(): void {
    if (this.role === 'leader' && this.transport) return;
    this.role = 'leader';
    this.bus?.post({ kind: 'leader', leaderId: this.tabId, connected: false });

    // Resume from the newest id we know about — ours, or one inherited from the
    // previous leader's buffer. Promotion then costs a replay, not a hole.
    const cursor = this.buffer.lastId !== null ? String(this.buffer.lastId) : null;

    this.transport = new SseTransport({
      url: this.options.url,
      lastEventId: cursor,
      createEventSource: this.options.createEventSource,
      handlers: {
        onMessage: (message) => this.ingest(message, 'transport'),
        onHello: (hello) => this.onHello(hello),
        onGap: (gap) => {
          this.pendingGap = gap;
        },
        onStatus: (status) => this.onTransportStatus(status),
        onError: () => {
          if (this.downSince === null) this.downSince = this.now();
        },
      },
    });
    this.transport.connect();
  }

  private onTransportStatus(status: TransportStatus): void {
    const wasConnected = this.connectedValue;
    this.connectedValue = status === 'open';

    if (status !== 'open' && this.downSince === null) this.downSince = this.now();
    if (wasConnected !== this.connectedValue) {
      this.bus?.post({ kind: 'status', connected: this.connectedValue, leaderId: this.tabId });
    }
  }

  private onHello(hello: StreamHello): void {
    const resumed = hello.lastEventId !== null;
    const downtimeMs = this.downSince === null ? 0 : this.now() - this.downSince;
    this.downSince = null;

    // A fresh subscription is not a reconnect; a resume always is (it either
    // followed an outage or a leader handover).
    if (!resumed) {
      this.pendingGap = null;
      return;
    }

    this.reconnects += 1;
    // The `gap` frame is sent right after `hello`; wait a turn so the info the
    // consumer receives is complete rather than arriving in two pieces.
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      const info: ReconnectInfo = {
        attempt: this.reconnects,
        at: new Date(this.now()).toISOString(),
        downtimeMs,
        lastEventId: hello.lastEventId,
        replayed: hello.replayed,
        gap: this.pendingGap,
        role: 'leader',
      };
      this.pendingGap = null;
      this.emitReconnect(info);
      this.bus?.post({ kind: 'reconnect', info });
    }, 0);
  }

  // --- follower ----------------------------------------------------------

  private onBusMessage(message: CrossTabMessage): void {
    switch (message.kind) {
      case 'live':
        // Followers take the leader's feed; the leader ignores its own echo
        // (BroadcastChannel does not deliver to the sender, but a second leader
        // during a handover is possible — the buffer dedupe absorbs it).
        this.ingest(message.message, 'bus');
        break;

      case 'buffer_request':
        if (this.role === 'leader') {
          this.bus?.post({
            kind: 'buffer_sync',
            to: message.from,
            messages: this.buffer.all(),
            lastEventId: this.transport?.lastEventId ?? null,
          });
          // Status is otherwise only announced on change, which a tab that
          // opened after the connection came up would never hear.
          this.bus?.post({
            kind: 'status',
            connected: this.connectedValue,
            leaderId: this.tabId,
          });
        }
        break;

      case 'buffer_sync':
        if (message.to !== this.tabId || this.role === 'leader') return;
        // Everything the leader has seen so far, so this tab can reconcile its
        // own snapshot fetch without a second connection.
        for (const item of message.messages) this.ingest(item, 'bus');
        break;

      case 'status':
        this.leaderConnected = message.connected;
        break;

      case 'leader':
        this.leaderConnected = message.connected;
        break;

      case 'reconnect':
        if (this.role === 'follower') {
          this.emitReconnect({ ...message.info, role: 'follower' });
        }
        break;
    }
  }

  // --- fan-out -----------------------------------------------------------

  private ingest(message: LiveEventsMessage, origin: 'transport' | 'bus'): void {
    // The buffer is the dedupe gate: replays, cross-tab echoes and the
    // post-promotion overlap all collapse here, before any subscriber sees them.
    if (!this.buffer.add(message)) return;

    if (origin === 'transport') this.bus?.post({ kind: 'live', message });
    for (const subscriber of this.messageSubscribers) subscriber(message);
  }

  private emitReconnect(info: ReconnectInfo): void {
    for (const subscriber of this.reconnectSubscribers) subscriber(info);
  }
}

let singleton: LiveEventsClient | null = null;

/** The app-wide `ILiveEventsClient`. First call wins the configuration. */
export function getLiveEventsClient(options: LiveEventsClientOptions): LiveEventsClient {
  singleton ??= new LiveEventsClient(options);
  return singleton;
}

/** Test/HMR helper: drops the singleton so the next call builds a fresh one. */
export function resetLiveEventsClient(): void {
  singleton?.stop();
  singleton = null;
}
