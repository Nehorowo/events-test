import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveEventsMessage } from '@earnings/shared';
import { LiveEventsClient } from './LiveEventsClient.js';
import type { BroadcastChannelLike } from './CrossTabBus.js';
import type { EventSourceLike } from './SseTransport.js';
import type { LockManagerLike } from './LeaderElection.js';

/** In-memory `BroadcastChannel` hub: delivers to every channel but the sender. */
class FakeBroadcastHub {
  private readonly channels = new Set<FakeChannel>();

  create = (): BroadcastChannelLike => {
    const channel = new FakeChannel(this);
    this.channels.add(channel);
    return channel;
  };

  deliver(from: FakeChannel, message: unknown): void {
    for (const channel of this.channels) {
      if (channel === from || channel.closed) continue;
      channel.onmessage?.({ data: message } as MessageEvent);
    }
  }

  remove(channel: FakeChannel): void {
    this.channels.delete(channel);
  }
}

class FakeChannel implements BroadcastChannelLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  constructor(private readonly hub: FakeBroadcastHub) {}
  postMessage(message: unknown): void {
    this.hub.deliver(this, message);
  }
  close(): void {
    this.closed = true;
    this.hub.remove(this);
  }
}

/** Single-holder lock queue, like the real Web Locks API. */
class FakeLockManager implements LockManagerLike {
  private held = false;
  private readonly queue: (() => void)[] = [];

  async request(
    _name: string,
    _options: { mode: 'exclusive' | 'shared'; signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void> {
    const run = async () => {
      this.held = true;
      await callback();
      this.held = false;
      this.queue.shift()?.();
    };
    if (!this.held) return run();
    return new Promise<void>((resolve) => {
      this.queue.push(() => void run().then(resolve));
    });
  }
}

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({} as Event);
  }

  emit(type: string, data: unknown, id?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId: id ?? '' } as MessageEvent);
    }
  }
}

