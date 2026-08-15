import type { Earning } from '@earnings/shared';

const STATE_LABEL: Record<Earning['state'], string> = {
  scheduled: 'Scheduled',
  starting_soon: 'Starting soon',
  live: 'Live',
  ended: 'Ended',
  completed: 'Recording',
};

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const duration = (sec: number | null): string => {
  if (sec === null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
};

export function EventCard({ event, justUpdated }: { event: Earning; justUpdated: boolean }) {
  const failed = event.failureReason !== null;
  const state = failed ? 'failed' : event.state;

  return (
    <article className={`card card--${state}${justUpdated ? ' card--pulse' : ''}`}>
      <header className="card__head">
        <div className="card__symbol">
          <span className="ticker">{event.symbol}</span>
          <span className="fiscal">
            {event.fiscalPeriod} {event.fiscalYear}
          </span>
        </div>
        <span className={`badge badge--${state}`}>
          {failed ? 'Failed' : STATE_LABEL[event.state]}
          {event.state === 'live' && !failed ? <i className="pulse-dot" /> : null}
        </span>
      </header>

      <h3 className="card__title">{event.title}</h3>

      <dl className="card__meta">
        <div>
          <dt>Call time</dt>
          <dd>{time(event.date)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{time(event.updatedAt)}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>#{event.typeId}</dd>
        </div>
      </dl>

      {failed ? (
        <p className="card__failure">Live failed — {event.failureReason}</p>
      ) : event.liveAudio ? (
        <div className="card__audio">
          <span className={`audio-icon${event.liveAudio.isReplay ? ' audio-icon--replay' : ''}`}>
            {event.liveAudio.isReplay ? '▸' : '◉'}
          </span>
          <div className="card__audio-body">
            <a href={event.liveAudio.url} onClick={(e) => e.preventDefault()}>
              {event.liveAudio.title}
            </a>
            <span className="card__audio-meta">
              {event.liveAudio.startedAt ? `started ${time(event.liveAudio.startedAt)}` : 'standby'}
              {event.liveAudio.durationSec !== null
                ? ` · ${duration(event.liveAudio.durationSec)}`
                : ''}
            </span>
          </div>
        </div>
      ) : (
        <p className="card__audio card__audio--empty">No audio yet</p>
      )}

      <footer className="card__foot">
        <code>{event.id}</code>
      </footer>
    </article>
  );
}
