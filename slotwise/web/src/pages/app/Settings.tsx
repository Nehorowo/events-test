import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { HoursEditor, hoursValid, ServicesEditor } from '../../components/editors';
import { ShareCard } from '../../components/ShareCard';
import { Alert, Avatar, Badge, Button, Card, cx, ErrorText, Input, Select, Toggle } from '../../components/ui';
import { LANGS, setLang } from '../../i18n';
import { del, get, patch, post, put } from '../../lib/api';
import { addDays, formatDay, formatInstant, todayIn } from '../../lib/dates';
import { currentPushSubscription, enablePush, pushSupported } from '../../lib/push';
import { useRefresh } from '../../lib/session';
import type { HoursRow, Staff, Tenant, TimeOff } from '../../lib/types';
import { useApp } from './AppLayout';

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </Card>
  );
}

// ── Business ─────────────────────────────────────────────────────────────────

function readFileAsDataUrl(file: File, maxSize = 256): Promise<string> {
  // Downscale on the client so the stored logo stays small.
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function BusinessTab() {
  const { t } = useTranslation();
  const { info, tenantId } = useApp();
  const refresh = useRefresh();
  const navigate = useNavigate();
  const [form, setForm] = useState<Tenant>(info.tenant);
  const [deleting, setDeleting] = useState('');
  useEffect(() => setForm(info.tenant), [info.tenant]);
  const zones = useQuery({ queryKey: ['timezones'], queryFn: () => get<string[]>('/timezones'), staleTime: Infinity });
  const branding = info.plan.limits.branding;

  const save = useMutation({
    mutationFn: (body: Partial<Tenant>) => patch(`/t/${tenantId}`, body),
    onSuccess: () => refresh('tenant', 'me', 'public'),
  });
  const remove = useMutation({
    mutationFn: () => del(`/t/${tenantId}`, { confirm: deleting }),
    onSuccess: async () => {
      await refresh('me');
      navigate('/onboarding');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      name: form.name, slug: form.slug, timezone: form.timezone, address: form.address || null, phone: form.phone || null,
      logoData: form.logoData, locale: form.locale, slotStepMin: form.slotStepMin, minNoticeMin: form.minNoticeMin,
      maxDaysAhead: form.maxDaysAhead, ...(branding ? { brandColor: form.brandColor } : {}),
    });
  };

  return (
    <div className="space-y-4">
      <Section
        title={t('settings.shareLink')}
        aside={<Toggle label={info.tenant.published ? t('settings.published') : t('settings.unpublished')} checked={info.tenant.published} onChange={(v) => save.mutate({ published: v })} />}
      >
        <ShareCard url={info.bookingUrl} slug={info.tenant.slug} />
      </Section>

      <form onSubmit={submit} className="space-y-4">
        <Section title={t('settings.business')}>
          <Input label={t('onboarding.businessName')} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label={t('onboarding.slug')} required pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
          <Select label={t('onboarding.timezone')} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {(zones.data ?? [form.timezone]).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
          <Input label={t('onboarding.address')} value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <Input label={t('onboarding.phone')} type="tel" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Select label={t('common.language')} value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value as Tenant['locale'] })}>
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-slate-700">{t('settings.logo')}</p>
            <div className="flex items-center gap-3">
              <Avatar name={form.name} src={form.logoData} size={56} />
              <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
                {t('settings.uploadLogo')}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setForm({ ...form, logoData: await readFileAsDataUrl(file) });
                  }}
                />
              </label>
              {form.logoData && <Button type="button" variant="ghost" size="sm" onClick={() => setForm({ ...form, logoData: null })}>{t('settings.removeLogo')}</Button>}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="flex items-center gap-2 text-sm font-medium text-slate-700">{t('settings.brandColor')} {!branding && <Badge tone="brand">{t('settings.proOnly')}</Badge>}</p>
            <input type="color" disabled={!branding} value={form.brandColor ?? '#4f46e5'} onChange={(e) => setForm({ ...form, brandColor: e.target.value })} className="h-10 w-20 cursor-pointer rounded border border-slate-300 disabled:cursor-not-allowed disabled:opacity-50" />
          </div>
        </Section>

        <Section title={t('settings.bookingRules')}>
          <Select label={t('settings.slotStep')} value={form.slotStepMin} onChange={(e) => setForm({ ...form, slotStepMin: Number(e.target.value) })}>
            {[5, 10, 15, 20, 30, 60].map((n) => <option key={n} value={n}>{t('common.minutes', { n })}</option>)}
          </Select>
          <Select label={t('settings.minNotice')} value={form.minNoticeMin} onChange={(e) => setForm({ ...form, minNoticeMin: Number(e.target.value) })}>
            {[0, 30, 60, 120, 240, 720, 1440, 2880].map((n) => <option key={n} value={n}>{n < 60 ? t('common.minutes', { n }) : `${n / 60} ${t('settings.hours')}`}</option>)}
          </Select>
          <Select label={t('settings.maxDaysAhead')} value={form.maxDaysAhead} onChange={(e) => setForm({ ...form, maxDaysAhead: Number(e.target.value) })}>
            {[7, 14, 30, 60, 90, 180, 365].map((n) => <option key={n} value={n}>{n} {t('settings.days')}</option>)}
          </Select>
        </Section>

        <div className="flex items-center gap-3">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          {save.isSuccess && <span className="text-sm text-emerald-700">✓ {t('common.saved')}</span>}
          <ErrorText error={save.error} />
        </div>
      </form>

      {info.membership.role === 'owner' && (
        <Section title={t('settings.dangerZone')}>
          <p className="text-sm text-slate-600">{t('settings.deleteBusinessConfirm', { slug: info.tenant.slug })}</p>
          <div className="flex gap-2">
            <Input aria-label={info.tenant.slug} placeholder={info.tenant.slug} value={deleting} onChange={(e) => setDeleting(e.target.value)} />
            <Button variant="danger" disabled={deleting !== info.tenant.slug} loading={remove.isPending} onClick={() => remove.mutate()}>{t('settings.deleteBusiness')}</Button>
          </div>
          <ErrorText error={remove.error} />
        </Section>
      )}
    </div>
  );
}

