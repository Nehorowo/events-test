import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './lib/errors.js';
import { loadSessionUser } from './http.js';
import { appointmentRoutes } from './routes/appointments.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes } from './routes/billing.js';
import { publicRoutes } from './routes/public.js';
import { pushRoutes } from './routes/push.js';
import { tenantRoutes } from './routes/tenant.js';
import { spaRoutes } from './spa.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? (config.production ? true : { level: 'info' }),
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cookie, { secret: config.appSecret });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/')) req.user = await loadSessionUser(req);
  });

  // Basic hardening headers for every response.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'SAMEORIGIN');
    return payload;
  });

  // CSRF defence for cookie-authenticated writes: browsers always send Origin
  // on cross-site POSTs, so a mismatching Origin is rejected.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.url.startsWith('/api/stripe/')) return;
    const origin = req.headers.origin;
    if (origin && origin !== config.appUrl && config.production) {
      return reply.status(403).send({ error: 'bad_origin' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as { code?: string }).code ?? 'bad_request', message: (err as Error).message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  app.get('/api/health', { logLevel: 'warn' }, async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  await app.register(authRoutes);
  await app.register(tenantRoutes);
  await app.register(appointmentRoutes);
  await app.register(publicRoutes);
  await app.register(billingRoutes);
  await app.register(pushRoutes);
  // Root context on purpose: the SPA owns the app-wide not-found handler.
  await spaRoutes(app);
  return app;
}
