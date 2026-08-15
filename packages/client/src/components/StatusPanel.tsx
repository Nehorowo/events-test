import type { ClientDiagnostics } from '../lib/liveEvents/LiveEventsClient.js';
import type { ProviderState } from '../provider/EarningsEventsProvider.js';

const ms = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${Math.round(value)} ms`;

const secondsAgo = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const delta = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return `${delta}s ago`;
};

export interface StatusPanelProps {
  state: ProviderState;
  diagnostics: ClientDiagnostics | null;
  loading: boolean;
  snapshotError: string | null;
  onRefetch: () => void;
}

export function StatusPanel({
  state,
  diagnostics,
  loading,
  snapshotError,
  onRefetch,
}: StatusPanelProps) {
  const { snapshot, coverage, counters, buffer, latency, connection } = state;
  const connected = connection.connected;

  return (
    <section className="panel">
      <div className="panel__row">
        <span className={`dot ${connected ? 'dot--ok' : 'dot--bad'}`} />
        <strong>/live_events</strong>
        <span className="muted">
          {connected ? 'streaming' : 'disconnected'}
          {diagnostics ? ` · this tab is ${diagnostics.role}` : ''}
        </span>
        <button className="ghost" onClick={onRefetch} disabled={loading}>
          {loading ? 'fetching…' : 'refetch snapshot'}
        </button>
      </div>

      <div className="stats">
        <Stat
          label="Snapshot"
          value={snapshot ? `${Math.round(snapshot.ageMs / 1000)}s stale` : '—'}
          hint={snapshot ? `built ${secondsAgo(snapshot.snapshotAt)}` : 'loading'}
        />
        <Stat
          label="Actualized"
          value={snapshot?.actualizedAt ? secondsAgo(snapshot.actualizedAt) : '—'}
          hint={`from ${snapshot?.actualizedFrom ?? 0} buffered`}
        />
        <Stat label="Buffer" value={`${buffer.size}`} hint={`oldest ${secondsAgo(buffer.oldestAt)}`} />
        <Stat
          label="Coverage"
          value={coverage ? (coverage.covered ? 'contiguous' : `hole ${Math.round(coverage.holeMs / 1000)}s`) : '—'}
          hint={coverage?.covered ? 'buffer overlaps snapshot' : 'refetch required'}
          bad={coverage ? !coverage.covered : false}
        />
        <Stat
          label="E2E latency"
          value={ms(latency.lastMs)}
          hint={`p50 ${ms(latency.p50Ms)} · ${latency.replayedCount} replayed`}
        />
        <Stat
          label="Messages"
          value={`${counters.received}`}
          hint={`${counters.applied} applied · ${counters.stale} stale · ${counters.duplicate} dup`}
        />
      </div>

      {snapshotError ? <p className="alert">Snapshot request failed: {snapshotError}</p> : null}
      {connection.last?.gap ? (
        <p className="alert">
          Replay gap after {Math.round(connection.last.downtimeMs / 1000)}s offline — snapshot
          refetched.
        </p>
      ) : null}
      {diagnostics && !diagnostics.crossTabSupported ? (
        <p className="hint">
          BroadcastChannel unavailable — this tab keeps its own connection.
        </p>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  bad,
}: {
  label: string;
  value: string;
  hint?: string;
  bad?: boolean;
}) {
  return (
    <div className={`stat${bad ? ' stat--bad' : ''}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </div>
  );
}
