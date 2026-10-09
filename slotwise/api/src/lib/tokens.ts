import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored hashed so a database leak does not leak live links. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function sign(data: string): string {
  return createHmac('sha256', config.appSecret).update(data).digest('base64url');
}

/**
 * Signed, expiring link token for a client's appointment (cancel/reschedule
 * without an account). Format: <appointmentId>.<expiresEpochSec>.<signature>
 */
export function signManageToken(appointmentId: string, expiresAt: Date): string {
  const payload = `${appointmentId}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${payload}.${sign(`manage:${payload}`)}`;
}

export function verifyManageToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts as [string, string, string];
  const expected = Buffer.from(sign(`manage:${id}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return id;
}

/** Links stay usable for a week after the appointment so the page still loads. */
export function manageTokenFor(appointmentId: string, startsAt: Date): string {
  return signManageToken(appointmentId, new Date(startsAt.getTime() + 7 * 86_400_000));
}

export function manageUrl(appointmentId: string, startsAt: Date): string {
  return `${config.appUrl}/m/${manageTokenFor(appointmentId, startsAt)}`;
}
