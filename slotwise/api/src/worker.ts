import { config } from './config.js';
import { migrate, pool } from './db.js';
import { housekeeping, processOutbox, queueReminders } from './outbox.js';

// Background worker: queues reminders and drains the notification outbox.
// Wakes on LISTEN/NOTIFY for instant delivery, and on a timer as a fallback.

if (config.runMigrations) await migrate();

let running = false;
let again = false;
let lastHousekeeping = 0;

async function tick() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      const reminders = await queueReminders();
      if (reminders) console.log(`[worker] queued ${reminders} reminder(s)`);
      let result;
      do {
        result = await processOutbox();
        if (result.sent || result.failed) console.log(`[worker] sent=${result.sent} failed=${result.failed}`);
      } while (result.sent + result.failed > 0);
      if (Date.now() - lastHousekeeping > 3_600_000) {
        await housekeeping();
        lastHousekeeping = Date.now();
      }
    } while (again);
  } catch (err) {
    console.error('[worker] tick failed', err);
  } finally {
    running = false;
  }
}

const listener = await pool.connect();
await listener.query('listen slotwise_outbox');
listener.on('notification', () => void tick());

const timer = setInterval(() => void tick(), config.worker.pollMs);
console.log(`[worker] started, polling every ${config.worker.pollMs} ms`);
void tick();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    listener.release();
    await pool.end();
    process.exit(0);
  });
}
