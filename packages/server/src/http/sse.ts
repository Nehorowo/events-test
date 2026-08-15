import type { Response } from 'express';

export interface SseWriter {
  send(event: string, data: unknown, id?: string): void;
  comment(text: string): void;
  retry(ms: number): void;
  close(): void;
}

/**
 * Minimal SSE framing. `X-Accel-Buffering: no` matters when the stream is
 * proxied through nginx (including the nchan host) — without it the proxy
 * buffers the response and deltas arrive in bursts.
 */
export function openSseStream(res: Response): SseWriter {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;

  return {
    send(event, data, id) {
      if (closed) return;
      let frame = '';
      if (id) frame += `id: ${id}\n`;
      frame += `event: ${event}\n`;
      frame += `data: ${JSON.stringify(data)}\n\n`;
      res.write(frame);
    },
    comment(text) {
      if (closed) return;
      res.write(`: ${text}\n\n`);
    },
    retry(ms) {
      if (closed) return;
      res.write(`retry: ${ms}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      res.end();
    },
  };
}
