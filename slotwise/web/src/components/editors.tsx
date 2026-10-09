import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { del, get, patch, post } from '../lib/api';
import { formatDuration, formatMoney, weekdayName } from '../lib/dates';
import { useRefresh } from '../lib/session';
import type { HoursRow, Service } from '../lib/types';
import { Badge, Button, cx, ErrorText, Input, Modal, Textarea, Toggle } from './ui';

// ── Weekly hours ──────────────────────────────────────────────────────────────

const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first

export function HoursEditor({ value, onChange }: { value: HoursRow[]; onChange: (v: HoursRow[]) => void }) {
  const { t, i18n } = useTranslation();
  const byDay = (d: number) => value.filter((r) => r.weekday === d);
  const setDay = (d: number, rows: HoursRow[]) => onChange([...value.filter((r) => r.weekday !== d), ...rows].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)));

  return (
    <div className="divide-y divide-slate-100">
      {WEEK.map((d) => {
        const rows = byDay(d);
        const open = rows.length > 0;
        return (
          <div key={d} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
            <label className="flex w-36 items-center gap-2 pt-2 text-sm font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-600"
                checked={open}
                onChange={(e) => setDay(d, e.target.checked ? [{ weekday: d, start: '09:00', end: '17:00' }] : [])}
              />
              {weekdayName(d, i18n.language)}
            </label>
            <div className="flex-1 space-y-2">
              {!open && <p className="pt-2 text-sm text-slate-400">{t('settings.closed')}</p>}
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="time"
                    aria-label={t('appt.from')}
                    value={r.start}
                    step={300}
                    onChange={(e) => setDay(d, rows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                  />
                  <span className="text-slate-400">–</span>
                  <input
                    type="time"
                    aria-label={t('appt.to')}
                    value={r.end}
                    step={300}
                    onChange={(e) => setDay(d, rows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
                    className={cx('rounded-lg border px-2 py-1.5 text-sm', r.start >= r.end ? 'border-red-400' : 'border-slate-300')}
                  />
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={() => setDay(d, rows.filter((_, j) => j !== i))}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {open && (
                <button
                  type="button"
                  className="text-xs font-semibold text-brand-700"
                  onClick={() => {
                    const last = rows.at(-1)!;
                    setDay(d, [...rows, { weekday: d, start: last.end < '22:00' ? last.end : '18:00', end: last.end < '22:00' ? '22:00' : '20:00' }]);
                  }}
                >
                  + {t('settings.addRange')}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <div className="pt-3">
        <button
          type="button"
          className="text-sm font-semibold text-brand-700"
          onClick={() => {
            const monday = byDay(1);
            onChange([...value.filter((r) => r.weekday === 0 || r.weekday === 6 || r.weekday === 1),
              ...[2, 3, 4, 5].flatMap((d) => monday.map((r) => ({ ...r, weekday: d })))]);
          }}
        >
          {t('settings.copyToAll')}
        </button>
      </div>
    </div>
  );
}

export function hoursValid(rows: HoursRow[]): boolean {
  return rows.every((r) => r.start < r.end);
}

// ── Services ─────────────────────────────────────────────────────────────────

interface ServiceForm {
  name: string;
  description: string;
  durationMin: number;
  price: string;
  bufferMin: number;
  active: boolean;
}

const emptyService: ServiceForm = { name: '', description: '', durationMin: 60, price: '', bufferMin: 0, active: true };
const DURATIONS = [15, 20, 30, 45, 60, 75, 90, 120, 150, 180];

function ServiceFields({ form, onPatch, compact }: { form: ServiceForm; onPatch: (p: Partial<ServiceForm>) => void; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const durationId = useId();
  return (
    <div className="space-y-3">
      <Input label={t('settings.serviceName')} required maxLength={80} value={form.name} onChange={(e) => onPatch({ name: e.target.value })} />
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor={durationId} className="block text-sm font-medium text-slate-700">{t('settings.duration')}</label>
          <input
            id={durationId}
            list="durations"
            type="number"
            min={5}
            max={720}
            step={5}
            required
            value={form.durationMin}
            onChange={(e) => onPatch({ durationMin: Number(e.target.value) })}
            className="block w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base sm:text-sm"
          />
          <datalist id="durations">
            {DURATIONS.map((d) => <option key={d} value={d}>{formatDuration(d, i18n.language)}</option>)}
          </datalist>
        </div>
        <Input label={`${t('settings.price')} (€)`} type="number" min={0} step="0.5" inputMode="decimal" value={form.price} onChange={(e) => onPatch({ price: e.target.value })} />
      </div>
      {!compact && (
        <>
          <Input label={t('settings.buffer')} hint={t('settings.bufferHint')} type="number" min={0} max={240} step={5} value={form.bufferMin} onChange={(e) => onPatch({ bufferMin: Number(e.target.value) })} />
          <Textarea label={t('settings.description')} maxLength={500} value={form.description} onChange={(e) => onPatch({ description: e.target.value })} />
          <Toggle label={t('settings.active')} checked={form.active} onChange={(v) => onPatch({ active: v })} />
        </>
      )}
    </div>
  );
}

function toPayload(f: ServiceForm) {
  return {
    name: f.name,
    description: f.description || null,
    durationMin: f.durationMin,
    priceCents: Math.round(Number(f.price || 0) * 100),
    bufferMin: f.bufferMin,
    active: f.active,
  };
}

export function ServicesEditor({ tenantId, compact }: { tenantId: string; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const refresh = useRefresh();
  const services = useQuery({ queryKey: ['services', tenantId], queryFn: () => get<Service[]>(`/t/${tenantId}/services`) });
  const [form, setForm] = useState<ServiceForm>(emptyService);
  const [editing, setEditing] = useState<{ id: string; form: ServiceForm } | null>(null);

  const create = useMutation({
    mutationFn: () => post(`/t/${tenantId}/services`, { ...toPayload(form), sort: services.data?.length ?? 0 }),
    onSuccess: async () => {
      setForm(emptyService);
      await refresh('services', 'public');
    },
  });
  const update = useMutation({
    mutationFn: () => patch(`/t/${tenantId}/services/${editing!.id}`, toPayload(editing!.form)),
    onSuccess: async () => {
      setEditing(null);
      await refresh('services', 'public');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/t/${tenantId}/services/${id}`),
    onSuccess: async () => {
      setEditing(null);
      await refresh('services', 'public');
    },
  });

  return (
    <div className="space-y-4">
      {services.data && services.data.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {services.data.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
                onClick={() =>
                  setEditing({
                    id: s.id,
                    form: { name: s.name, description: s.description ?? '', durationMin: s.durationMin, price: s.priceCents ? String(s.priceCents / 100) : '', bufferMin: s.bufferMin, active: s.active },
                  })
                }
              >
                <span>
                  <span className="font-medium">{s.name}</span>{' '}
                  {!s.active && <Badge>{t('settings.hidden')}</Badge>}
                  <span className="block text-sm text-slate-500">
                    {formatDuration(s.durationMin, i18n.language)}
                    {s.bufferMin > 0 && ` + ${s.bufferMin}`}
                  </span>
                </span>
                <span className="text-sm font-semibold">{s.priceCents > 0 ? formatMoney(s.priceCents, s.currency, i18n.language) : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-3 rounded-xl border border-dashed border-slate-300 p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h3 className="font-semibold">{t('settings.newService')}</h3>
        <ServiceFields form={form} onPatch={(p) => setForm((f) => ({ ...f, ...p }))} compact={compact} />
        <ErrorText error={create.error} />
        <Button type="submit" variant="secondary" loading={create.isPending}>+ {t('common.add')}</Button>
      </form>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.form.name || t('settings.services')}
        footer={
          <>
            <Button variant="danger" className="mr-auto" loading={remove.isPending} onClick={() => editing && remove.mutate(editing.id)}>{t('common.delete')}</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button loading={update.isPending} onClick={() => update.mutate()}>{t('common.save')}</Button>
          </>
        }
      >
        {editing && <ServiceFields form={editing.form} onPatch={(p) => setEditing((e) => e && { ...e, form: { ...e.form, ...p } })} />}
        <ErrorText error={update.error ?? remove.error} />
      </Modal>
    </div>
  );
}
