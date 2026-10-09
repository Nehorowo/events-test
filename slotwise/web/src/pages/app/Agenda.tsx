import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { AppointmentModal, NewAppointmentModal, statusTone } from '../../components/AppointmentModals';
import { Badge, Button, Card, cx, PageSpinner } from '../../components/ui';
import { get } from '../../lib/api';
import { addDays, formatDay, minutesOf, nowMinutesIn, todayIn } from '../../lib/dates';
import type { Appointment, Staff } from '../../lib/types';
import { useApp } from './AppLayout';

export default function Agenda() {
  const { t, i18n } = useTranslation();
  const { info, tenantId, isManager } = useApp();
  const tz = info.tenant.timezone;
  const today = todayIn(tz);
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? today;
  const [open, setOpen] = useState<Appointment | null>(null);
  const [creating, setCreating] = useState(false);

  const staff = useQuery({ queryKey: ['staff', tenantId], queryFn: () => get<Staff[]>(`/t/${tenantId}/staff`) });
  const appts = useQuery({
    queryKey: ['appointments', tenantId, date, date],
    queryFn: () => get<Appointment[]>(`/t/${tenantId}/appointments?from=${date}&to=${date}`),
    refetchInterval: 60_000,
  });

  const myStaffId = info.membership.staffId;
  const visibleStaff = (staff.data ?? []).filter((s) => isManager || s.id === myStaffId);
  const now = nowMinutesIn(tz);
  const list = appts.data ?? [];
  const isToday = date === today;
  const nextIdx = isToday ? list.findIndex((a) => minutesOf(a.localEnd) > now && a.status === 'confirmed') : -1;

  const setDate = (d: string) => setParams(d === today ? {} : { date: d });

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{isToday ? t('agenda.title') : formatDay(date, i18n.language, { weekday: 'long' })}</h1>
          <p className="text-sm text-slate-500">
            {formatDay(date, i18n.language)} · {t('agenda.count', { count: list.length })}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label={t('calendar.prev')} onClick={() => setDate(addDays(date, -1))}>‹</Button>
          {!isToday && <Button variant="secondary" size="sm" onClick={() => setDate(today)}>{t('common.today')}</Button>}
          <Button variant="ghost" size="sm" aria-label={t('calendar.next')} onClick={() => setDate(addDays(date, 1))}>›</Button>
        </div>
      </div>

      {appts.isLoading ? (
        <PageSpinner />
      ) : list.length === 0 ? (
        <Card className="py-10 text-center">
          <p className="font-medium text-slate-700">{t('agenda.empty')}</p>
          {isManager && <p className="mt-1 text-sm text-slate-500">{t('agenda.emptyHint')}</p>}
          {isManager && (
            <a href={info.bookingUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm font-semibold text-brand-700 underline">
              {info.bookingUrl.replace(/^https?:\/\//, '')}
            </a>
          )}
        </Card>
      ) : (
        <ol className="space-y-2">
          {list.map((a, i) => {
            const past = isToday && minutesOf(a.localEnd) <= now;
            return (
              <li key={a.id}>
                {i === nextIdx && <p className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-brand-700">{t('agenda.next')}</p>}
                <button
                  type="button"
                  onClick={() => setOpen(a)}
                  className={cx(
                    'flex w-full items-stretch gap-3 rounded-xl border bg-white p-3 text-left shadow-sm transition hover:border-slate-300',
                    i === nextIdx ? 'border-brand-500 ring-1 ring-brand-500' : 'border-slate-200',
                    (past || a.status === 'cancelled') && 'opacity-60',
                  )}
                >
                  <div className="w-14 shrink-0 text-right">
                    <p className="font-bold tabular-nums">{a.localStart.slice(11, 16)}</p>
                    <p className="text-xs tabular-nums text-slate-500">{a.localEnd.slice(11, 16)}</p>
                  </div>
                  <div className="w-1 rounded-full bg-brand-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{a.clientName}</p>
                    <p className="truncate text-sm text-slate-600">
                      {a.serviceName}
                      {isManager && visibleStaff.length > 1 && ` · ${a.staffName}`}
                    </p>
                    {a.notes && <p className="mt-0.5 truncate text-xs text-slate-500">📝 {a.notes}</p>}
                  </div>
                  {a.status !== 'confirmed' && <Badge tone={statusTone(a.status)}>{t(`appt.status_${a.status}`)}</Badge>}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <button
        type="button"
        onClick={() => setCreating(true)}
        className="fixed bottom-20 right-4 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-3xl text-white shadow-lg sm:bottom-6"
        aria-label={t('calendar.newAppointment')}
      >
        +
      </button>

      <AppointmentModal tenantId={tenantId} appt={open} staff={visibleStaff} canMoveStaff={isManager} onClose={() => setOpen(null)} />
      {visibleStaff[0] && (
        <NewAppointmentModal
          tenantId={tenantId}
          open={creating}
          onClose={() => setCreating(false)}
          staff={visibleStaff}
          defaultStaffId={myStaffId && visibleStaff.some((s) => s.id === myStaffId) ? myStaffId : visibleStaff[0].id}
          defaultDate={date}
          isManager={isManager}
        />
      )}
    </div>
  );
}
