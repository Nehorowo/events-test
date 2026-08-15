import { ChannelBroker } from './broker/channelBroker.js';
import { createNchanPublisher } from './broker/nchanPublisher.js';
import { CHANNEL_NAME, config } from './config.js';
import { EventsService } from './domain/eventsService.js';
import { createApp } from './http/app.js';

const broker = new ChannelBroker({
  channel: CHANNEL_NAME,
  windowMs: config.replayWindowMs,
  maxMessages: config.replayMaxMessages,
});

const publishToNchan = config.nchanPublishUrl
  ? createNchanPublisher(config.nchanPublishUrl)
  : null;

const events = new EventsService({
  broker,
  snapshotLagMs: config.snapshotLagMs,
  cycleMs: config.cycleMs,
  historyMs: config.historyMs,
  tickMs: config.tickMs,
  retentionMs: config.retentionMs,
  onPublish: publishToNchan ? (event) => void publishToNchan(event) : undefined,
});

events.start();

const app = createApp({ broker, events });
const server = app.listen(config.port, () => {
  const stats = events.stats;
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(
    `[server] snapshot lag ${config.snapshotLagMs / 60_000}min · replay window ${
      config.replayWindowMs / 60_000
    }min · sim cycle ${config.cycleMs / 1000}s`,
  );
  console.log(
    `[server] backfilled ${stats.publishedCount} messages since ${stats.genesis} · ${broker.bufferedCount} retained in /${CHANNEL_NAME}`,
  );
  if (config.nchanPublishUrl) {
    console.log(`[server] mirroring messages to nchan at ${config.nchanPublishUrl}`);
  }
});

const shutdown = (signal: string) => {
  console.log(`[server] ${signal} received, shutting down`);
  events.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
