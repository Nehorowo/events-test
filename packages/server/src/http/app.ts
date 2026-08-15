import cors from 'cors';
import express from 'express';
import { SSE_EVENT_NAMES, type StreamGap, type StreamHello } from '@earnings/shared';
import { CHANNEL_NAME, config } from '../config.js';
import type { ChannelBroker } from '../broker/channelBroker.js';
import type { EventsService } from '../domain/eventsService.js';
import { ALL_SYMBOLS } from '../domain/catalog.js';
import { openSseStream } from './sse.js';

const parseSymbols = (raw: unknown): string[] => {
  const list = (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split(','))
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const known = new Set(ALL_SYMBOLS);
  const filtered = [...new Set(list)].filter((s) => known.has(s));
  return filtered.length > 0 ? filtered : [...ALL_SYMBOLS];
};

export function createApp(deps: { broker: ChannelBroker; events: EventsService }) {
  const { broker, events } = deps;
  const app = express();

  app.use(cors({ origin: true, credentials: true }));
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      channel: broker.channel,
      subscribers: broker.subscriberCount,
      buffered: broker.bufferedCount,
      oldestId: broker.oldestId,
      newestId: broker.newestId,
      snapshotLagMs: config.snapshotLagMs,
      replayWindowMs: config.replayWindowMs,
      ...events.stats,
    });
  });

  /**
   * The snapshot endpoint. Deliberately stale by `SNAPSHOT_LAG_MS` — which is
   * exactly what the client's SSE buffer has to make up for.
   */
  app.get('/events', (req, res) => {
    const symbols = parseSymbols(req.query.symbols);
    // A stale body is the contract; a *cached* stale body is not.
    res.setHeader('Cache-Control', 'no-store');
    res.json(events.getSnapshot(symbols));
  });

  /** Server-side truth, for verifying that the client's merge matches. */
  app.get('/debug/state', (req, res) => {
    const symbols = parseSymbols(req.query.symbols);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ serverTime: new Date().toISOString(), events: events.getLiveState(symbols) });
  });

  /**
   * The `/live_events` channel. Contract is nchan's:
   *
   *  - replay the retained buffer, then stream live;
   *  - `id:` on every message (the channel's monotonic counter);
   *  - `event:` carries the message type, which is also duplicated in the body;
   *  - resume via `Last-Event-ID` (header) or `?last_event_id=` (browsers);
   *  - no server-side filtering — subscribers filter by `symbol`/`companyId`.
   */
  app.get('/live_events', (req, res) => {
    const headerId = req.header('Last-Event-ID') ?? req.header('Last-Event-Id');
    const queryId = typeof req.query.last_event_id === 'string' ? req.query.last_event_id : null;
    const lastEventId = headerId ?? queryId ?? null;
    const replay = req.query.replay !== 'none';

    const stream = openSseStream(res);
    stream.retry(2_000);

    const { events: replayed, gap } = broker.replay({ lastEventId, replay });

    const hello: StreamHello = {
      channel: broker.channel,
      serverTime: new Date().toISOString(),
      bufferWindowMs: broker.windowMs,
      replayed: replayed.length,
      lastEventId,
      oldestId: broker.oldestId,
      newestId: broker.newestId,
    };
    stream.send(SSE_EVENT_NAMES.hello, hello);

    if (gap) {
      const payload: StreamGap = {
        requestedLastEventId: lastEventId,
        oldestAvailableId: gap.oldestAvailableId,
        reason: gap.reason,
      };
      stream.send(SSE_EVENT_NAMES.gap, payload);
    }

    // `event:` is the message type; the body repeats it for consumers that only
    // parse `data:`.
    for (const event of replayed) {
      stream.send(event.type, event, String(event.id));
    }

    const unsubscribe = broker.subscribe((event) =>
      stream.send(event.type, event, String(event.id)),
    );

    const heartbeat = setInterval(
      () => stream.comment(`keep-alive ${Date.now()}`),
      config.heartbeatMs,
    );
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      stream.close();
    });
  });

  app.get('/meta', (_req, res) => {
    res.json({ symbols: events.symbols, channel: CHANNEL_NAME });
  });

  return app;
}
