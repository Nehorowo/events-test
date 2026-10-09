import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { HoursEditor, hoursValid, ServicesEditor } from '../components/editors';
import { ShareCard } from '../components/ShareCard';
import { Button, Card, ErrorText, Input, PageSpinner, Select } from '../components/ui';
import { get, patch, post, put } from '../lib/api';
import { storeTenantId, useCurrentMembership, useTenantInfo } from '../lib/session';
import type { HoursRow, Service, Staff } from '../lib/types';

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Nicosia';

function StepBusiness({ onDone }: { onDone: (tenantId: string) => void }) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [timezone, setTimezone] = useState(browserTz);
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const effectiveSlug = slugTouched ? slug : slugify(name);
  const zones = useQuery({ queryKey: ['timezones'], queryFn: () => get<string[]>('/timezones'), staleTime: Infinity });
  const available = useQuery({
    queryKey: ['slug', effectiveSlug],
    queryFn: () => get<{ available: boolean }>(`/slug-available/${effectiveSlug}`),
    enabled: effectiveSlug.length >= 3,
  });
  const create = useMutation({
    mutationFn: () =>
      post<{ id: string }>('/tenants', {
        name, slug: effectiveSlug, timezone, address: address || null, phone: phone || null,
        locale: i18n.language === 'el' ? 'el' : 'en',
      }),
    onSuccess: (r) => onDone(r.id),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h1 className="text-2xl font-bold">{t('onboarding.businessTitle')}</h1>
      <Input label={t('onboarding.businessName')} placeholder={t('onboarding.businessNamePh')} required maxLength={80} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      <div className="space-y-1.5">
        <label htmlFor="slug" className="block text-sm font-medium text-slate-700">{t('onboarding.slug')}</label>
        <div className="flex items-center rounded-lg border border-slate-300 bg-white focus-within:ring-2 focus-within:ring-brand-500/30">
          <span className="pl-3 text-sm text-slate-500">{location.host}/</span>
          <input
            id="slug"
            required
            pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
            }}
            className="min-w-0 flex-1 rounded-r-lg bg-transparent py-2.5 pr-3 text-base focus:outline-none sm:text-sm"
          />
        </div>
        {effectiveSlug.length >= 3 && available.data && (
          <p className={available.data.available ? 'text-xs text-emerald-700' : 'text-xs text-red-600'}>
            {available.data.available ? `✓ ${t('onboarding.slugOk')}` : t('onboarding.slugTaken')}
          </p>
        )}
      </div>
      <Select label={t('onboarding.timezone')} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
        {(zones.data ?? [timezone]).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
      </Select>
      <Input label={<>{t('onboarding.address')} <span className="font-normal text-slate-400">({t('common.optional')})</span></>} autoComplete="street-address" value={address} onChange={(e) => setAddress(e.target.value)} />
      <Input label={<>{t('onboarding.phone')} <span className="font-normal text-slate-400">({t('common.optional')})</span></>} type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <ErrorText error={create.error} />
      <Button type="submit" size="lg" loading={create.isPending} disabled={available.data?.available === false}>{t('common.continue')}</Button>
    </form>
  );
}

function StepHours({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const staff = useQuery({ queryKey: ['staff', tenantId], queryFn: () => get<Staff[]>(`/t/${tenantId}/staff`) });
  const me = staff.data?.[0];
  const [hours, setHours] = useState<HoursRow[] | null>(null);
  useEffect(() => {
    if (me && !hours) setHours(me.hours);
  }, [me, hours]);
  const save = useMutation({ mutationFn: () => put(`/t/${tenantId}/staff/${me!.id}/hours`, hours), onSuccess: onDone });
  if (!hours) return <PageSpinner />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('onboarding.hoursTitle')}</h1>
      <p className="text-slate-600">{t('onboarding.hoursHint')}</p>
      <HoursEditor value={hours} onChange={setHours} />
      <ErrorText error={save.error} />
      <Button size="lg" loading={save.isPending} disabled={!hoursValid(hours) || hours.length === 0} onClick={() => save.mutate()}>{t('common.continue')}</Button>
    </div>
  );
}

function StepShare({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const info = useTenantInfo(tenantId);
  const publish = useMutation({
    mutationFn: () => patch(`/t/${tenantId}`, { published: true, onboardingDone: true }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tenant', tenantId] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  useEffect(() => {
    if (info.data && !info.data.tenant.onboardingDone && publish.isIdle) publish.mutate();
  }, [info.data, publish]);
  if (!info.data) return <PageSpinner />;
  return (
    <div className="space-y-5">
      <div className="text-4xl" aria-hidden="true">🎉</div>
      <h1 className="text-2xl font-bold">{t('onboarding.shareTitle')}</h1>
      <p className="text-slate-600">{t('onboarding.shareHint')}</p>
      <ShareCard url={info.data.bookingUrl} slug={info.data.tenant.slug} />
      <ErrorText error={publish.error} />
      <Button size="lg" onClick={() => navigate('/app')}>{t('onboarding.goToCalendar')}</Button>
    </div>
  );
}

export default function Onboarding() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { me, current } = useCurrentMembership();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);

  // Resume where the owner left off.
  useEffect(() => {
    if (step !== null || me.isLoading) return;
    if (current && current.role !== 'staff') {
      setTenantId(current.tenantId);
      setStep(current.onboardingDone ? 4 : 2);
    } else {
      setStep(1);
    }
  }, [me.isLoading, current, step]);

  const services = useQuery({
    queryKey: ['services', tenantId],
    queryFn: () => get<Service[]>(`/t/${tenantId}/services`),
    enabled: Boolean(tenantId),
  });

  if (step === null) return <PageSpinner />;

  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <img src="/icons/icon.svg" alt="" className="h-8 w-8" />
        <div className="flex flex-1 gap-1.5" aria-label={t('onboarding.step', { n: step })}>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={`h-1.5 flex-1 rounded-full ${n <= step ? 'bg-brand-600' : 'bg-slate-200'}`} />
          ))}
        </div>
        <span className="text-xs text-slate-500">{t('onboarding.step', { n: step })}</span>
      </div>
      <Card>
        {step === 1 && (
          <StepBusiness
            onDone={async (id) => {
              storeTenantId(id);
              setTenantId(id);
              await qc.invalidateQueries({ queryKey: ['me'] });
              setStep(2);
            }}
          />
        )}
        {step === 2 && tenantId && (
          <div className="space-y-4">
            <h1 className="text-2xl font-bold">{t('onboarding.servicesTitle')}</h1>
            <p className="text-slate-600">{t('onboarding.servicesHint')}</p>
            <ServicesEditor tenantId={tenantId} compact />
            <Button size="lg" disabled={!services.data?.length} onClick={() => setStep(3)}>{t('common.continue')}</Button>
          </div>
        )}
        {step === 3 && tenantId && <StepHours tenantId={tenantId} onDone={() => setStep(4)} />}
        {step === 4 && tenantId && <StepShare tenantId={tenantId} />}
      </Card>
      {step === 3 && (
        <button type="button" className="mt-4 text-sm text-slate-500" onClick={() => setStep(step - 1)}>‹ {t('common.back')}</button>
      )}
    </main>
  );
}
