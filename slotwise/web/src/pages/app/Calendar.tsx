import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { AppointmentModal, BlockTimeModal, NewAppointmentModal } from '../../components/AppointmentModals';
import { Button, cx, Select } from '../../components/ui';
import { del, get } from '../../lib/api';
import { addDays, formatDay, hm, minutesOf, nowMinutesIn, startOfWeek, todayIn, weekday } from '../../lib/dates';
import { useRefresh } from '../../lib/session';
import type { Appointment, Staff, TimeOff } from '../../lib/types';
import { useApp } from './AppLayout';

const HOUR_PX = 60;
const STAFF_COLORS = ['bg-indigo-100 border-indigo-400 text-indigo-950', 'bg-emerald-100 border-emerald-500 text-emerald-950', 'bg-amber-100 border-amber-500 text-amber-950', 'bg-rose-100 border-rose-400 text-rose-950', 'bg-sky-100 border-sky-500 text-sky-950'];

interface Column {
  key: string;
  label: string;
  date: string;
  staffIds: string[];
}

/** Split a multi-day block into the part visible on `date`. */
function clipToDay(localStart: string, localEnd: string, date: string): [number, number] | null {
  if (localEnd.slice(0, 10) < date || localStart.slice(0, 10) > date) return null;
  const s = localStart.slice(0, 10) < date ? 0 : minutesOf(localStart);
  const e = localEnd.slice(0, 10) > date ? 24 * 60 : minutesOf(localEnd);
  return e > s ? [s, e] : null;
}

