import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { billingMode, config } from '../config.js';
import { many, one, pool, tx, type Db } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { asLocale, t } from '../lib/i18n.js';
import { queueRawEmail } from '../lib/notify.js';
import { effectivePlan } from '../lib/plans.js';
import { emailLayout } from '../lib/templates.js';
import { hashToken, randomToken } from '../lib/tokens.js';
import { getVapidPublicKey } from '../lib/push.js';
import {
  parse,
  requireUser,
  safeRedirect,
  SESSION_COOKIE,
  SESSION_DAYS,
  setSessionCookie,
  zEmail,
} from '../http.js';

const LOGIN_TOKEN_MINUTES = 20;

async function findOrCreateUser(db: Db, email: string, extra: { name?: string; googleSub?: string; locale?: string } = {}) {
  const row = await one<{ id: string }>(
    db,
    `insert into users (email, name, google_sub, locale) values ($1, $2, $3, $4)
     on conflict (email) do update
       set name = coalesce(users.name, excluded.name),
           google_sub = coalesce(users.google_sub, excluded.google_sub)
     returning id`,
    [email, extra.name ?? null, extra.googleSub ?? null, extra.locale ?? 'en'],
  );
  return row!.id;
}

async function startSession(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS],
  );
  // Opportunistic cleanup of this user's expired sessions.
  await db.query('delete from sessions where user_id = $1 and expires_at < now()', [userId]);
  return token;
}

