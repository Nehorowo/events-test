import type { LogEntry } from '../provider/EarningsEventsProvider.js';

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ActivityLog({ entries }: { entries: readonly LogEntry[] }) {
  return (
    <aside className="log">
      <h2 className="log__title">Reconciliation log</h2>
      <p className="log__hint">
        Every message and what the merge decided about it — the “stale” lines are deltas the
        snapshot already contained.
      </p>
      <ol className="log__list">
        {entries.map((entry) => (
          <li key={entry.id} className={`log__item log__item--${entry.outcome ?? entry.kind}`}>
            <span className="log__time">{time(entry.at)}</span>
            <span className="log__message">{entry.message}</span>
          </li>
        ))}
        {entries.length === 0 ? <li className="log__item log__item--empty">Waiting…</li> : null}
      </ol>
    </aside>
  );
}
