import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveSymbols } from './config.js';
import { useEarningsFeed } from './feed/useEarningsFeed.js';
import { ActivityLog } from './components/ActivityLog.js';
import { EventCard } from './components/EventCard.js';
import { StatusPanel } from './components/StatusPanel.js';

/** Flags cards whose `updatedAt` changed in the last two seconds. */
function useRecentlyUpdated(events: { id: string; updatedAt: string }[]): Set<string> {
  const previous = useRef(new Map<string, string>());
  const [recent, setRecent] = useState<Set<string>>(new Set());

  useEffect(() => {
    const changed = new Set<string>();
    for (const event of events) {
      const before = previous.current.get(event.id);
      if (before && before !== event.updatedAt) changed.add(event.id);
      previous.current.set(event.id, event.updatedAt);
    }
    if (changed.size === 0) return;

    setRecent((current) => new Set([...current, ...changed]));
    const timer = setTimeout(() => {
      setRecent((current) => {
        const next = new Set(current);
        for (const id of changed) next.delete(id);
        return next;
      });
    }, 2_000);
    return () => clearTimeout(timer);
  }, [events]);

  return recent;
}

export default function App() {
  const symbols = useMemo(() => resolveSymbols(), []);
  const feed = useEarningsFeed(symbols);
  const recentlyUpdated = useRecentlyUpdated(feed.events);

  const live = feed.events.filter((e) => e.state === 'live' && e.failureReason === null).length;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Earnings calendar</h1>
          <p className="subtitle">
            {symbols.length} symbols · {feed.events.length} events
            {live > 0 ? ` · ${live} live now` : ''}
          </p>
        </div>
        <div className="page__phase">
          <span className={`phase phase--${feed.phase}`}>
            {feed.phase === 'buffering' ? 'buffering deltas…' : 'live'}
          </span>
        </div>
      </header>

      <StatusPanel
        state={feed}
        diagnostics={feed.diagnostics}
        loading={feed.loading}
        snapshotError={feed.snapshotError}
        onRefetch={feed.refetchSnapshot}
      />

      <main className="layout">
        <section className="grid">
          {feed.events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              justUpdated={recentlyUpdated.has(event.id)}
            />
          ))}
          {feed.events.length === 0 ? (
            <p className="empty">
              {feed.phase === 'buffering'
                ? 'Subscribed to /live_events — waiting for the snapshot.'
                : 'No events for this watchlist.'}
            </p>
          ) : null}
        </section>

        <ActivityLog entries={feed.log} />
      </main>
    </div>
  );
}