export default function Calendar() {
  const { t, i18n } = useTranslation();
  const { info, tenantId, isManager } = useApp();
  const refresh = useRefresh();
  const tz = info.tenant.timezone;
  const today = todayIn(tz);
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as 'day' | 'week') ?? (window.innerWidth < 640 ? 'day' : 'week');
  const date = params.get('date') ?? today;
  const staffFilter = params.get('staff') ?? 'all';
  const set = (patch: Record<string, string>) => setParams({ view, date, staff: staffFilter, ...patch });

  const [open, setOpen] = useState<Appointment | null>(null);
  const [creating, setCreating] = useState<{ date: string; time?: string; staffId?: string } | null>(null);
  const [blocking, setBlocking] = useState(false);

  const staff = useQuery({ queryKey: ['staff', tenantId], queryFn: () => get<Staff[]>(`/t/${tenantId}/staff`) });
  const myStaffId = info.membership.staffId;
  const allStaff = (staff.data ?? []).filter((s) => s.active && (isManager || s.id === myStaffId));
  const shownStaff = staffFilter === 'all' ? allStaff : allStaff.filter((s) => s.id === staffFilter);
  const staffIndex = (id: string) => Math.max(0, allStaff.findIndex((s) => s.id === id));

  const from = view === 'week' ? startOfWeek(date) : date;
  const to = view === 'week' ? addDays(from, 6) : date;
  const staffQs = staffFilter !== 'all' ? `&staffId=${staffFilter}` : '';

  const appts = useQuery({
    queryKey: ['appointments', tenantId, from, to, staffFilter],
    queryFn: () => get<Appointment[]>(`/t/${tenantId}/appointments?from=${from}&to=${to}${staffQs}`),
  });
  const timeOff = useQuery({
    queryKey: ['timeoff', tenantId, from, to, staffFilter],
    queryFn: () => get<TimeOff[]>(`/t/${tenantId}/time-off?from=${from}&to=${to}${staffQs}`),
  });

  const columns: Column[] = useMemo(() => {
    if (view === 'day') {
      return shownStaff.map((s) => ({ key: s.id, label: s.name, date, staffIds: [s.id] }));
    }
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(from, i);
      return { key: d, label: formatDay(d, i18n.language, { weekday: 'short', day: 'numeric' }), date: d, staffIds: shownStaff.map((s) => s.id) };
    });
  }, [view, shownStaff, date, from, i18n.language]);

  // Visible hours: union of working hours, widened to fit any appointment.
  const [startHour, endHour] = useMemo(() => {
    let lo = 24 * 60;
    let hi = 0;
    for (const s of shownStaff) for (const h of s.hours) {
      lo = Math.min(lo, hm(h.start));
      hi = Math.max(hi, hm(h.end));
    }
    for (const a of appts.data ?? []) {
      lo = Math.min(lo, minutesOf(a.localStart));
      hi = Math.max(hi, a.localEnd.slice(0, 10) > a.localStart.slice(0, 10) ? 24 * 60 : minutesOf(a.localEnd));
    }
    if (lo >= hi) return [8, 20];
    return [Math.max(0, Math.floor(lo / 60) - 1), Math.min(24, Math.ceil(hi / 60) + 1)];
  }, [shownStaff, appts.data]);

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const top = (min: number) => ((min - startHour * 60) / 60) * HOUR_PX;
  const nowMin = nowMinutesIn(tz);
  const step = view === 'week' ? 7 : 1;

  const isWorking = (staffId: string, d: string, min: number) =>
    allStaff.find((s) => s.id === staffId)?.hours.some((h) => h.weekday === weekday(d) && hm(h.start) <= min && min < hm(h.end));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
          {(['day', 'week'] as const).map((v) => (
            <button key={v} type="button" onClick={() => set({ view: v })} className={cx('rounded-md px-3 py-1.5 text-sm font-medium', view === v ? 'bg-brand-600 text-white' : 'text-slate-600')}>
              {t(`calendar.${v}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label={t('calendar.prev')} onClick={() => set({ date: addDays(date, -step) })}>‹</Button>
          <Button variant="secondary" size="sm" onClick={() => set({ date: today })}>{t('common.today')}</Button>
          <Button variant="ghost" size="sm" aria-label={t('calendar.next')} onClick={() => set({ date: addDays(date, step) })}>›</Button>
        </div>
        <h1 className="text-lg font-semibold">
          {view === 'day' ? formatDay(date, i18n.language) : `${formatDay(from, i18n.language, { day: 'numeric', month: 'short' })} – ${formatDay(to, i18n.language, { day: 'numeric', month: 'short' })}`}
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {isManager && allStaff.length > 1 && (
            <Select aria-label={t('appt.staff')} value={staffFilter} onChange={(e) => set({ staff: e.target.value })} className="w-auto py-1.5">
              <option value="all">{t('calendar.allStaff')}</option>
              {allStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
          <Button variant="secondary" size="sm" onClick={() => setBlocking(true)}>{t('calendar.blockTime')}</Button>
          <Button size="sm" onClick={() => setCreating({ date })}>+ {t('calendar.newAppointment')}</Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <div className="flex min-w-fit">
          {/* time gutter */}
          <div className="sticky left-0 z-10 w-12 shrink-0 border-r border-slate-200 bg-white">
            <div className="h-10 border-b border-slate-200" />
            {hours.map((h) => (
              <div key={h} className="relative text-right text-[11px] text-slate-400" style={{ height: HOUR_PX }}>
                <span className="absolute -top-2 right-1.5">{String(h).padStart(2, '0')}:00</span>
              </div>
            ))}
          </div>
          {columns.map((col) => {
            const colAppts = (appts.data ?? []).filter((a) => col.staffIds.includes(a.staffId) && clipToDay(a.localStart, a.localEnd, col.date));
            const colOff = (timeOff.data ?? []).filter((o) => col.staffIds.includes(o.staffId));
            const lanes = col.staffIds.length;
            return (
              <div key={col.key} className="min-w-[120px] flex-1 border-r border-slate-100 last:border-r-0">
                <button
                  type="button"
                  onClick={() => view === 'week' && set({ view: 'day', date: col.date })}
                  className={cx('sticky top-0 flex h-10 w-full items-center justify-center border-b border-slate-200 bg-white text-sm font-semibold', col.date === today && view === 'week' && 'text-brand-700')}
                >
                  {col.label}
                </button>
                <div
                  className="relative"
                  style={{ height: hours.length * HOUR_PX }}
                  onClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const y = e.nativeEvent.offsetY;
                    const min = Math.floor((startHour * 60 + (y / HOUR_PX) * 60) / 15) * 15;
                    setCreating({
                      date: col.date,
                      time: `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
                      staffId: view === 'day' ? col.staffIds[0] : undefined,
                    });
                  }}
                >
                  {/* hour lines + non-working shading */}
                  {hours.map((h) => (
                    <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-slate-100" style={{ top: (h - startHour) * HOUR_PX, height: HOUR_PX }}>
                      {lanes === 1 && !isWorking(col.staffIds[0]!, col.date, h * 60) && <div className="h-full bg-slate-50" />}
                    </div>
                  ))}
                  {colOff.map((o) => {
                    const span = clipToDay(o.localStart, o.localEnd, col.date);
                    if (!span) return null;
                    const lane = lanes > 1 ? col.staffIds.indexOf(o.staffId) : 0;
                    return (
                      <div
                        key={o.id}
                        className="group absolute overflow-hidden rounded-md bg-[repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0_6px,#f1f5f9_6px,#f1f5f9_12px)] px-1.5 py-1 text-[11px] text-slate-600"
                        style={{ top: Math.max(0, top(span[0])), height: Math.max(18, top(span[1]) - Math.max(0, top(span[0]))), left: `${(lane / lanes) * 100}%`, width: `${100 / lanes}%` }}
                      >
                        <span className="font-semibold">{o.kind === 'day_off' ? t('calendar.dayOff') : t('calendar.blocked')}</span>
                        {o.reason && ` · ${o.reason}`}
                        <button
                          type="button"
                          aria-label={t('common.delete')}
                          className="absolute right-1 top-0.5 hidden rounded bg-white/80 px-1 group-hover:block"
                          onClick={async () => {
                            await del(`/t/${tenantId}/time-off/${o.id}`);
                            await refresh('timeoff');
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                  {colAppts.map((a) => {
                    const span = clipToDay(a.localStart, a.localEnd, col.date)!;
                    const lane = lanes > 1 ? col.staffIds.indexOf(a.staffId) : 0;
                    const h = top(span[1]) - top(span[0]);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setOpen(a)}
                        className={cx(
                          'absolute overflow-hidden rounded-md border-l-4 px-1.5 py-1 text-left text-xs shadow-sm',
                          STAFF_COLORS[staffIndex(a.staffId) % STAFF_COLORS.length],
                          a.status === 'no_show' && 'opacity-50 line-through',
                          a.status === 'completed' && 'opacity-70',
                        )}
                        style={{ top: top(span[0]) + 1, height: Math.max(20, h - 2), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
                      >
                        <span className="font-semibold tabular-nums">{a.localStart.slice(11, 16)}</span> <span className="font-semibold">{a.clientName}</span>
                        {h > 34 && <span className="block truncate">{a.serviceName}</span>}
                      </button>
                    );
                  })}
                  {col.date === today && nowMin >= startHour * 60 && nowMin <= endHour * 60 && (
                    <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: top(nowMin) }}>
                      <span className="absolute -left-1 -top-1.5 h-3 w-3 rounded-full bg-red-500" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {appts.data?.length === 0 && <p className="mt-3 text-center text-sm text-slate-500">{t('calendar.noAppointments')}</p>}

      <AppointmentModal tenantId={tenantId} appt={open} staff={allStaff} canMoveStaff={isManager} onClose={() => setOpen(null)} />
      {allStaff[0] && (
        <>
          <NewAppointmentModal
            tenantId={tenantId}
            open={Boolean(creating)}
            onClose={() => setCreating(null)}
            staff={allStaff}
            defaultStaffId={creating?.staffId ?? (staffFilter !== 'all' ? staffFilter : myStaffId && allStaff.some((s) => s.id === myStaffId) ? myStaffId : allStaff[0].id)}
            defaultDate={creating?.date ?? date}
            defaultTime={creating?.time}
            isManager={isManager}
          />
          <BlockTimeModal
            tenantId={tenantId}
            open={blocking}
            onClose={() => setBlocking(false)}
            staff={allStaff}
            defaultStaffId={staffFilter !== 'all' ? staffFilter : myStaffId && allStaff.some((s) => s.id === myStaffId) ? myStaffId : allStaff[0].id}
            defaultDate={date}
          />
        </>
      )}
    </div>
  );
}
