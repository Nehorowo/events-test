import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { one, pool } from './db.js';
import { badRequest, forbidden, HttpError } from './lib/errors.js';
import { hashToken } from './lib/tokens.js';

export const SESSION_COOKIE = 'sw_session';
export const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  locale: string;
}

export type Role = 'owner' | 'admin' | 'staff';

export interface Membership {
  tenantId: string;
  role: Role;
  staffId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, 'invalid_input', issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid input', result.error.issues);
  }
  return result.data;
}

export async function loadSessionUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = await one<SessionUser>(
    pool,
    `select u.id, u.email, u.name, u.locale
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );
  return row ?? null;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'unauthenticated');
  return req.user;
}

export async function requireMember(req: FastifyRequest, tenantId: string, roles?: Role[]): Promise<Membership> {
  const user = requireUser(req);
  if (!z.string().uuid().safeParse(tenantId).success) throw badRequest('invalid_tenant');
  const m = await one<{ role: Role; staff_id: string | null }>(
    pool,
    'select role, staff_id from memberships where tenant_id = $1 and user_id = $2',
    [tenantId, user.id],
  );
  if (!m) throw forbidden('not_a_member');
  if (roles && !roles.includes(m.role)) throw forbidden('insufficient_role');
  return { tenantId, role: m.role, staffId: m.staff_id };
}

export const MANAGERS: Role[] = ['owner', 'admin'];

export function isManager(m: Membership): boolean {
  return m.role === 'owner' || m.role === 'admin';
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https://'),
    maxAge: SESSION_DAYS * 86_400,
  });
}

/** Accepts only same-site relative paths, so redirects cannot be abused. */
export function safeRedirect(path: unknown, fallback = '/app'): string {
  return typeof path === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(path) ? path : fallback;
}

// Shared input schemas
export const zUuid = z.string().uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
export const zEmail = z.string().trim().toLowerCase().email().max(254);
export const zPhone = z.string().trim().max(40).regex(/^[+\d()\-\s.]*$/, 'invalid phone');
