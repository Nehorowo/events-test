import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { get } from '../lib/api';
import { addDays, formatDay, todayIn } from '../lib/dates';
import type { Slot } from '../lib/types';
import { cx, Spinner } from './ui';

const WINDOW = 14;

interface Props {
  slug: string;
  serviceId: string;
  staffId: string | null;
  timezone: string;
  maxDaysAhead: number;
  /** Manage token of an appointment being rescheduled (its own slot counts as free). */
  ignoreToken?: string;
  selected?: string | null;
  onPick: (slot: Slot, date: string) => void;
}

/** Date strip + time grid. Days are the business's local days. */
export default function SlotPicker({ slug, serviceId, staffId, timezone, maxDaysAhead, ignoreToken, selected, onPick }: Props) {
  const { t, i18n } = useTranslation();
  const today = todayIn(timezone);
  const [from, setFrom] = useState(today);
  const [date, setDate] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const qs = (extra: Record<string, string>) =>
    new URLSearchParams({ serviceId, ...(staffId ? { staffId } : {}), ...(ignoreToken ? { ignore: ignoreToken } : {}), ...extra }).toString();

  const days = useQuery({
    queryKey: ['availability', slug, serviceId, staffId, from, ignoreToken],
    queryFn: () => get<{ date: string; slots: number }[]>(`/public/${slug}/availability?${qs({ from, days: String(WINDOW) })}`),
  });

  // Pick the first day with free time whenever the window or filters change.
  useEffect(() => {
    if (!days.data) return;
    if (date && days.data.some((d) => d.date === date && d.slots > 0)) return;
    const first = days.data.find((d) => d.slots > 0);
    setDate(first?.date ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.data]);

  useEffect(() => setDate(null), [serviceId, staffId]);

  const slots = useQuery({
    queryKey: ['slots', slug, serviceId, staffId, date, ignoreToken],
    queryFn: () => get<Slot[]>(`/public/${slug}/slots?${qs({ date: date! })}`),
    enabled: Boolean(date),
  });

  const lastDay = addDays(today, maxDaysAhead);
  const canPrev = from > today;
  const canNext = addDays(from, WINDOW) <= lastDay;
  const noneInWindow = days.data && !days.data.some((d) => d.slots > 0);

  const groups = useMemo(() => {
    const g: Record<'morning' | 'afternoon' | 'evening', Slot[]> = { morning: [], afternoon: [], evening: [] };
    for (const s of slots.data ?? []) {
      const h = Number(s.time.slice(0, 2));
      g[h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'].push(s);
    }
    return g;
  }, [slots.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('calendar.prev')}
          disabled={!canPrev}
          onClick={() => setFrom(addDays(from, -WINDOW) < today ? today : addDays(from, -WINDOW))}
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-30"
        >
          ‹
        </button>
        <div ref={stripRef} className="no-scrollbar flex flex-1 gap-2 overflow-x-auto py-1" role="listbox" aria-label={t('appt.date')}>
          {days.isLoading && <div className="py-4"><Spinner small /></div>}
          {days.data?.map((d) => {
            const active = d.date === date;
            const disabled = d.slots === 0;
            return (
              <button
                key={d.date}
                type="button"
                role="option"
                aria-selected={active}
                disabled={disabled}
                onClick={() => setDate(d.date)}
                className={cx(
                  'accent-ring flex w-14 shrink-0 flex-col items-center rounded-xl border px-1 py-2 text-center transition',
                  active ? 'accent-bg border-transparent' : 'border-slate-200 bg-white',
                  disabled && 'opacity-35',
                )}
              >
                <span className="text-[11px] font-medium uppercase">{formatDay(d.date, i18n.language, { weekday: 'short' })}</span>
                <span className="text-lg font-bold leading-6">{Number(d.date.slice(8))}</span>
                <span className="text-[10px]">{formatDay(d.date, i18n.language, { month: 'short' })}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={t('calendar.next')}
          disabled={!canNext}
          onClick={() => setFrom(addDays(from, WINDOW))}
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-30"
        >
          ›
        </button>
      </div>

      {noneInWindow && (
        <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600">
          {t('booking.noSlots')}{' '}
          {canNext && (
            <button type="button" className="accent-text font-semibold underline" onClick={() => setFrom(addDays(from, WINDOW))}>
              {t('calendar.next')} ›
            </button>
          )}
        </p>
      )}

      {date && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-700">{formatDay(date, i18n.language)}</h3>
          {slots.isLoading && <Spinner small />}
          {slots.data?.length === 0 && <p className="text-sm text-slate-500">{t('booking.noSlots')}</p>}
          {(['morning', 'afternoon', 'evening'] as const).map((k) =>
            groups[k].length ? (
              <div key={k} className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                {groups[k].map((s) => (
                  <button
                    key={s.startsAt}
                    type="button"
                    onClick={() => onPick(s, date)}
                    className={cx(
                      'accent-ring rounded-lg border py-2.5 text-sm font-semibold tabular-nums transition',
                      selected === s.startsAt ? 'accent-bg border-transparent' : 'accent-border accent-text bg-white hover:bg-slate-50',
                    )}
                  >
                    {s.time}
                  </button>
                ))}
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
