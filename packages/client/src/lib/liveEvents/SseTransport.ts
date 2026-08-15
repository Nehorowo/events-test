/**
 * The raw SSE transport. Only the leader tab ever instantiates one.
 *
 * Why not plain `EventSource` with its built-in reconnect: we need (a) a cursor
 * we control, (b) backoff we control, and (c) to know *that* a reconnect
 * happened and how long the channel was down — none of which the native
 * auto-reconnect exposes. So every error closes the socket and we schedule our
 * own retry.
 *
 * The cursor travels as `?last_event_id=` because a browser `EventSource`
 * cannot set request headers. The server accepts the standard `Last-Event-ID`
 * header too, so a Node consumer (or nchan itself) can use that instead.
 */

import {
  LIVE_EVENT_TYPES,
  SSE_EVENT_NAMES,
  type LiveEventsMessage,
  type StreamGap,
  type StreamHello,
} from '@earnings/shared';

export type TransportStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The slice of `EventSource` we use — narrow enough to fake in tests. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
}

export interface SseTransportHandlers {
  onMessage(message: LiveEventsMessage): void;
  onHello(hello: StreamHello): void;
  onGap(gap: StreamGap): void;
  onStatus(status: TransportStatus, detail: { attempt: number; nextRetryMs?: number }): void;
  onError(error: Error): void;
}

export interface SseTransportOptions {
  url: string;
  handlers: SseTransportHandlers;
  /** Injection point for tests and non-browser runtimes. */
  createEventSource?: (url: string) => EventSourceLike;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Resume cursor, e.g. inherited from the buffer after a leader promotion. */
  lastEventId?: string | null;
}

const defaultFactory = (url: string): EventSourceLike => new EventSource(url);

export class SseTransport {
  private readonly url: string;
  private readonly handlers: SseTransportHandlers;
  private readonly createEventSource: (url: string) => EventSourceLike;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  private source: EventSourceLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private manuallyClosed = false;

  private lastEventIdValue: string | null;
  private statusValue: TransportStatus = 'idle';

  constructor(options: SseTransportOptions) {
    this.url = options.url;
    this.handlers = options.handlers;
    this.createEventSource = options.createEventSource ?? defaultFactory;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 15_000;
    this.lastEventIdValue = options.lastEventId ?? null;
  }

  get status(): TransportStatus {
    return this.statusValue;
  }

  get connected(): boolean {
    return this.statusValue === 'open';
  }

  get lastEventId(): string | null {
    return this.lastEventIdValue;
  }

  /** Adopts a cursor learned elsewhere (e.g. from the shared buffer). */
  setCursor(lastEventId: string | null): void {
    if (lastEventId) this.lastEventIdValue = lastEventId;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.open();
  }

  /** Drops the socket and reconnects immediately, keeping the cursor. */
  reconnect(): void {
    this.teardown();
    this.attempt = 0;
    this.connect();
  }

  close(): void {
    this.manuallyClosed = true;
    this.teardown();
    this.setStatus('closed');
  }

  buildUrl(): string {
    const url = new URL(this.url, globalThis.location?.origin ?? 'http://localhost');
    if (this.lastEventIdValue) url.searchParams.set('last_event_id', this.lastEventIdValue);
    return url.toString();
  }

  // --- internals ---------------------------------------------------------

  private open(): void {
    this.teardown();
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let source: EventSourceLike;
    try {
      source = this.createEventSource(this.buildUrl());
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error : new Error(String(error)));
      this.scheduleRetry();
      return;
    }
    this.source = source;

    source.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
    };

    source.onerror = () => {
      // `EventSource` never says why. Treat every error as a dropped connection
      // and resume from our cursor after a backoff.
      this.handlers.onError(new Error('SSE connection lost'));
      this.scheduleRetry();
    };

    source.addEventListener(SSE_EVENT_NAMES.hello, (event) => {
      const hello = this.parse<StreamHello>(event);
      if (hello) this.handlers.onHello(hello);
    });

    source.addEventListener(SSE_EVENT_NAMES.gap, (event) => {
      const gap = this.parse<StreamGap>(event);
      if (gap) this.handlers.onGap(gap);
    });

    // One listener per message type: `event:` carries the type, and the body
    // repeats it for consumers that only look at `data:`.
    for (const type of LIVE_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const message = this.parse<LiveEventsMessage>(event);
        if (!message) return;
        // Advance the cursor only on real messages, so a resume picks up
        // exactly where the last delivered message left off.
        this.lastEventIdValue = event.lastEventId || String(message.id) || this.lastEventIdValue;
        this.handlers.onMessage(message);
      });
    }
  }

  private parse<T>(event: MessageEvent): T | null {
    try {
      return JSON.parse(event.data as string) as T;
    } catch (error) {
      this.handlers.onError(new Error(`Malformed SSE payload: ${(error as Error).message}`));
      return null;
    }
  }

  private scheduleRetry(): void {
    this.teardown();
    if (this.manuallyClosed) return;

    this.attempt += 1;
    const exponential = this.baseRetryDelayMs * 2 ** (this.attempt - 1);
    const capped = Math.min(exponential, this.maxRetryDelayMs);
    // Jitter keeps a fleet of tabs from reconnecting in lockstep.
    const delay = Math.round(capped * (0.7 + Math.random() * 0.6));

    this.setStatus('reconnecting', { nextRetryMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private teardown(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.source) {
      this.source.onerror = null;
      this.source.onopen = null;
      this.source.close();
      this.source = null;
    }
  }

  private setStatus(status: TransportStatus, detail: { nextRetryMs?: number } = {}): void {
    this.statusValue = status;
    this.handlers.onStatus(status, { attempt: this.attempt, ...detail });
  }
}