const message = (id: number, symbol = 'AAPL'): LiveEventsMessage => ({
  id,
  type: 'live_started',
  eventId: `evt-${symbol.toLowerCase()}-2026q1`,
  companyId: `c-${symbol.toLowerCase()}`,
  symbol,
  tsSent: new Date(Date.UTC(2026, 0, 1, 12, id)).toISOString(),
  startedAt: new Date(Date.UTC(2026, 0, 1, 12, id)).toISOString(),
  liveAudio: {
    url: 'https://stream.example.com/a.m3u8',
    title: 'live',
    startedAt: null,
    durationSec: null,
    isReplay: false,
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LiveEventsClient', () => {
  let hub: FakeBroadcastHub;
  let locks: FakeLockManager;

  const makeClient = () =>
    new LiveEventsClient({
      url: '/live_events',
      createChannel: hub.create,
      lockManager: locks,
      createEventSource: (url) => new FakeEventSource(url),
      // Close to the message timestamps: the buffer prunes by `tsSent`
      // against the local clock, so a far-future clock would evict everything.
      now: () => Date.UTC(2026, 0, 1, 12, 5),
    });

  beforeEach(() => {
    hub = new FakeBroadcastHub();
    locks = new FakeLockManager();
    FakeEventSource.instances = [];
  });

  it('opens exactly one connection across tabs and fans out to followers', async () => {
    const leaderTab = makeClient();
    const followerTab = makeClient();

    const leaderSeen: number[] = [];
    const followerSeen: number[] = [];
    leaderTab.subscribe((m) => leaderSeen.push(m.id));
    followerTab.subscribe((m) => followerSeen.push(m.id));
    await flush();

    // Only the tab holding the lock owns an EventSource.
    expect(FakeEventSource.instances).toHaveLength(1);

    const source = FakeEventSource.instances[0]!;
    source.open();
    source.emit('live_started', message(1), '1');
    await flush();

    expect(leaderSeen).toEqual([1]);
    expect(followerSeen).toEqual([1]);
    expect(leaderTab.diagnostics.role).toBe('leader');
    expect(followerTab.diagnostics.role).toBe('follower');
    expect(followerTab.connected).toBe(true);
  });

  it('hands the buffer to a tab that opens mid-session', async () => {
    const leaderTab = makeClient();
    leaderTab.subscribe(() => {});
    await flush();

    const source = FakeEventSource.instances[0]!;
    source.open();
    source.emit('live_started', message(1), '1');
    source.emit('live_started', message(2, 'MSFT'), '2');
    await flush();

    // A second tab opens now — it must still be able to reconcile its own
    // snapshot, so the leader replays what it has.
    const lateTab = makeClient();
    const lateSeen: number[] = [];
    lateTab.subscribe((m) => lateSeen.push(m.id));
    await flush();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(lateSeen.sort()).toEqual([1, 2]);
  });

  it('deduplicates a message that arrives twice', async () => {
    const tab = makeClient();
    const seen: number[] = [];
    tab.subscribe((m) => seen.push(m.id));
    await flush();

    const source = FakeEventSource.instances[0]!;
    source.open();
    source.emit('live_started', message(1), '1');
    source.emit('live_started', message(1), '1');
    await flush();

    expect(seen).toEqual([1]);
  });

  it('promotes a follower when the leader tab goes away, resuming from its cursor', async () => {
    const leaderTab = makeClient();
    const followerTab = makeClient();
    leaderTab.subscribe(() => {});
    followerTab.subscribe(() => {});
    await flush();

    const source = FakeEventSource.instances[0]!;
    source.open();
    source.emit('live_started', message(1), '1');
    source.emit('live_started', message(2, 'MSFT'), '2');
    await flush();

    leaderTab.stop(); // tab closed → the browser releases the lock
    await flush();

    expect(FakeEventSource.instances).toHaveLength(2);
    // The new leader resumes from the highest id it had buffered, so the
    // handover costs a replay at worst, never a hole.
    expect(FakeEventSource.instances[1]!.url).toContain('last_event_id=2');
    expect(followerTab.diagnostics.role).toBe('leader');
  });

  it('flags buffered messages as replay and live ones as live', async () => {
    const tab = makeClient();
    const seen: { id: number; replayed: boolean | undefined }[] = [];
    tab.subscribe((m, meta) => seen.push({ id: m.id, replayed: meta?.replayed }));
    await flush();

    const source = FakeEventSource.instances[0]!;
    source.open();
    // The channel announces two buffered messages, then streams live.
    source.emit('hello', {
      channel: 'live_events',
      serverTime: new Date().toISOString(),
      bufferWindowMs: 600_000,
      replayed: 2,
      lastEventId: null,
      oldestId: 1,
      newestId: 3,
    });
    source.emit('live_started', message(1), '1');
    source.emit('live_started', message(2, 'MSFT'), '2');
    source.emit('live_started', message(3, 'NVDA'), '3');
    await flush();

    expect(seen).toEqual([
      { id: 1, replayed: true },
      { id: 2, replayed: true },
      { id: 3, replayed: false },
    ]);
  });

  it('reports a replay gap to consumers so they can refetch', async () => {
    const tab = makeClient();
    const infos: unknown[] = [];
    tab.subscribe(() => {});
    tab.onReconnect((info) => infos.push(info));
    await flush();

    const source = FakeEventSource.instances[0]!;
    source.open();
    source.emit('live_started', message(5), '5');

    // Connection drops and comes back; the broker cannot replay from id 5.
    source.onerror?.({} as Event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const resumed = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    resumed.open();
    resumed.emit('hello', {
      channel: 'live_events',
      serverTime: new Date().toISOString(),
      bufferWindowMs: 600_000,
      replayed: 0,
      lastEventId: '5',
      oldestId: 40,
      newestId: 90,
    });
    resumed.emit('gap', {
      requestedLastEventId: '5',
      oldestAvailableId: 40,
      reason: 'buffer_evicted',
    });
    await flush();

    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ role: 'leader', gap: { reason: 'buffer_evicted' } });
  });
});
