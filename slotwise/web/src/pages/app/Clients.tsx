import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { statusTone } from '../../components/AppointmentModals';
import { Badge, Button, Card, ErrorText, Input, Modal, PageSpinner, Textarea } from '../../components/ui';
import { del, get, patch } from '../../lib/api';
import { formatDay, formatInstant } from '../../lib/dates';
import { useRefresh } from '../../lib/session';
import type { Appointment, Client } from '../../lib/types';
import { useApp } from './AppLayout';

function ClientModal({ tenantId, client, onClose }: { tenantId: string; client: Client | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { info } = useApp();
  const refresh = useRefresh();
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (client) setForm({ name: client.name, email: client.email ?? '', phone: client.phone ?? '', notes: client.notes ?? '' });
    setConfirmDelete(false);
  }, [client]);
  const history = useQuery({
    queryKey: ['appointments', tenantId, 'client', client?.id],
    queryFn: () => get<Appointment[]>(`/t/${tenantId}/clients/${client!.id}/appointments`),
    enabled: Boolean(client),
  });
  const save = useMutation({
    mutationFn: () => patch(`/t/${tenantId}/clients/${client!.id}`, { name: form.name, email: form.email || null, phone: form.phone || null, notes: form.notes || null }),
    onSuccess: async () => {
      await refresh('clients');
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/t/${tenantId}/clients/${client!.id}`),
    onSuccess: async () => {
      await refresh('clients', 'appointments');
      onClose();
    },
  });

  return (
    <Modal
      open={Boolean(client)}
      onClose={onClose}
      title={client?.name ?? ''}
      footer={
        <>
          <Button variant="danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>{t('common.delete')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {confirmDelete && (
          <div className="space-y-2 rounded-xl bg-red-50 p-3">
            <p className="text-sm text-red-900">{t('clients.deleteConfirm')}</p>
            <Button variant="danger" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>{t('clients.deleteClient')}</Button>
          </div>
        )}
        <Input label={t('appt.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={t('appt.phone')} type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Input label={t('appt.clientEmail')} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <Textarea label={t('appt.notes')} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <ErrorText error={save.error ?? remove.error} />
        <h3 className="pt-2 font-semibold">{t('clients.history')}</h3>
        <ul className="divide-y divide-slate-100 text-sm">
          {history.data?.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{formatDay(a.localStart.slice(0, 10), i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })}</span>{' '}
                {a.localStart.slice(11, 16)} · {a.serviceName}
              </span>
              <Badge tone={statusTone(a.status)}>{t(`appt.status_${a.status}`)}</Badge>
            </li>
          ))}
        </ul>
        {client && <p className="text-xs text-slate-400">{formatInstant(client.createdAt, info.tenant.timezone, i18n.language, { dateStyle: 'medium' })}</p>}
      </div>
    </Modal>
  );
}

export default function Clients() {
  const { t, i18n } = useTranslation();
  const { tenantId, info } = useApp();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<Client | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(id);
  }, [q]);
  const clients = useQuery({
    queryKey: ['clients', tenantId, debounced],
    queryFn: () => get<Client[]>(`/t/${tenantId}/clients${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
  });
  const tz = info.tenant.timezone;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{t('clients.title')}</h1>
        <div className="flex gap-2">
          <a href={`/api/t/${tenantId}/export/clients.csv`} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium">{t('clients.exportClients')}</a>
          <a href={`/api/t/${tenantId}/export/appointments.csv`} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium">{t('clients.exportAppointments')}</a>
        </div>
      </div>
      <Input type="search" placeholder={t('clients.search')} aria-label={t('clients.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {clients.isLoading ? (
        <PageSpinner />
      ) : !clients.data?.length ? (
        <Card className="py-10 text-center text-slate-500">{t('clients.empty')}</Card>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {clients.data.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setOpen(c)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-sm text-slate-500">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-slate-500">
                  <span className="block">{t('clients.visits')}: {c.visits}{c.noShows > 0 && <span className="text-red-600"> · {t('clients.noShows')}: {c.noShows}</span>}</span>
                  {c.nextVisit ? (
                    <span className="block text-brand-700">{t('clients.nextVisit')}: {formatInstant(c.nextVisit, tz, i18n.language, { day: 'numeric', month: 'short' })}</span>
                  ) : c.lastVisit ? (
                    <span className="block">{t('clients.lastVisit')}: {formatInstant(c.lastVisit, tz, i18n.language, { day: 'numeric', month: 'short' })}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ClientModal tenantId={tenantId} client={open} onClose={() => setOpen(null)} />
    </div>
  );
}
