/**
 * Optional bridge to a real nginx+nchan deployment.
 *
 * With `NCHAN_PUBLISH_URL` set, every delta is also POSTed to nchan's publisher
 * endpoint, so the browser can subscribe to nchan directly
 * (`VITE_SSE_URL=http://localhost:8080/sub/events`) instead of to this process.
 * The wire format is identical — see `deploy/nchan.conf`.
 */

import type { LiveEventsMessage } from '@earnings/shared';

export function createNchanPublisher(publishUrl: string) {
  let failures = 0;

  return async function publishToNchan(event: LiveEventsMessage): Promise<void> {
    try {
      const response = await fetch(publishUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // nchan turns this into the SSE `event:` field; the message type is
          // also duplicated in the body for consumers that only parse `data:`.
          'X-EventSource-Event': event.type,
        },
        body: JSON.stringify(event),
      });
      if (!response.ok) throw new Error(`nchan responded ${response.status}`);
      failures = 0;
    } catch (error) {
      failures += 1;
      // Loud once, then quiet: the in-process broker keeps the demo working.
      if (failures <= 3) {
        console.warn(`[nchan] publish failed (${failures}): ${(error as Error).message}`);
      }
    }
  };
}