// ── Staff ────────────────────────────────────────────────────────────────────

function StaffCard({ s, tenantId, isManager, canEdit }: { s: Staff; tenantId: string; isManager: boolean; canEdit: boolean }) {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [hours, setHours] = useState<HoursRow[]>(s.hours);
  const [inviteEmail, setInviteEmail] = useState(s.email ?? '');
  const [admin, setAdmin] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => setHours(s.hours), [s.hours]);
  const dirty = JSON.stringify(hours) !== JSON.stringify(s.hours);

  const saveHours = useMutation({ mutationFn: () => put(`/t/${tenantId}/staff/${s.id}/hours`, hours), onSuccess: () => refresh('staff', 'availability', 'slots') });
  const update = useMutation({ mutationFn: (body: object) => patch(`/t/${tenantId}/staff/${s.id}`, body), onSuccess: () => refresh('staff', 'tenant', 'public') });
  const remove = useMutation({ mutationFn: () => del(`/t/${tenantId}/staff/${s.id}`), onSuccess: () => refresh('staff', 'tenant', 'public') });
  const invite = useMutation({
    mutationFn: () => post(`/t/${tenantId}/staff/${s.id}/invite`, { email: inviteEmail, role: admin ? 'admin' : 'staff' }),
    onSuccess: async () => {
      setSent(inviteEmail);
      await refresh('staff');
    },
  });
  const revoke = useMutation({ mutationFn: (userId: string) => del(`/t/${tenantId}/members/${userId}`), onSuccess: () => refresh('staff') });

  return (
    <Card className={cx('space-y-4', !s.active && 'opacity-70')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Avatar name={s.name} size={36} />
          <div>
            <p className="font-semibold">{s.name}</p>
            {s.email && <p className="text-xs text-slate-500">{s.email}</p>}
          </div>
          {!s.active && <Badge>{t('settings.deactivate')}</Badge>}
        </div>
        {isManager && s.member?.role !== 'owner' && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => update.mutate({ active: !s.active })}>{s.active ? t('settings.deactivate') : t('settings.activate')}</Button>
            <Button size="sm" variant="danger" onClick={() => remove.mutate()}>{t('common.delete')}</Button>
          </div>
        )}
      </div>
      <ErrorText error={update.error ?? remove.error} />

      <div>
        <h3 className="mb-1 text-sm font-semibold text-slate-700">{t('settings.workingHours')}</h3>
        {canEdit ? <HoursEditor value={hours} onChange={setHours} /> : null}
        {canEdit && dirty && (
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={!hoursValid(hours)} loading={saveHours.isPending} onClick={() => saveHours.mutate()}>{t('common.save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setHours(s.hours)}>{t('common.cancel')}</Button>
          </div>
        )}
        <ErrorText error={saveHours.error} />
      </div>

      {isManager && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          {s.member ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-slate-600">{t('settings.hasAccess', { email: s.member.email, role: s.member.role })}</span>
              {s.member.role !== 'owner' && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.member!.userId)}>{t('settings.removeAccess')}</Button>}
            </div>
          ) : (
            <form
              className="space-y-2"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                invite.mutate();
              }}
            >
              {s.pendingInvite && !sent && <p className="text-sm text-slate-500">{t('settings.invitePending', { email: s.pendingInvite.email })}</p>}
              {sent && <Alert tone="green">{t('settings.inviteSent', { email: sent })}</Alert>}
              <div className="flex gap-2">
                <Input type="email" required placeholder={t('settings.staffEmail')} aria-label={t('settings.staffEmail')} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
                <Button type="submit" variant="secondary" loading={invite.isPending}>{t('settings.invite')}</Button>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" className="accent-brand-600" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
                {t('settings.makeAdmin')}
              </label>
              <ErrorText error={invite.error} />
            </form>
          )}
        </div>
      )}
    </Card>
  );
}

