import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import SlotPicker from '../components/SlotPicker';
import { Alert, Avatar, Button, cx, ErrorText, Input, PageSpinner, Textarea } from '../components/ui';
import { setLang } from '../i18n';
import { ApiError, get, post } from '../lib/api';
import { formatDay, formatDuration, formatInstant, formatMoney } from '../lib/dates';
import type { PublicPage, PublicService, Slot } from '../lib/types';

/** Accent colour + readable text colour for a tenant's brand. */
export function accentStyle(color: string | null | undefined): CSSProperties {
  const hex = color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#4f46e5';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  return { '--accent': hex, '--accent-contrast': lum > 0.45 ? '#0f172a' : '#ffffff' } as CSSProperties;
}

/**
 * Language precedence for visitors: their explicit choice, then their browser
 * language when we support it, then the business's language.
 */
export function useTenantLanguage(locale: string | undefined) {
  useEffect(() => {
    let chosen: string | null = null;
    try {
      chosen = localStorage.getItem('lang');
    } catch {
      /* ignore */
    }
    const browser = navigator.language?.slice(0, 2).toLowerCase();
    if (locale && !chosen && browser !== 'en' && browser !== 'el') setLang(locale, false);
  }, [locale]);
}

const DETAILS_KEY = 'booking-details';

function loadDetails() {
  try {
    return JSON.parse(localStorage.getItem(DETAILS_KEY) ?? '{}') as { name?: string; email?: string; phone?: string };
  } catch {
    return {};
  }
}

export function BusinessHeader({ page }: { page: PublicPage }) {
  const { tenant } = page;
  return (
    <header className="flex items-center gap-3">
      <Avatar name={tenant.name} src={tenant.logoData} size={52} />
      <div className="min-w-0">
        <h1 className="truncate text-xl font-bold">{tenant.name}</h1>
        {tenant.address && <p className="truncate text-sm text-slate-500">{tenant.address}</p>}
      </div>
    </header>
  );
}

export function PageFooter({ badge }: { badge: boolean }) {
  const { t, i18n } = useTranslation();
  return (
    <footer className="mt-10 flex flex-col items-center gap-3 pb-8 text-xs text-slate-500">
      <div className="flex gap-3">
        <button type="button" onClick={() => setLang(i18n.language === 'el' ? 'en' : 'el')} className="underline">
          {i18n.language === 'el' ? 'English' : 'Ελληνικά'}
        </button>
        <Link to="/privacy" className="underline">{t('booking.privacy')}</Link>
      </div>
      {badge && (
        <a href="/?utm_source=badge&utm_medium=booking_page" className="rounded-full border border-slate-200 bg-white px-3 py-1 font-medium text-slate-600">
          {t('common.poweredBy')}
        </a>
      )}
    </footer>
  );
}

type Step = 'service' | 'time' | 'details' | 'done';

