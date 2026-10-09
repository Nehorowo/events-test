import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, NavLink, Outlet, useNavigate, useOutletContext } from 'react-router';
import { USAGE_WARNING_RATIO } from '../../../../shared/plans';
import { Alert, Button, cx, PageSpinner } from '../../components/ui';
import { post } from '../../lib/api';
import { storeTenantId, useCurrentMembership, useTenantInfo } from '../../lib/session';
import type { Me, TenantInfo } from '../../lib/types';

export interface AppContext {
  info: TenantInfo;
  tenantId: string;
  me: Me;
  isManager: boolean;
}

export function useApp() {
  return useOutletContext<AppContext>();
}

const icons = {
  today: 'M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  calendar: 'M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  clients: 'M17 20h5v-1a4 4 0 0 0-6-3.5M17 20H7m10 0v-1c0-.7-.1-1.3-.4-1.9M7 20H2v-1a4 4 0 0 1 6-3.5M7 20v-1c0-.7.1-1.3.4-1.9m0 0a5 5 0 0 1 9.2 0M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  settings: 'M10.3 4.3c.4-1.8 3-1.8 3.4 0a1.7 1.7 0 0 0 2.6 1.1c1.5-.9 3.3.8 2.4 2.4a1.7 1.7 0 0 0 1 2.5c1.9.5 1.9 3.1 0 3.6a1.7 1.7 0 0 0-1 2.5c.9 1.6-.9 3.3-2.4 2.4a1.7 1.7 0 0 0-2.6 1c-.4 1.9-3 1.9-3.4 0a1.7 1.7 0 0 0-2.6-1c-1.5.9-3.3-.8-2.4-2.4a1.7 1.7 0 0 0-1-2.5c-1.9-.5-1.9-3.1 0-3.6a1.7 1.7 0 0 0 1-2.5c-.9-1.6.9-3.3 2.4-2.4 1 .6 2.3.1 2.6-1.1zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

function InstallPrompt() {
  const { t } = useTranslation();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('install-dismissed') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (dismissed || standalone || (!deferred && !ios)) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem('install-dismissed', '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-brand-100 bg-brand-50 p-3 text-sm">
      <img src="/icons/icon-192.png" alt="" className="h-10 w-10 rounded-lg" />
      <div className="flex-1">
        <p className="font-semibold text-brand-700">{t('install.title')}</p>
        <p className="text-slate-600">{ios && !deferred ? t('install.ios') : t('install.body')}</p>
        <div className="mt-2 flex gap-2">
          {deferred && <Button size="sm" onClick={() => deferred.prompt().then(dismiss)}>{t('install.button')}</Button>}
          <Button size="sm" variant="ghost" onClick={dismiss}>{t('install.dismiss')}</Button>
        </div>
      </div>
    </div>
  );
}

function UsageBanner({ info }: { info: TenantInfo }) {
  const { t } = useTranslation();
  const { bookingsThisMonth: used, bookingLimit: limit } = info.usage;
  if (limit === null || used < limit * USAGE_WARNING_RATIO) return null;
  const reached = used >= limit;
  return (
    <div className="mb-4">
      <Alert tone={reached ? 'red' : 'amber'}>
        <p>{reached ? t('usage.reached', { limit }) : t('usage.warning', { used, limit })}</p>
        <Link to="/app/settings/billing" className="mt-1 inline-block font-semibold underline">{t('usage.upgrade')}</Link>
      </Alert>
    </div>
  );
}

export default function AppLayout() {
  const { t } = useTranslation();
  const { me, current } = useCurrentMembership();
  const info = useTenantInfo(current?.tenantId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => post('/auth/logout'),
    onSuccess: () => {
      qc.clear();
      navigate('/');
    },
  });

  if (me.isLoading) return <PageSpinner />;
  if (!current) return <Navigate to="/onboarding" replace />;
  if (!current.onboardingDone && current.role === 'owner') return <Navigate to="/onboarding" replace />;
  if (info.isLoading || !info.data) return <PageSpinner />;

  const isManager = current.role !== 'staff';
  const nav = [
    { to: '/app', end: true, label: t('nav.today'), icon: icons.today },
    { to: '/app/calendar', label: t('nav.calendar'), icon: icons.calendar },
    ...(isManager ? [{ to: '/app/clients', label: t('nav.clients'), icon: icons.clients }] : []),
    { to: '/app/settings', label: t('nav.settings'), icon: icons.settings },
  ];
  const memberships = me.data?.memberships ?? [];
  const ctx: AppContext = { info: info.data, tenantId: current.tenantId, me: me.data!, isManager };

  return (
    <div className="min-h-dvh pb-20 sm:pb-0">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <img src="/icons/icon.svg" alt="" className="h-8 w-8" />
          {memberships.length > 1 ? (
            <select
              aria-label="Business"
              className="min-w-0 rounded-lg border-none bg-transparent font-semibold focus:ring-2 focus:ring-brand-500/30"
              value={current.tenantId}
              onChange={(e) => {
                storeTenantId(e.target.value);
                void qc.invalidateQueries();
                navigate('/app');
              }}
            >
              {memberships.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.name}</option>)}
            </select>
          ) : (
            <span className="truncate font-semibold">{info.data.tenant.name}</span>
          )}
          <nav className="ml-6 hidden gap-1 sm:flex">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a href={`/${info.data.tenant.slug}`} target="_blank" rel="noreferrer" className="hidden rounded-lg px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50 sm:block">
              {t('nav.viewPage')} ↗
            </a>
            <button type="button" onClick={() => logout.mutate()} className="rounded-lg px-2 py-2 text-sm text-slate-500 hover:bg-slate-100">
              {t('common.signOut')}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-4">
        <InstallPrompt />
        {isManager && <UsageBanner info={info.data} />}
        <Outlet context={ctx} />
      </main>

      <nav className="pb-safe fixed inset-x-0 bottom-0 z-20 grid border-t border-slate-200 bg-white sm:hidden" style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('flex flex-col items-center gap-0.5 pt-2 text-[11px] font-medium', isActive ? 'text-brand-700' : 'text-slate-500')}>
            <Icon d={n.icon} />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
