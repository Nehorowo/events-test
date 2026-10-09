import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { pushToUser } from '../lib/push.js';
import { parse, requireUser } from '../http.js';

const zSubscription = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

export async function pushRoutes(app: FastifyInstance) {
  app.post('/api/push/subscribe', async (req) => {
    const user = requireUser(req);
    const sub = parse(zSubscription, req.body);
    await pool.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
    );
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const user = requireUser(req);
    const { endpoint } = parse(z.object({ endpoint: z.string() }), req.body);
    await pool.query('delete from push_subscriptions where user_id = $1 and endpoint = $2', [user.id, endpoint]);
    return { ok: true };
  });

  app.post('/api/push/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const delivered = await pushToUser(user.id, {
      title: 'Slotwise',
      body: 'Push notifications are working.',
      url: '/app',
      tag: 'test',
    });
    return { delivered };
  });
}