export default function Booking() {
  const { slug = '' } = useParams();
  const { t, i18n } = useTranslation();
  const page = useQuery({
    queryKey: ['public', slug],
    queryFn: () => get<PublicPage>(`/public/${slug}`),
  });
  useTenantLanguage(page.data?.tenant.locale);

  const [step, setStep] = useState<Step>('service');
  const [service, setService] = useState<PublicService | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ slot: Slot; date: string } | null>(null);
  const [details, setDetails] = useState(() => ({ ...{ name: '', email: '', phone: '' }, ...loadDetails(), notes: '' }));
  const [result, setResult] = useState<{ manageToken: string } | null>(null);

  useEffect(() => window.scrollTo({ top: 0 }), [step]);

  const book = useMutation({
    mutationFn: () =>
      post<{ id: string; manageToken: string }>(`/public/${slug}/book`, {
        serviceId: service!.id,
        staffId,
        startsAt: slot!.slot.startsAt,
        name: details.name,
        email: details.email,
        phone: details.phone,
        notes: details.notes || undefined,
      }),
    onSuccess: (r) => {
      try {
        localStorage.setItem(DETAILS_KEY, JSON.stringify({ name: details.name, email: details.email, phone: details.phone }));
      } catch {
        /* ignore */
      }
      setResult(r);
      setStep('done');
    },
    onError: (err) => {
      // Someone else got the slot first: send the client back to the times.
      if (err instanceof ApiError && err.status === 409) {
        setSlot(null);
        setStep('time');
      }
    },
  });

  if (page.isLoading) return <PageSpinner />;
  if (page.error || !page.data) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="text-slate-600">{t('booking.notFound')}</p>
        <Link to="/" className="mt-4 inline-block text-brand-600 underline">Slotwise</Link>
      </main>
    );
  }

  const p = page.data;
  const tz = p.tenant.timezone;
  const multiStaff = p.staff.length > 1;
  const staffName = staffId ? p.staff.find((s) => s.id === staffId)?.name : t('common.anyone');

  const summary = service && (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{service.name}</p>
          <p className="text-slate-500">
            {formatDuration(service.durationMin, i18n.language)}
            {multiStaff && ` · ${staffName}`}
          </p>
          {slot && (
            <p className="mt-1 font-semibold accent-text">
              {formatDay(slot.date, i18n.language)}, {slot.slot.time}
            </p>
          )}
        </div>
        {service.priceCents > 0 && <p className="font-semibold">{formatMoney(service.priceCents, service.currency, i18n.language)}</p>}
      </div>
    </div>
  );

  const backButton = (to: Step) => (
    <button type="button" onClick={() => setStep(to)} className="mb-3 text-sm font-medium text-slate-600 hover:text-slate-900">
      ‹ {t('common.back')}
    </button>
  );

  return (
    <div style={accentStyle(p.tenant.brandColor)} className="min-h-dvh">
      <main className="mx-auto max-w-lg px-4 pt-6">
        <BusinessHeader page={p} />

        {!p.acceptingBookings ? (
          <div className="mt-8">
            <Alert>
              {!p.published ? t('booking.notLive') : t('booking.paused')}
              {p.tenant.phone && (
                <a href={`tel:${p.tenant.phone}`} className="mt-2 block font-semibold underline">{p.tenant.phone}</a>
              )}
            </Alert>
          </div>
        ) : step === 'service' ? (
          <section className="mt-6" aria-labelledby="h-service">
            <h2 id="h-service" className="mb-3 text-lg font-semibold">{t('booking.chooseService')}</h2>
            <ul className="space-y-2">
              {p.services.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setService(s);
                      setSlot(null);
                      setStep('time');
                    }}
                    className="accent-ring flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-slate-300"
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold">{s.name}</span>
                      {s.description && <span className="block truncate text-sm text-slate-500">{s.description}</span>}
                      <span className="text-sm text-slate-500">{formatDuration(s.durationMin, i18n.language)}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      {s.priceCents > 0 && <span className="block font-semibold">{formatMoney(s.priceCents, s.currency, i18n.language)}</span>}
                      <span className="accent-text text-xl">›</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : step === 'time' && service ? (
          <section className="mt-6" aria-labelledby="h-time">
            {backButton('service')}
            {summary}
            {multiStaff && (
              <div className="mt-5">
                <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('booking.chooseStaff')}</h2>
                <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
                  {[{ id: null as string | null, name: t('common.anyone') }, ...p.staff].map((s) => (
                    <button
                      key={s.id ?? 'any'}
                      type="button"
                      aria-pressed={staffId === s.id}
                      onClick={() => setStaffId(s.id)}
                      className={cx(
                        'accent-ring shrink-0 rounded-full border px-4 py-2 text-sm font-medium',
                        staffId === s.id ? 'accent-bg border-transparent' : 'border-slate-300 bg-white',
                      )}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <h2 id="h-time" className="mb-3 mt-5 text-lg font-semibold">{t('booking.chooseTime')}</h2>
            {book.error && <div className="mb-3"><ErrorText error={book.error} /></div>}
            <SlotPicker
              slug={slug}
              serviceId={service.id}
              staffId={staffId}
              timezone={tz}
              maxDaysAhead={p.tenant.maxDaysAhead}
              selected={slot?.slot.startsAt}
              onPick={(s, date) => {
                setSlot({ slot: s, date });
                book.reset();
                setStep('details');
              }}
            />
          </section>
        ) : step === 'details' && service && slot ? (
          <section className="mt-6" aria-labelledby="h-details">
            {backButton('time')}
            {summary}
            <h2 id="h-details" className="mb-3 mt-5 text-lg font-semibold">{t('booking.yourDetails')}</h2>
            <form
              className="space-y-4"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                book.mutate();
              }}
            >
              <Input label={t('booking.name')} required autoComplete="name" value={details.name} maxLength={80}
                onChange={(e) => setDetails({ ...details, name: e.target.value })} />
              <Input label={t('booking.phone')} required type="tel" autoComplete="tel" inputMode="tel" value={details.phone} minLength={6} maxLength={40}
                onChange={(e) => setDetails({ ...details, phone: e.target.value })} />
              <Input label={t('booking.email')} hint={t('booking.emailHint')} required type="email" autoComplete="email" value={details.email}
                onChange={(e) => setDetails({ ...details, email: e.target.value })} />
              <Textarea label={<>{t('booking.notes')} <span className="font-normal text-slate-400">({t('common.optional')})</span></>} value={details.notes} maxLength={500} rows={2}
                onChange={(e) => setDetails({ ...details, notes: e.target.value })} />
              {/* Honeypot: hidden from people, tempting to bots. */}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
              <ErrorText error={book.error} />
              <Button type="submit" variant="accent" size="lg" loading={book.isPending}>
                {book.isPending ? t('booking.booking') : t('booking.confirm')}
              </Button>
              <p className="text-center text-xs text-slate-500">{t('booking.noAccount')}</p>
            </form>
          </section>
        ) : step === 'done' && result && service && slot ? (
          <section className="mt-8 text-center" aria-live="polite">
            <div className="accent-bg mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl">✓</div>
            <h2 className="mt-4 text-2xl font-bold">{t('booking.confirmedTitle')}</h2>
            <p className="mt-2 text-slate-600">{t('booking.confirmedBody', { email: details.email })}</p>
            <div className="mt-6 text-left">{summary}</div>
            <p className="mt-2 text-xs text-slate-500">
              {formatInstant(slot.slot.startsAt, tz, i18n.language, { timeZoneName: 'short', hour: '2-digit', minute: '2-digit' })}
            </p>
            <div className="mt-6 grid gap-2">
              <a href={`/api/public/manage/${result.manageToken}/ics`} className="accent-bg rounded-lg px-4 py-3 font-semibold">
                {t('booking.addToCalendar')}
              </a>
              <Link to={`/m/${result.manageToken}`} className="rounded-lg border border-slate-300 bg-white px-4 py-3 font-semibold">
                {t('booking.manage')}
              </Link>
              <button
                type="button"
                className="mt-2 text-sm text-slate-600 underline"
                onClick={() => {
                  setService(null);
                  setSlot(null);
                  setResult(null);
                  setStep('service');
                }}
              >
                {t('booking.bookAnother')}
              </button>
            </div>
          </section>
        ) : null}

        <PageFooter badge={p.badge} />
      </main>
    </div>
  );
}
