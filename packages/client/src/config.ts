/**
 * Both endpoints go through the Vite dev proxy by default (see vite.config.ts),
 * so the browser talks to a single origin. Point `VITE_SSE_URL` at nchan
 * (`http://localhost:8080/live_events`) to subscribe to a real nchan channel
 * instead of the Node broker — nothing else in the client changes.
 */

const env = import.meta.env;

export const SNAPSHOT_URL: string = env.VITE_SNAPSHOT_URL ?? '/events';
export const SSE_URL: string = env.VITE_SSE_URL ?? '/live_events';
export const DEBUG_STATE_URL: string = env.VITE_DEBUG_STATE_URL ?? '/debug/state';

/** The watchlist this page renders. Overridable with `?symbols=AAPL,MSFT`. */
export const DEFAULT_SYMBOLS = [
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'TSLA',
  'NFLX',
  'AMD',
  'CRM',
] as const;

export function resolveSymbols(search: string = globalThis.location?.search ?? ''): string[] {
  const raw = new URLSearchParams(search).get('symbols');
  if (!raw) return [...DEFAULT_SYMBOLS];
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_SYMBOLS];
}

/** Client-side buffer retention. Must exceed the snapshot lag plus its round trip. */
export const BUFFER_RETENTION_MS = 15 * 60_000;

/** How long finished events stay on screen, matching the server's window. */
export const EVENT_RETENTION_MS = 12 * 60_000;
