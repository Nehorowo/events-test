/**
 * `ILiveEventsHttpApi` — deliberately thin: one call, no caching, no state, no
 * knowledge of the buffer. Reconciliation lives in the provider; this is just
 * transport.
 */

import type { EarningsEventsSnapshot, ILiveEventsHttpApi, SnapshotQuery } from '@earnings/shared';
import { SNAPSHOT_URL } from '../config.js';

export interface HttpApiOptions {
  baseUrl?: string;
  /** Retries apply to network/5xx only; an aborted request is never retried. */
  retries?: number;
  fetchImpl?: typeof fetch;
}

export class LiveEventsHttpApi implements ILiveEventsHttpApi {
  private readonly baseUrl: string;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? SNAPSHOT_URL;
    this.retries = options.retries ?? 2;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async fetchSnapshot(query: SnapshotQuery = {}): Promise<EarningsEventsSnapshot> {
    const url = new URL(this.baseUrl, globalThis.location?.origin ?? 'http://localhost');
    if (query.symbols?.length) url.searchParams.set('symbols', query.symbols.join(','));

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url.pathname + url.search, {
          signal: query.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as EarningsEventsSnapshot;
      } catch (error) {
        if (query.signal?.aborted) throw error;
        lastError = error;
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
