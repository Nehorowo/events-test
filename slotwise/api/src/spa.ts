import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { RESERVED_SLUGS } from '../../shared/plans.js';
import { config } from './config.js';
import { one, pool } from './db.js';
import { escapeHtml } from './lib/templates.js';

/**
 * Serves the built SPA. The HTML shell gets per-tenant <meta> tags for booking
 * links (/{slug}) so previews on Instagram and WhatsApp show the business name
 * and logo, which a static SPA cannot do on its own.
 */
export async function spaRoutes(app: FastifyInstance) {
  const dist = config.webDist;
  if (!dist || !existsSync(join(dist, 'index.html'))) {
    app.log.warn('WEB_DIST not set or not built; serving the API only');
    return;
  }
  const shell = readFileSync(join(dist, 'index.html'), 'utf8');

  await app.register(fastifyStatic, {
    root: dist,
    wildcard: false,
    index: false,
    setHeaders(res, path) {
      if (path.includes(`${'/'}assets${'/'}`)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      else if (path.endsWith('sw.js') || path.endsWith('.webmanifest')) res.setHeader('cache-control', 'no-cache');
    },
  });

  const analytics =
    config.analytics.umamiScriptUrl && config.analytics.umamiWebsiteId
      ? `<script defer src="${escapeHtml(config.analytics.umamiScriptUrl)}" data-website-id="${escapeHtml(config.analytics.umamiWebsiteId)}"></script>`
      : '';

  function render(meta: { title: string; description: string; image?: string; url: string }) {
    const tags = [
      `<title>${escapeHtml(meta.title)}</title>`,
      `<meta name="description" content="${escapeHtml(meta.description)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
      `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
      `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
      meta.image ? `<meta property="og:image" content="${escapeHtml(meta.image)}">` : '',
      `<meta name="twitter:card" content="summary">`,
      analytics,
    ].join('\n    ');
    return shell.replace(/<title>[^<]*<\/title>/, tags);
  }

  const defaultMeta = {
    title: 'Slotwise — your booking page in 10 minutes',
    description: 'Clients book 24/7, get reminded, and show up. Free to start, €9 when you grow.',
    image: `${config.appUrl}/icons/icon-512.png`,
  };

  app.get('/api/public/:slug/logo', async (req, reply) => {
    const row = await one<{ logo_data: string | null }>(pool, 'select logo_data from tenants where slug = $1', [
      (req.params as { slug: string }).slug.toLowerCase(),
    ]);
    const m = row?.logo_data?.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return reply.status(404).send();
    reply.header('content-type', m[1]!);
    reply.header('cache-control', 'public, max-age=600');
    return Buffer.from(m[2]!, 'base64');
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const path = req.url.split('?')[0]!;
    const slug = path.match(/^\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/?$/i)?.[1]?.toLowerCase();
    let html: string;
    if (slug && !RESERVED_SLUGS.includes(slug)) {
      const t = await one<{ name: string; address: string | null; has_logo: boolean }>(
        pool,
        'select name, address, logo_data is not null as has_logo from tenants where slug = $1',
        [slug],
      );
      html = t
        ? render({
            title: `${t.name} — book online`,
            description: t.address ? `Book an appointment at ${t.name}, ${t.address}.` : `Book an appointment at ${t.name}.`,
            image: t.has_logo ? `${config.appUrl}/api/public/${slug}/logo` : defaultMeta.image,
            url: `${config.appUrl}/${slug}`,
          })
        : render({ ...defaultMeta, url: config.appUrl });
    } else {
      html = render({ ...defaultMeta, url: `${config.appUrl}${path}` });
    }
    reply.header('cache-control', 'no-cache');
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
