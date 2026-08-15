/**
 * The SSE `id:` field is nchan's global monotonic message counter for the
 * channel — an autoincrementing integer. The browser client never interprets
 * it: it stores the last one it saw and echoes it back on reconnect. Only the
 * broker compares ids, to work out which buffered messages a resuming
 * subscriber still needs.
 *
 * `parseMessageId` also accepts nchan's native `<time>:<tag>` form, so a
 * deployment fronted by a real nginx+nchan keeps working: the ordering it
 * derives is the same, and unparseable ids are treated as "unknown cursor",
 * which makes the broker fall back to a full replay plus a `gap` notice.
 */

export function parseMessageId(id: string | number | null | undefined): number | null {
  if (id === null || id === undefined) return null;
  if (typeof id === 'number') return Number.isFinite(id) ? id : null;

  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // nchan's `<unix-seconds>:<tag>`.
  const native = /^(\d+):(\d+)$/.exec(trimmed);
  if (native) return Number(native[1]) * 1_000 + Math.min(Number(native[2]), 999);

  return null;
}

export function formatMessageId(id: number): string {
  return String(id);
}

/** `-1 | 0 | 1`. Returns `0` when either id is not parseable. */
export function compareMessageIds(a: string | number, b: string | number): number {
  const pa = parseMessageId(a);
  const pb = parseMessageId(b);
  if (pa === null || pb === null) return 0;
  return pa === pb ? 0 : pa < pb ? -1 : 1;
}
