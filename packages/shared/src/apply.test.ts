import { describe, expect, it } from 'vitest';
import {
  applyLiveEvent,
  assessCoverage,
  foldLiveEvents,
  mergeSnapshotWithBuffer,
} from './apply.js';
import type { Earning, EarningsEventsSnapshot, LiveEventsMessage } from './types.js';

const at = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();

const earning = (overrides: Partial<Earning> = {}): Earning => ({
  id: 'evt-aapl-2026q1',
  companyId: 'c-aapl',
  symbol: 'AAPL',
  title: 'Apple Inc. Q1 2026 Earnings Call',
  date: at(30),
  typeId: 1,
  fiscalYear: 2026,
  fiscalPeriod: 'Q1',
  state: 'scheduled',
  liveAudio: null,
  failureReason: null,
  updatedAt: at(0),
  ...overrides,
});

const base = { eventId: 'evt-aapl-2026q1', companyId: 'c-aapl', symbol: 'AAPL' };

const started = (id: number, minutes: number): LiveEventsMessage => ({
  ...base,
  id,
  type: 'live_started',
  tsSent: at(minutes),
  startedAt: at(minutes),
  liveAudio: {
    url: 'https://stream.example.com/aapl.m3u8',
    title: 'AAPL live',
    startedAt: null,
    durationSec: null,
    isReplay: false,
  },
});

const ended = (id: number, minutes: number): LiveEventsMessage => ({
  ...base,
  id,
  type: 'live_ended',
  tsSent: at(minutes),
  endedAt: at(minutes),
  durationSec: 3600,
});

const recording = (id: number, minutes: number): LiveEventsMessage => ({
  ...base,
  id,
  type: 'recording_available',
  tsSent: at(minutes),
  recording: { url: 'https://replay.example.com/aapl.mp3', title: 'AAPL replay', durationSec: 3600 },
});

const scheduled = (id: number, minutes: number, eventId: string): LiveEventsMessage => ({
  ...base,
  eventId,
  id,
  type: 'event_scheduled',
  tsSent: at(minutes),
  event: earning({ id: eventId, fiscalPeriod: 'Q2', updatedAt: at(minutes) }),
});

const snapshotOf = (events: Earning[], minutes: number): EarningsEventsSnapshot => ({
  snapshotAt: at(minutes),
  ageMs: 10 * 60_000,
  serverTime: at(minutes + 10),
  symbols: ['AAPL'],
  events,
});

describe('applyLiveEvent', () => {
  it('applies a delta newer than the entity', () => {
    const result = applyLiveEvent(earning(), started(1, 5));
    expect(result.outcome).toBe('applied');
    expect(result.earning?.state).toBe('live');
    expect(result.earning?.liveAudio?.startedAt).toBe(at(5));
    expect(result.earning?.updatedAt).toBe(at(5));
  });

  it('drops a delta the entity already reflects', () => {
    const current = earning({ state: 'live', updatedAt: at(10) });
    const result = applyLiveEvent(current, started(1, 5));
    expect(result.outcome).toBe('stale');
    expect(result.earning).toBe(current);
  });

  it('treats an equal timestamp as already applied', () => {
    const result = applyLiveEvent(earning({ updatedAt: at(5) }), started(1, 5));
    expect(result.outcome).toBe('stale');
  });

  it('materialises an unknown event only from event_scheduled', () => {
    expect(applyLiveEvent(undefined, scheduled(1, 5, 'evt-aapl-2026q2')).outcome).toBe('created');
    expect(applyLiveEvent(undefined, started(1, 5)).outcome).toBe('orphan');
  });

  it('keeps the recording and clears live state on recording_available', () => {
    const live = applyLiveEvent(earning(), started(1, 5)).earning!;
    const done = applyLiveEvent(live, recording(2, 20)).earning!;
    expect(done.state).toBe('completed');
    expect(done.liveAudio).toMatchObject({ isReplay: true, durationSec: 3600 });
    expect(done.liveAudio?.startedAt).toBe(at(5));
  });

  it('marks a failed call terminal with its reason', () => {
    const failed = applyLiveEvent(earning(), {
      ...base,
      id: 9,
      type: 'live_failed',
      tsSent: at(6),
      failedAt: at(6),
      reason: 'encoder_timeout',
    }).earning!;
    expect(failed.state).toBe('ended');
    expect(failed.failureReason).toBe('encoder_timeout');
    expect(failed.liveAudio).toBeNull();
  });
});

describe('foldLiveEvents', () => {
  it('is order-independent for the same set of deltas', () => {
    const messages = [started(1, 5), ended(2, 10), recording(3, 15)];
    const forward = foldLiveEvents([earning()], messages);
    const shuffled = foldLiveEvents([earning()], [messages[2]!, messages[0]!, messages[1]!]);
    expect(forward.events.get(base.eventId)).toEqual(shuffled.events.get(base.eventId));
  });

  it('is idempotent when the same deltas are folded twice', () => {
    const messages = [started(1, 5), ended(2, 10)];
    const once = foldLiveEvents([earning()], messages);
    const twice = foldLiveEvents(once.events, messages);
    expect(twice.events.get(base.eventId)).toEqual(once.events.get(base.eventId));
    expect(twice.counts.stale).toBe(2);
  });

  it('filters messages outside the watchlist', () => {
    const other: LiveEventsMessage = { ...started(4, 5), symbol: 'MSFT' };
    const result = foldLiveEvents([earning()], [other], { symbols: ['AAPL'] });
    expect(result.counts.filtered).toBe(1);
  });

  it('reports deltas with no base entity as orphans', () => {
    const result = foldLiveEvents([], [started(1, 5)]);
    expect(result.counts.orphan).toBe(1);
    expect(result.orphans).toHaveLength(1);
  });
});

describe('mergeSnapshotWithBuffer', () => {
  it('drops buffered deltas the snapshot already contains and applies the rest', () => {
    // Snapshot built at 12:10 already knows the call went live at 12:05.
    const snapshot = snapshotOf([earning({ state: 'live', updatedAt: at(5) })], 10);
    // The buffer overlaps: it still holds the 12:05 delta plus newer ones.
    const merged = mergeSnapshotWithBuffer(snapshot, [
      started(1, 5),
      ended(2, 12),
      recording(3, 18),
    ]);

    expect(merged.counts.stale).toBe(1);
    expect(merged.counts.applied).toBe(2);
    expect(merged.events.get(base.eventId)?.state).toBe('completed');
  });

  it('adds events created after the snapshot was built', () => {
    const snapshot = snapshotOf([earning()], 10);
    const merged = mergeSnapshotWithBuffer(snapshot, [scheduled(5, 14, 'evt-aapl-2026q2')]);
    expect(merged.events.size).toBe(2);
    expect(merged.counts.created).toBe(1);
  });
});

describe('assessCoverage', () => {
  it('is covered when the buffer reaches back past the snapshot', () => {
    const coverage = assessCoverage({ snapshotAt: at(10) }, [started(1, 8), ended(2, 12)]);
    expect(coverage.covered).toBe(true);
    expect(coverage.holeMs).toBe(0);
  });

  it('reports the hole when the buffer starts after the snapshot', () => {
    // Subscribed too late: nothing accounts for 12:10 → 12:14.
    const coverage = assessCoverage({ snapshotAt: at(10) }, [ended(2, 14)]);
    expect(coverage.covered).toBe(false);
    expect(coverage.holeMs).toBe(4 * 60_000);
  });
});
