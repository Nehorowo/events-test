import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Earning,
  EarningsEventsSnapshot,
  ILiveEventsClient,
  LiveEventsMessage,
  ReconnectInfo,
} from '@earnings/shared';
import { EarningsEventsProvider } from './EarningsEventsProvider.js';

const NOW = Date.UTC(2026, 0, 1, 12, 20);
const at = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();

/** Stub of the singleton, so the provider can be driven message by message. */
class FakeClient implements ILiveEventsClient {
  connected = true;
  private readonly subscribers = new Set<(message: LiveEventsMessage) => void>();
  private readonly reconnectSubscribers = new Set<(info: ReconnectInfo) => void>();

  subscribe(cb: (message: LiveEventsMessage) => void): void {
    this.subscribers.add(cb);
  }
  unsubscribe(cb: (message: LiveEventsMessage) => void): void {
    this.subscribers.delete(cb);
  }
  onReconnect(cb: (info: ReconnectInfo) => void): () => void {
    this.reconnectSubscribers.add(cb);
    return () => this.reconnectSubscribers.delete(cb);
  }

  emit(message: LiveEventsMessage): void {
    for (const cb of this.subscribers) cb(message);
  }
  emitReconnect(info: ReconnectInfo): void {
    for (const cb of this.reconnectSubscribers) cb(info);
  }
}

const earning = (over: Partial<Earning> = {}): Earning => ({
  id: 'evt-aapl-2026q1',
  companyId: 'c-aapl',
  symbol: 'AAPL',
  title: 'Apple Inc. Q1 2026 Earnings Call',
  date: at(15),
  typeId: 1,
  fiscalYear: 2026,
  fiscalPeriod: 'Q1',
  state: 'scheduled',
  liveAudio: null,
  failureReason: null,
  updatedAt: at(8),
  ...over,
});

const snapshot = (events: Earning[], builtAt = 10): EarningsEventsSnapshot => ({
  snapshotAt: at(builtAt),
  ageMs: 10 * 60_000,
  serverTime: at(builtAt + 10),
  symbols: ['AAPL', 'MSFT'],
  events,
});

const liveStarted = (id: number, minutes: number, symbol = 'AAPL'): LiveEventsMessage => ({
  id,
  type: 'live_started',
  eventId: `evt-${symbol.toLowerCase()}-2026q1`,
  companyId: `c-${symbol.toLowerCase()}`,
  symbol,
  tsSent: at(minutes),
  startedAt: at(minutes),
  liveAudio: {
    url: 'https://stream.example.com/a.m3u8',
    title: 'live audio',
    startedAt: null,
    durationSec: null,
    isReplay: false,
  },
});

describe('EarningsEventsProvider', () => {
  let client: FakeClient;
  let provider: EarningsEventsProvider;

  beforeEach(() => {
    client = new FakeClient();
    provider = new EarningsEventsProvider({
      client,
      symbols: ['AAPL', 'MSFT'],
      now: () => NOW,
    });
    provider.start();
  });

  it('buffers deltas that arrive before the snapshot, then folds them onto it', () => {
    // The page subscribed first: these land while `/events` is still in flight.
    client.emit(liveStarted(1, 12));
    expect(provider.snapshot).toBeNull();
    expect(provider.getState().counters.bufferedBeforeSnapshot).toBe(1);

    // The snapshot is 10 minutes old and still says "scheduled".
    const actualized = provider.actualizeSnapshot(snapshot([earning()]));

    expect(actualized.events[0]?.state).toBe('live');
    expect(actualized.actualizedFrom).toBe(1);
    expect(provider.snapshot).toBe(actualized);
    expect(provider.getState().phase).toBe('ready');
  });

  it('discards buffered deltas the snapshot already reflects', () => {
    client.emit(liveStarted(1, 9)); // published *before* the snapshot was built
    provider.actualizeSnapshot(snapshot([earning({ state: 'live', updatedAt: at(9) })]));

    expect(provider.getState().counters.stale).toBe(1);
    expect(provider.getState().counters.applied).toBe(0);
  });

  it('applies deltas directly once the snapshot is in place', () => {
    provider.actualizeSnapshot(snapshot([earning()]));
    client.emit(liveStarted(2, 14));

    expect(provider.snapshot?.events[0]?.state).toBe('live');
    expect(provider.getState().counters.applied).toBe(1);
  });

  it('filters symbols outside the watchlist without touching the buffer', () => {
    client.emit(liveStarted(3, 12, 'TSLA'));
    expect(provider.getState().counters.filtered).toBe(1);
    expect(provider.getState().buffer.size).toBe(0);
  });

  it('reports a coverage hole and asks for a refetch', () => {
    const reasons: string[] = [];
    provider.onRefetchNeeded((reason) => reasons.push(reason));

    // Buffer starts at 12:14, snapshot describes 12:10 — 12:10→12:14 is
    // unaccounted for, so the merged state cannot be trusted.
    client.emit(liveStarted(4, 14));
    provider.actualizeSnapshot(snapshot([earning()], 10));

    expect(provider.getState().coverage).toMatchObject({ covered: false, holeMs: 4 * 60_000 });
    expect(reasons).toHaveLength(1);
  });

  it('asks for a refetch when the stream reconnects with a replay gap', () => {
    const reasons: string[] = [];
    provider.onRefetchNeeded((reason) => reasons.push(reason));

    provider.actualizeSnapshot(snapshot([earning()]));
    client.emitReconnect({
      attempt: 1,
      at: at(18),
      downtimeMs: 900_000,
      lastEventId: '4',
      replayed: 0,
      gap: { requestedLastEventId: '4', oldestAvailableId: 900, reason: 'buffer_evicted' },
      role: 'leader',
    });

    expect(reasons[0]).toContain('replay gap');
  });

  it('does not roll an event back when a stale snapshot is refetched', () => {
    provider.actualizeSnapshot(snapshot([earning()]));
    client.emit(liveStarted(5, 16));
    expect(provider.snapshot?.events[0]?.state).toBe('live');

    // A refetch returns a snapshot built before the live delta. The held state
    // is newer, so it must win.
    provider.actualizeSnapshot(snapshot([earning({ updatedAt: at(11) })], 11));

    expect(provider.snapshot?.events[0]?.state).toBe('live');
  });

  it('measures end-to-end latency from tsSent, excluding replayed messages', () => {
    // 12:19:50 → 10s old: a live message.
    client.emit({ ...liveStarted(6, 19), tsSent: new Date(NOW - 10_000).toISOString() });
    expect(provider.getState().latency.lastMs).toBe(10_000);
    expect(provider.getState().latency.samples).toBe(1);

    // Ten minutes old: this came out of the replay buffer, not the wire.
    client.emit(liveStarted(7, 10, 'MSFT'));
    const latency = provider.getState().latency;
    expect(latency.replayedCount).toBe(1);
    expect(latency.lastMs).toBe(10_000);
    expect(latency.samples).toBe(1);
  });
});
