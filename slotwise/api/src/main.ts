import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';

if (config.runMigrations) await migrate();
const app = await buildApp();
await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
