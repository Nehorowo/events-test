import { describe, expect, it } from 'vitest';
import type { LiveEventsMessage } from '@earnings/shared';
import { LiveEventBuffer } from './LiveEventBuffer.js';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

const message = (id: number, minutes: number, over: Partial<LiveEventsMessage> = {}) =>
  ({
    id,
    type: 'live_ended',
    eventId: 'evt-aapl-2026q1',
    companyId: 'c-aapl',
    symbol: 'AAPL',
    tsSent: at(minutes),
    endedAt: at(minutes),
    durationSec: 60,
    ...over,
  }) as LiveEventsMessage;

describe('LiveEventBuffer', () => {
  it('dedupes on eventId|type|tsSent, not on channel id', () => {
    const buffer = new LiveEventBuffer({ now: () => T0 });
    expect(buffer.add(message(1, 0))).toBe(true);
    // Same message redelivered by a replay, renumbered by a restarted broker.
    expect(buffer.add(message(99, 0))).toBe(false);
    expect(buffer.size).toBe(1);
    expect(buffer.stats.duplicates).toBe(1);
  });

  it('keeps distinct deltas of the same type for the same event', () => {
    const buffer = new LiveEventBuffer({ now: () => T0 });
    buffer.add(message(1, 0, { type: 'event_updated', changes: { date: at(9) } }));
    buffer.add(message(2, 1, { type: 'event_updated', changes: { date: at(8) } }));
    expect(buffer.size).toBe(2);
  });

  it('evicts messages older than the retention window', () => {
    let now = T0;
    const buffer = new LiveEventBuffer({ retentionMs: 15 * 60_000, now: () => now });
    buffer.add(message(1, 0));
    buffer.add(message(2, 10));

    now = T0 + 20 * 60_000;
    expect(buffer.all()).toHaveLength(1);
    expect(buffer.stats.droppedByAge).toBe(1);
  });

  it('re-admits a message whose key was evicted', () => {
    let now = T0;
    const buffer = new LiveEventBuffer({ retentionMs: 5 * 60_000, now: () => now });
    buffer.add(message(1, 0));
    now = T0 + 10 * 60_000;
    buffer.all();
    // The key is gone with the message, so nothing silently swallows a re-send.
    expect(buffer.add(message(1, 10))).toBe(true);
  });

  it('exposes the highest channel id as the resume cursor', () => {
    const buffer = new LiveEventBuffer({ now: () => T0 });
    buffer.add(message(7, 0));
    buffer.add(message(3, 1));
    expect(buffer.lastId).toBe(7);
  });

  it('returns messages in channel order regardless of arrival order', () => {
    const buffer = new LiveEventBuffer({ now: () => T0 });
    buffer.add(message(3, 2));
    buffer.add(message(1, 0));
    buffer.add(message(2, 1));
    expect(buffer.all().map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('caps the buffer at maxSize, dropping the oldest', () => {
    const buffer = new LiveEventBuffer({ maxSize: 2, now: () => T0 });
    buffer.add(message(1, 0));
    buffer.add(message(2, 1));
    buffer.add(message(3, 2));
    expect(buffer.all().map((m) => m.id)).toEqual([2, 3]);
    expect(buffer.stats.droppedBySize).toBe(1);
  });
});