function TimeOffList({ tenantId, staff }: { tenantId: string; staff: { id: string; name: string }[] }) {
  const staffIds = staff.map((s) => s.id);
  const { t, i18n } = useTranslation();
  const { info } = useApp();
  const refresh = useRefresh();
  const today = todayIn(info.tenant.timezone);
  const to = addDays(today, 365);
  const list = useQuery({ queryKey: ['timeoff', tenantId, today, to, 'all'], queryFn: () => get<TimeOff[]>(`/t/${tenantId}/time-off?from=${today}&to=${to}`) });
  const [form, setForm] = useState({ staffId: staffIds[0] ?? '', startDate: today, endDate: today, reason: '' });
  const add = useMutation({
    mutationFn: () => post(`/t/${tenantId}/time-off`, { ...form, kind: 'day_off', reason: form.reason || undefined }),
    onSuccess: () => refresh('timeoff', 'availability', 'slots'),
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/t/${tenantId}/time-off/${id}`), onSuccess: () => refresh('timeoff', 'availability', 'slots') });
  const days = (list.data ?? []).filter((o) => o.kind === 'day_off' && staffIds.includes(o.staffId));

  return (
    <Section title={t('settings.timeOff')}>
      {days.length === 0 ? (
        <p className="text-sm text-slate-500">{t('settings.noTimeOff')}</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {days.map((o) => (
            <li key={o.id} className="flex items-center justify-between py-2">
              <span>
                <span className="font-medium">{o.staffName}</span> · {formatDay(o.localStart.slice(0, 10), i18n.language, { day: 'numeric', month: 'short' })}
                {addDays(o.localEnd.slice(0, 10), -1) !== o.localStart.slice(0, 10) && ` – ${formatDay(addDays(o.localEnd.slice(0, 10), -1), i18n.language, { day: 'numeric', month: 'short' })}`}
                {o.reason && <span className="text-slate-500"> · {o.reason}</span>}
              </span>
              <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => remove.mutate(o.id)}>✕</Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2 sm:grid-cols-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        {staffIds.length > 1 && (
          <Select aria-label={t('appt.staff')} value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Input type="date" aria-label={t('appt.from')} required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} />
        <Input type="date" aria-label={t('appt.to')} required min={form.startDate} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
        <Input placeholder={t('appt.blockReason')} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        <Button type="submit" variant="secondary" loading={add.isPending}>{t('settings.addDayOff')}</Button>
      </form>
      <ErrorText error={add.error} />
    </Section>
  );
}

function StaffTab() {
  const { t } = useTranslation();
  const { tenantId, isManager, info } = useApp();
  const refresh = useRefresh();
  const staff = useQuery({ queryKey: ['staff', tenantId], queryFn: () => get<Staff[]>(`/t/${tenantId}/staff`) });
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => post(`/t/${tenantId}/staff`, { name, sort: staff.data?.length ?? 0 }),
    onSuccess: async () => {
      setName('');
      await refresh('staff', 'tenant', 'public');
    },
  });
  const mine = info.membership.staffId;
  const visible = (staff.data ?? []).filter((s) => isManager || s.id === mine);

  return (
    <div className="space-y-4">
      {visible.map((s) => (
        <StaffCard key={s.id} s={s} tenantId={tenantId} isManager={isManager} canEdit={isManager || s.id === mine} />
      ))}
      {isManager && (
        <Card>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div className="min-w-48 flex-1">
              <Input label={t('settings.newStaff')} required placeholder={t('settings.staffName')} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button type="submit" variant="secondary" loading={add.isPending}>+ {t('common.add')}</Button>
          </form>
          <p className="mt-2 text-xs text-slate-500">{info.usage.activeStaff} / {info.usage.staffLimit}</p>
          <ErrorText error={add.error} />
        </Card>
      )}
      {visible.length > 0 && <TimeOffList tenantId={tenantId} staff={visible} />}
    </div>
  );
}

// ── Billing ──────────────────────────────────────────────────────────────────

function BillingTab() {
  const { t, i18n } = useTranslation();
  const { info, tenantId, me } = useApp();
  const [params] = useSearchParams();
  const refresh = useRefresh();
  const qc = useQueryClient();
  useEffect(() => {
    if (params.get('upgraded') || params.get('cancelled')) void qc.invalidateQueries({ queryKey: ['tenant'] });
  }, [params, qc]);
  const go = (path: string, body?: object) =>
    post<{ url: string }>(path, body).then(async (r) => {
      if (r.url.startsWith('/')) {
        await refresh('tenant', 'me', 'public');
      } else {
        window.location.href = r.url;
      }
    });
  const checkout = useMutation({ mutationFn: (interval: 'month' | 'year') => go(`/t/${tenantId}/billing/checkout`, { interval }) });
  const portal = useMutation({ mutationFn: () => go(`/t/${tenantId}/billing/portal`) });
  const { plan, usage } = info;
  const dev = me.config.billingMode === 'dev';
  const tz = info.tenant.timezone;
  const pct = usage.bookingLimit ? Math.min(100, (usage.bookingsThisMonth / usage.bookingLimit) * 100) : 0;
  const planLabel = plan.rawPlan === 'founding' ? t('billing.planFounding') : plan.plan === 'pro' ? t('billing.planPro') : t('billing.planFree');

  return (
    <div className="space-y-4">
      {params.get('upgraded') && plan.plan === 'pro' && <Alert tone="green">{t('billing.upgraded')}</Alert>}
      {plan.status === 'past_due' && <Alert tone="red">{t('billing.pastDue')}</Alert>}
      {dev && <Alert>{t('billing.devMode')}</Alert>}
      <Section title={t('billing.currentPlan')} aside={<Badge tone={plan.plan === 'pro' ? 'brand' : 'slate'}>{planLabel}</Badge>}>
        {plan.rawPlan === 'founding' && plan.foundingUntil && (
          <p className="text-sm text-slate-600">{t('billing.foundingNote', { date: formatInstant(plan.foundingUntil, tz, i18n.language, { dateStyle: 'long' }) })}</p>
        )}
        {plan.plan === 'pro' && plan.currentPeriodEnd && plan.rawPlan !== 'founding' && (
          <p className="text-sm text-slate-600">{t('billing.renews', { date: formatInstant(plan.currentPeriodEnd, tz, i18n.language, { dateStyle: 'long' }) })}</p>
        )}
        <div>
          <div className="flex justify-between text-sm">
            <span>{t('billing.usage')}</span>
            <span className="font-semibold">{usage.bookingsThisMonth} / {usage.bookingLimit ?? t('billing.unlimited')}</span>
          </div>
          {usage.bookingLimit !== null && (
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={usage.bookingsThisMonth} aria-valuemax={usage.bookingLimit}>
              <div className={cx('h-full rounded-full', pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <div className="flex justify-between text-sm">
          <span>{t('billing.staffUsage')}</span>
          <span className="font-semibold">{usage.activeStaff} / {usage.staffLimit}</span>
        </div>
        {plan.plan === 'free' ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Button loading={checkout.isPending && checkout.variables === 'month'} onClick={() => checkout.mutate('month')}>{t('billing.upgradeMonthly')}</Button>
            <Button variant="secondary" loading={checkout.isPending && checkout.variables === 'year'} onClick={() => checkout.mutate('year')}>{t('billing.upgradeYearly')}</Button>
          </div>
        ) : (
          plan.rawPlan !== 'founding' && (
            <Button variant="secondary" loading={portal.isPending} onClick={() => portal.mutate()}>{dev ? t('billing.devCancel') : t('billing.manage')}</Button>
          )
        )}
        <ErrorText error={checkout.error ?? portal.error} />
        <p className="text-xs text-slate-500">{t('billing.noLockIn')}</p>
      </Section>
    </div>
  );
}

// ── Notifications & account ──────────────────────────────────────────────────

function NotificationsTab() {
  const { t } = useTranslation();
  const { me, info } = useApp();
  const [state, setState] = useState<'unknown' | 'on' | 'off' | 'denied' | 'unsupported'>('unknown');
  useEffect(() => {
    if (!pushSupported()) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('denied');
    void currentPushSubscription().then((s) => setState(s ? 'on' : 'off'));
  }, []);
  const enable = useMutation({
    mutationFn: () => enablePush(me.config.vapidPublicKey),
    onSuccess: (ok) => setState(ok ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off'),
  });
  const test = useMutation({ mutationFn: () => post('/push/test') });
  return (
    <Section title={t('settings.pushTitle')}>
      <p className="text-sm text-slate-600">{t('settings.emailAlways')}</p>
      {!info.plan.limits.push ? (
        <Alert tone="brand">{t('settings.pushPro')}</Alert>
      ) : (
        <>
          <p className="text-sm text-slate-600">{t('settings.pushBody')}</p>
          {state === 'unsupported' && <Alert>{t('settings.pushUnsupported')}</Alert>}
          {state === 'denied' && <Alert tone="red">{t('settings.pushDenied')}</Alert>}
          {state === 'off' && <Button loading={enable.isPending} onClick={() => enable.mutate()}>{t('settings.pushEnable')}</Button>}
          {state === 'on' && (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-emerald-700">✓ {t('settings.pushEnabled')}</span>
              <Button size="sm" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>{t('settings.pushTest')}</Button>
            </div>
          )}
          <ErrorText error={enable.error ?? test.error} />
        </>
      )}
    </Section>
  );
}

function AccountTab() {
  const { t, i18n } = useTranslation();
  const { me } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(me.user?.name ?? '');
  const [confirm, setConfirm] = useState(false);
  const save = useMutation({ mutationFn: () => patch('/me', { name, locale: i18n.language === 'el' ? 'el' : 'en' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
  const remove = useMutation({
    mutationFn: () => del('/me'),
    onSuccess: () => {
      qc.clear();
      navigate('/');
    },
  });
  return (
    <div className="space-y-4">
      <Section title={t('settings.account')}>
        <p className="text-sm text-slate-500">{me.user?.email}</p>
        <Input label={t('settings.yourName')} value={name} onChange={(e) => setName(e.target.value)} />
        <Select label={t('common.language')} value={i18n.language} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </Select>
        <Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
      </Section>
      <Section title={t('settings.dangerZone')}>
        {confirm ? (
          <div className="space-y-2">
            <p className="text-sm text-red-900">{t('settings.deleteAccountConfirm')}</p>
            <div className="flex gap-2">
              <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>{t('settings.deleteAccount')}</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirm(true)}>{t('settings.deleteAccount')}</Button>
        )}
      </Section>
    </div>
  );
}

export default function Settings() {
  const { t } = useTranslation();
  const { isManager } = useApp();
  const { tab } = useParams();
  const tabs = [
    ...(isManager ? [{ key: 'business', label: t('settings.business') }, { key: 'services', label: t('settings.services') }] : []),
    { key: 'staff', label: isManager ? t('settings.staff') : t('settings.workingHours') },
    ...(isManager ? [{ key: 'billing', label: t('settings.billing') }] : []),
    { key: 'notifications', label: t('settings.notifications') },
    { key: 'account', label: t('settings.account') },
  ];
  const active = tabs.find((x) => x.key === tab)?.key ?? tabs[0]!.key;
  const { tenantId } = useApp();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-3 text-2xl font-bold">{t('settings.title')}</h1>
      <nav className="no-scrollbar -mx-4 mb-4 flex gap-1 overflow-x-auto px-4">
        {tabs.map((x) => (
          <NavLink
            key={x.key}
            to={`/app/settings/${x.key}`}
            className={cx('shrink-0 rounded-full px-3 py-1.5 text-sm font-medium', active === x.key ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200')}
          >
            {x.label}
          </NavLink>
        ))}
      </nav>
      {active === 'business' && <BusinessTab />}
      {active === 'services' && <ServicesEditor tenantId={tenantId} />}
      {active === 'staff' && <StaffTab />}
      {active === 'billing' && <BillingTab />}
      {active === 'notifications' && <NotificationsTab />}
      {active === 'account' && <AccountTab />}
    </div>
  );
}
