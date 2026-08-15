/**
 * React binding. Everything interesting happens in `LiveEventsClient` and
 * `EarningsEventsProvider`; this hook only wires them to the component tree and
 * owns the snapshot request.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LiveEventsHttpApi } from '../api/liveEventsHttpApi.js';
import { BUFFER_RETENTION_MS, EVENT_RETENTION_MS, SSE_URL } from '../config.js';
import {
  getLiveEventsClient,
  type ClientDiagnostics,
} from '../lib/liveEvents/LiveEventsClient.js';
import { EarningsEventsProvider } from '../provider/EarningsEventsProvider.js';

const httpApi = new LiveEventsHttpApi();

export function useEarningsFeed(symbols: readonly string[]) {
  const symbolsKey = useMemo(() => [...symbols].sort().join(','), [symbols]);
  const abortRef = useRef<AbortController | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [diagnostics, setDiagnostics] = useState<ClientDiagnostics | null>(null);

  // The singleton: one SSE connection per browser, shared by every tab.
  const client = useMemo(
    () => getLiveEventsClient({ url: SSE_URL, bufferRetentionMs: BUFFER_RETENTION_MS }),
    [],
  );

  const provider = useMemo(
    () =>
      new EarningsEventsProvider({
        client,
        symbols: symbolsKey.split(','),
        bufferRetentionMs: BUFFER_RETENTION_MS,
        eventRetentionMs: EVENT_RETENTION_MS,
      }),
    [client, symbolsKey],
  );

  const loadSnapshot = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      const snapshot = await httpApi.fetchSnapshot({
        symbols: symbolsKey.split(','),
        signal: controller.signal,
      });
      // Fold everything buffered while this request was in flight.
      provider.actualizeSnapshot(snapshot);
      setSnapshotError(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSnapshotError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [provider, symbolsKey]);

  useEffect(() => {
    // Subscribe first, fetch second: deltas produced while the snapshot request
    // is in flight land in the buffer instead of being lost.
    provider.start();
    const offRefetch = provider.onRefetchNeeded(() => void loadSnapshot());
    void loadSnapshot();

    // `ILiveEventsClient.connected` is a plain property, so the UI polls it
    // rather than the client having to push status frames at every consumer.
    const poll = setInterval(() => {
      provider.syncConnection();
      setDiagnostics(client.diagnostics);
    }, 1_000);

    return () => {
      clearInterval(poll);
      offRefetch();
      provider.stop();
      abortRef.current?.abort();
    };
  }, [client, provider, loadSnapshot]);

  const state = useSyncExternalStore(
    useCallback((listener) => provider.onChange(listener), [provider]),
    provider.getState,
    provider.getState,
  );

  return {
    ...state,
    loading,
    snapshotError,
    diagnostics,
    refetchSnapshot: () => void loadSnapshot(),
  };
}
