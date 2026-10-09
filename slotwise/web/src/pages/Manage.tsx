import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import SlotPicker from '../components/SlotPicker';
import { Alert, Avatar, Button, Card, ErrorText, PageSpinner } from '../components/ui';
import { get, post } from '../lib/api';
import { formatDuration, formatInstant, formatMoney } from '../lib/dates';
import type { PublicPage } from '../lib/types';
import { accentStyle, PageFooter, useTenantLanguage } from './Booking';

interface Managed {
  id: string;
  serviceId: string | null;
  staffId: string;
  serviceName: string;
  priceCents: number;
  currency: string;
  startsAt: string;
  endsAt: string;
  status: string;
  clientName: string;
  staffName: string;
  slug: string;
  tenantName: string;
  timezone: string;
  address: string | null;
  tenantPhone: string | null;
  locale: string;
  upcoming: boolean;
}

/** Client self-service from the email link: no account needed. */
export default function Manage() {
  const { token = '' } = useParams();
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'view' | 'reschedule' | 'confirmCancel'>('view');
  const [notice, setNotice] = useState<string | null>(null);

  const appt = useQuery({ queryKey: ['manage', token], queryFn: () => get<Managed>(`/public/manage/${token}`) });
  const page = useQuery({
    queryKey: ['public', appt.data?.slug],
    queryFn: () => get<PublicPage>(`/public/${appt.data!.slug}`),
    enabled: Boolean(appt.data),
  });
  useTenantLanguage(appt.data?.locale);

  const cancel = useMutation({
    mutationFn: () => post(`/public/manage/${token}/cancel`),
    onSuccess: () => {
      setNotice(t('manage.cancelledDone'));
      setMode('view');
      void qc.invalidateQueries({ queryKey: ['manage', token] });
    },
  });
  const reschedule = useMutation({
    mutationFn: (startsAt: string) => post<{ manageToken: string }>(`/public/manage/${token}/reschedule`, { startsAt }),
    onSuccess: (r) => {
      setNotice(t('manage.rescheduled'));
      setMode('view');
      navigate(`/m/${r.manageToken}`, { replace: true });
    },
  });

  if (appt.isLoading) return <PageSpinner />;
  if (!appt.data) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <Alert tone="red">{t('errors.link_invalid')}</Alert>
      </main>
    );
  }
  const a = appt.data;
  const lang = i18n.language;
  const cancelled = a.status === 'cancelled';
  const active = a.status === 'confirmed' && a.upcoming;

  return (
    <div style={accentStyle(page.data?.tenant.brandColor)} className="min-h-dvh">
      <main className="mx-auto max-w-lg px-4 pt-6">
        <header className="flex items-center gap-3">
          <Avatar name={a.tenantName} src={page.data?.tenant.logoData} size={52} />
          <div>
            <h1 className="text-xl font-bold">{a.tenantName}</h1>
            {a.address && <p className="text-sm text-slate-500">{a.address}</p>}
          </div>
        </header>

        <h2 className="mt-6 text-lg font-semibold">{t('manage.title')}</h2>
        {notice && <div className="mt-3"><Alert tone="green">{notice}</Alert></div>}

        <Card className="mt-3">
          <p className={cancelled ? 'font-semibold text-slate-400 line-through' : 'font-semibold'}>{a.serviceName}</p>
          <p className="text-sm text-slate-500">
            {formatDuration((new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60000, lang)} · {a.staffName}
            {a.priceCents > 0 && ` · ${formatMoney(a.priceCents, a.currency, lang)}`}
          </p>
          <p className="accent-text mt-2 text-lg font-bold">
            {formatInstant(a.startsAt, a.timezone, lang, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
          </p>
          {cancelled && <p className="mt-2 text-sm font-medium text-red-700">{t('manage.cancelled')}</p>}
          {!cancelled && !a.upcoming && <p className="mt-2 text-sm text-slate-500">{t('manage.past')}</p>}
        </Card>

        {active && mode === 'view' && (
          <div className="mt-4 grid gap-2">
            <a href={`/api/public/manage/${token}/ics`} className="accent-bg rounded-lg px-4 py-3 text-center font-semibold">
              {t('booking.addToCalendar')}
            </a>
            {a.serviceId && (
              <Button variant="secondary" size="lg" onClick={() => setMode('reschedule')}>
                {t('manage.reschedule')}
              </Button>
            )}
            <Button variant="danger" size="lg" onClick={() => setMode('confirmCancel')}>
              {t('manage.cancel')}
            </Button>
            {a.tenantPhone && (
              <a href={`tel:${a.tenantPhone}`} className="mt-2 text-center text-sm text-slate-600 underline">{a.tenantPhone}</a>
            )}
          </div>
        )}

        {active && mode === 'confirmCancel' && (
          <Card className="mt-4">
            <p className="font-medium">{t('manage.cancelConfirm')}</p>
            <ErrorText error={cancel.error} />
            <div className="mt-4 flex gap-2">
              <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('manage.cancel')}</Button>
              <Button variant="ghost" onClick={() => setMode('view')}>{t('manage.keep')}</Button>
            </div>
          </Card>
        )}

        {active && mode === 'reschedule' && a.serviceId && page.data && (
          <section className="mt-4">
            <button type="button" onClick={() => setMode('view')} className="mb-3 text-sm font-medium text-slate-600">‹ {t('common.back')}</button>
            <h3 className="mb-3 font-semibold">{t('manage.reschedule')}</h3>
            <ErrorText error={reschedule.error} />
            <SlotPicker
              slug={a.slug}
              serviceId={a.serviceId}
              staffId={page.data.staff.some((s) => s.id === a.staffId) ? a.staffId : null}
              timezone={a.timezone}
              maxDaysAhead={page.data.tenant.maxDaysAhead}
              ignoreToken={token}
              onPick={(slot) => reschedule.mutate(slot.startsAt)}
            />
            {reschedule.isPending && <p className="mt-3 text-sm text-slate-500">{t('common.loading')}</p>}
          </section>
        )}

        {(cancelled || !a.upcoming) && (
          <Link to={`/${a.slug}`} className="accent-bg mt-4 block rounded-lg px-4 py-3 text-center font-semibold">
            {t('manage.bookAgain')}
          </Link>
        )}

        <PageFooter badge={page.data?.badge ?? false} />
      </main>
    </div>
  );
}
