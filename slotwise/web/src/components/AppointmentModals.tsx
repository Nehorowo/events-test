import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { get, patch, post } from '../lib/api';
import { formatDay, formatDuration, formatMoney } from '../lib/dates';
import { useRefresh } from '../lib/session';
import type { Appointment, Client, Service, Staff } from '../lib/types';
import { Badge, Button, ErrorText, Input, Modal, Select, Textarea, Toggle } from './ui';

export function statusTone(s: Appointment['status']) {
  return s === 'confirmed' ? 'brand' : s === 'completed' ? 'green' : s === 'no_show' ? 'red' : 'slate';
}

export function AppointmentModal({
  tenantId,
  appt,
  staff,
  canMoveStaff,
  onClose,
}: {
  tenantId: string;
  appt: Appointment | null;
  staff: Staff[];
  canMoveStaff: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const refresh = useRefresh();
  const [moving, setMoving] = useState(false);
  const [move, setMove] = useState({ date: '', time: '', staffId: '' });
  const [notes, setNotes] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (!appt) return;
    setMoving(false);
    setConfirmCancel(false);
    setMove({ date: appt.localStart.slice(0, 10), time: appt.localStart.slice(11, 16), staffId: appt.staffId });
    setNotes(appt.notes ?? '');
  }, [appt]);

  const done = async () => {
    await refresh('appointments', 'clients', 'tenant');
    onClose();
  };
  const update = useMutation({ mutationFn: (body: object) => patch(`/t/${tenantId}/appointments/${appt!.id}`, body), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => post(`/t/${tenantId}/appointments/${appt!.id}/cancel`), onSuccess: done });

  if (!appt) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  const live = appt.status !== 'cancelled';
  const durationMin = (new Date(appt.endsAt).getTime() - new Date(appt.startsAt).getTime()) / 60000;

  return (
    <Modal
      open
      onClose={onClose}
      title={appt.clientName}
      footer={
        live && !moving && !confirmCancel ? (
          <>
            <Button variant="danger" className="mr-auto" onClick={() => setConfirmCancel(true)}>{t('appt.cancelAppt')}</Button>
            <Button variant="secondary" onClick={() => setMoving(true)}>{t('appt.move')}</Button>
            {notes !== (appt.notes ?? '') && (
              <Button loading={update.isPending} onClick={() => update.mutate({ notes: notes || null })}>{t('common.save')}</Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(appt.status)}>{t(`appt.status_${appt.status}`)}</Badge>
          <span className="text-xs text-slate-500">{t(`appt.source_${appt.source}`)}</span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-500">{t('appt.service')}</dt>
          <dd className="font-medium">
            {appt.serviceName} · {formatDuration(durationMin, i18n.language)}
            {appt.priceCents > 0 && ` · ${formatMoney(appt.priceCents, appt.currency, i18n.language)}`}
          </dd>
          <dt className="text-slate-500">{t('appt.date')}</dt>
          <dd className="font-medium">{formatDay(appt.localStart.slice(0, 10), i18n.language)}, {appt.localStart.slice(11, 16)}–{appt.localEnd.slice(11, 16)}</dd>
          <dt className="text-slate-500">{t('appt.staff')}</dt>
          <dd className="font-medium">{appt.staffName}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          {appt.clientPhone && <a href={`tel:${appt.clientPhone}`} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium">📞 {appt.clientPhone}</a>}
          {appt.clientEmail && <a href={`mailto:${appt.clientEmail}`} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium">✉️ {appt.clientEmail}</a>}
        </div>

        {live && (
          <div className="flex flex-wrap gap-2">
            {appt.status !== 'completed' && (
              <Button size="sm" variant="secondary" onClick={() => update.mutate({ status: 'completed' })}>{t('appt.markCompleted')}</Button>
            )}
            {appt.status !== 'no_show' && (
              <Button size="sm" variant="secondary" onClick={() => update.mutate({ status: 'no_show' })}>{t('appt.markNoShow')}</Button>
            )}
            {appt.status !== 'confirmed' && (
              <Button size="sm" variant="ghost" onClick={() => update.mutate({ status: 'confirmed' })}>{t('appt.reopen')}</Button>
            )}
          </div>
        )}

        {live && <Textarea label={t('appt.notes')} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />}

        {moving && (
          <form
            className="space-y-3 rounded-xl bg-slate-50 p-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              update.mutate({ date: move.date, time: move.time, staffId: move.staffId });
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Input label={t('appt.date')} type="date" required value={move.date} onChange={(e) => setMove({ ...move, date: e.target.value })} />
              <Input label={t('appt.time')} type="time" required step={300} value={move.time} onChange={(e) => setMove({ ...move, time: e.target.value })} />
            </div>
            {canMoveStaff && staff.length > 1 && (
              <Select label={t('appt.staff')} value={move.staffId} onChange={(e) => setMove({ ...move, staffId: e.target.value })}>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
            <div className="flex gap-2">
              <Button type="submit" loading={update.isPending}>{t('appt.move')}</Button>
              <Button type="button" variant="ghost" onClick={() => setMoving(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        )}

        {confirmCancel && (
          <div className="space-y-3 rounded-xl bg-red-50 p-3">
            <p className="text-sm font-medium text-red-900">{t('appt.cancelConfirm')}</p>
            <div className="flex gap-2">
              <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('appt.cancelAppt')}</Button>
              <Button variant="ghost" onClick={() => setConfirmCancel(false)}>{t('common.back')}</Button>
            </div>
          </div>
        )}
        <ErrorText error={update.error ?? cancel.error} />
      </div>
    </Modal>
  );
}

export function NewAppointmentModal({
  tenantId,
  open,
  onClose,
  staff,
  defaultStaffId,
  defaultDate,
  defaultTime,
  isManager,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
  staff: Staff[];
  defaultStaffId: string;
  defaultDate: string;
  defaultTime?: string;
  isManager: boolean;
}) {
  const { t, i18n } = useTranslation();
  const refresh = useRefresh();
  const services = useQuery({ queryKey: ['services', tenantId], queryFn: () => get<Service[]>(`/t/${tenantId}/services`), enabled: open });
  const [form, setForm] = useState({ serviceId: '', staffId: '', date: '', time: '', name: '', phone: '', email: '', notes: '' });
  const [query, setQuery] = useState('');
  const clients = useQuery({
    queryKey: ['clients', tenantId, query],
    queryFn: () => get<Client[]>(`/t/${tenantId}/clients?q=${encodeURIComponent(query)}`),
    enabled: open && isManager && query.length >= 2,
  });

  useEffect(() => {
    if (!open) return;
    setForm({ serviceId: '', staffId: defaultStaffId, date: defaultDate, time: defaultTime ?? '10:00', name: '', phone: '', email: '', notes: '' });
    setQuery('');
  }, [open, defaultStaffId, defaultDate, defaultTime]);

  useEffect(() => {
    const first = services.data?.find((s) => s.active) ?? services.data?.[0];
    if (open && first && !form.serviceId) setForm((f) => ({ ...f, serviceId: first.id }));
  }, [services.data, open, form.serviceId]);

  const create = useMutation({
    mutationFn: () =>
      post(`/t/${tenantId}/appointments`, {
        serviceId: form.serviceId,
        staffId: form.staffId,
        date: form.date,
        time: form.time,
        client: { name: form.name, phone: form.phone || null, email: form.email || null },
        notes: form.notes || null,
      }),
    onSuccess: async () => {
      await refresh('appointments', 'clients');
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.newAppointment')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="new-appt" loading={create.isPending}>{t('appt.create')}</Button>
        </>
      }
    >
      <form
        id="new-appt"
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Select label={t('appt.service')} required value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: e.target.value })}>
          {services.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {formatDuration(s.durationMin, i18n.language)}
            </option>
          ))}
        </Select>
        {staff.length > 1 && (
          <Select label={t('appt.staff')} value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input label={t('appt.date')} type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <Input label={t('appt.time')} type="time" required step={300} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
        </div>
        {isManager && (
          <div className="relative">
            <Input placeholder={t('appt.searchClient')} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('appt.searchClient')} />
            {clients.data && clients.data.length > 0 && query.length >= 2 && (
              <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                {clients.data.slice(0, 8).map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                      onClick={() => {
                        setForm({ ...form, name: c.name, phone: c.phone ?? '', email: c.email ?? '' });
                        setQuery('');
                      }}
                    >
                      <span className="font-medium">{c.name}</span>{' '}
                      <span className="text-slate-500">{c.phone ?? c.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Input label={t('appt.name')} required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={t('appt.phone')} type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Input label={t('appt.clientEmail')} type="email" hint={t('appt.clientEmailHint')} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <Textarea label={t('appt.notes')} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <ErrorText error={create.error} />
      </form>
    </Modal>
  );
}

export function BlockTimeModal({
  tenantId,
  open,
  onClose,
  staff,
  defaultStaffId,
  defaultDate,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
  staff: Staff[];
  defaultStaffId: string;
  defaultDate: string;
}) {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [form, setForm] = useState({ staffId: '', allDay: false, startDate: '', endDate: '', startTime: '12:00', endTime: '13:00', reason: '' });
  useEffect(() => {
    if (open) setForm({ staffId: defaultStaffId, allDay: false, startDate: defaultDate, endDate: defaultDate, startTime: '12:00', endTime: '13:00', reason: '' });
  }, [open, defaultStaffId, defaultDate]);
  const create = useMutation({
    mutationFn: () =>
      post(`/t/${tenantId}/time-off`, {
        staffId: form.staffId,
        kind: form.allDay ? 'day_off' : 'block',
        startDate: form.startDate,
        endDate: form.allDay ? form.endDate : form.startDate,
        startTime: form.allDay ? undefined : form.startTime,
        endTime: form.allDay ? undefined : form.endTime,
        reason: form.reason || undefined,
      }),
    onSuccess: async () => {
      await refresh('timeoff', 'availability', 'slots');
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.blockTime')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="block-time" loading={create.isPending}>{t('common.save')}</Button>
        </>
      }
    >
      <form
        id="block-time"
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {staff.length > 1 && (
          <Select label={t('appt.staff')} value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Toggle label={t('appt.allDay')} checked={form.allDay} onChange={(v) => setForm({ ...form, allDay: v })} />
        {form.allDay ? (
          <div className="grid grid-cols-2 gap-3">
            <Input label={t('appt.from')} type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} />
            <Input label={t('appt.to')} type="date" required min={form.startDate} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </div>
        ) : (
          <>
            <Input label={t('appt.date')} type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            <div className="grid grid-cols-2 gap-3">
              <Input label={t('appt.from')} type="time" required step={300} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
              <Input label={t('appt.to')} type="time" required step={300} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
            </div>
          </>
        )}
        <Input label={t('appt.blockReason')} maxLength={200} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        <ErrorText error={create.error} />
      </form>
    </Modal>
  );
}