/** Where to send someone after sign-in: wizard, dashboard or a pending invite. */
async function landingFor(userId: string, wanted: string | null): Promise<string> {
  if (wanted && wanted !== '/app') return wanted;
  const m = await one(pool, 'select 1 from memberships where user_id = $1 limit 1', [userId]);
  return m ? '/app' : '/onboarding';
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/magic-link', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const body = parse(
      z.object({ email: zEmail, redirect: z.string().optional(), locale: z.string().optional() }),
      req.body,
    );
    const token = randomToken();
    const redirect = safeRedirect(body.redirect);
    await tx(async (db) => {
      await db.query(
        `insert into login_tokens (token_hash, email, redirect, expires_at)
         values ($1, $2, $3, now() + make_interval(mins => $4))`,
        [hashToken(token), body.email, redirect, LOGIN_TOKEN_MINUTES],
      );
      const s = t(asLocale(body.locale));
      const url = `${config.appUrl}/api/auth/verify?token=${token}`;
      const msg = emailLayout({
        heading: s.loginSubject,
        intro: s.loginIntro,
        button: { label: s.loginButton, url },
        footer: s.loginIgnore,
      });
      await queueRawEmail(db, null, 'login_link', body.email, { subject: s.loginSubject, ...msg });
      if (!config.production) app.log.info({ email: body.email, url }, 'dev sign-in link');
    });
    return { ok: true };
  });

  app.get('/api/auth/verify', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(10) }), req.query);
    const result = await tx(async (db) => {
      const row = await one<{ email: string; redirect: string | null }>(
        db,
        `update login_tokens set used_at = now()
          where token_hash = $1 and used_at is null and expires_at > now()
          returning email, redirect`,
        [hashToken(token)],
      );
      if (!row) return null;
      const userId = await findOrCreateUser(db, row.email);
      return { userId, session: await startSession(db, userId), redirect: row.redirect };
    });
    if (!result) return reply.redirect('/login?error=link_expired');
    setSessionCookie(reply, result.session);
    return reply.redirect(await landingFor(result.userId, result.redirect));
  });

  // ── Google sign-in (OAuth 2.0 authorization code flow) ──────────────────────
  app.get('/api/auth/google', async (req, reply) => {
    if (!config.google.clientId) throw notFound('google_not_configured');
    const state = randomToken(16);
    const redirect = safeRedirect((req.query as { redirect?: string }).redirect);
    reply.setCookie('sw_oauth', `${state}|${redirect}`, {
      path: '/api/auth/google', httpOnly: true, sameSite: 'lax', maxAge: 600,
      secure: config.appUrl.startsWith('https://'),
    });
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: `${config.appUrl}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    const [state, redirect] = (req.cookies.sw_oauth ?? '').split('|');
    reply.clearCookie('sw_oauth', { path: '/api/auth/google' });
    if (!q.code || !state || q.state !== state) return reply.redirect('/login?error=google_failed');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: q.code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: `${config.appUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return reply.redirect('/login?error=google_failed');
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    // The ID token came straight from Google over TLS in exchange for our
    // client secret, so its claims can be read without re-verifying the JWS.
    const claims = id_token
      ? (JSON.parse(Buffer.from(id_token.split('.')[1] ?? '', 'base64url').toString()) as {
          sub: string; email?: string; email_verified?: boolean; name?: string; aud?: string;
        })
      : null;
    if (!claims?.email || !claims.email_verified || claims.aud !== config.google.clientId) {
      return reply.redirect('/login?error=google_failed');
    }
    const result = await tx(async (db) => {
      const userId = await findOrCreateUser(db, claims.email!.toLowerCase(), { name: claims.name, googleSub: claims.sub });
      return { userId, session: await startSession(db, userId) };
    });
    setSessionCookie(reply, result.session);
    return reply.redirect(await landingFor(result.userId, safeRedirect(redirect)));
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await pool.query('delete from sessions where token_hash = $1', [hashToken(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const configInfo = {
      googleEnabled: Boolean(config.google.clientId),
      billingMode,
      vapidPublicKey: await getVapidPublicKey(),
    };
    if (!req.user) return { user: null, memberships: [], config: configInfo };
    const memberships = await many(
      pool,
      `select t.id as "tenantId", t.slug, t.name, t.timezone, t.onboarding_done as "onboardingDone",
              m.role, m.staff_id as "staffId", s.plan, s.status
         from memberships m
         join tenants t on t.id = m.tenant_id
         left join subscriptions s on s.tenant_id = t.id
        where m.user_id = $1
        order by m.created_at`,
      [req.user.id],
    );
    return {
      user: req.user,
      memberships: memberships.map(({ plan, status, ...m }) => ({ ...m, plan: effectivePlan({ plan, status }) })),
      config: configInfo,
    };
  });

  app.patch('/api/me', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ name: z.string().trim().max(80).optional(), locale: z.enum(['en', 'el']).optional() }), req.body);
    await pool.query(
      'update users set name = coalesce($2, name), locale = coalesce($3, locale) where id = $1',
      [user.id, body.name ?? null, body.locale ?? null],
    );
    return { ok: true };
  });

  // ── Staff invitations ───────────────────────────────────────────────────────
  app.get('/api/invites/:token', async (req) => {
    const { token } = req.params as { token: string };
    const inv = await one(
      pool,
      `select i.email, i.role, t.name as "tenantName", i.accepted_at as "acceptedAt",
              i.expires_at < now() as expired
         from invitations i join tenants t on t.id = i.tenant_id
        where i.token_hash = $1`,
      [hashToken(token)],
    );
    if (!inv) throw notFound('invite_not_found');
    return inv;
  });

  app.post('/api/invites/:token/accept', async (req) => {
    const user = requireUser(req);
    const { token } = req.params as { token: string };
    return tx(async (db) => {
      const inv = await one<{ id: string; tenant_id: string; email: string; role: string; staff_id: string | null }>(
        db,
        `select * from invitations
          where token_hash = $1 and accepted_at is null and expires_at > now() for update`,
        [hashToken(token)],
      );
      if (!inv) throw badRequest('invite_invalid');
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw forbidden('invite_email_mismatch');
      await db.query(
        `insert into memberships (tenant_id, user_id, role, staff_id) values ($1, $2, $3, $4)
         on conflict (tenant_id, user_id) do update set role = excluded.role, staff_id = excluded.staff_id
         where memberships.role <> 'owner'`,
        [inv.tenant_id, user.id, inv.role, inv.staff_id],
      );
      await db.query('update invitations set accepted_at = now() where id = $1', [inv.id]);
      return { tenantId: inv.tenant_id };
    });
  });

  // Account deletion (GDPR): removes the user and any business they solely own.
  app.delete('/api/me', async (req, reply) => {
    const user = requireUser(req);
    await tx(async (db) => {
      await db.query(
        `delete from tenants t
          where exists (select 1 from memberships m where m.tenant_id = t.id and m.user_id = $1 and m.role = 'owner')
            and not exists (select 1 from memberships m where m.tenant_id = t.id and m.user_id <> $1 and m.role = 'owner')`,
        [user.id],
      );
      await db.query('delete from users where id = $1', [user.id]);
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
