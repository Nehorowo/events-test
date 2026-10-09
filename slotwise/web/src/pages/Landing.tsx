import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { setLang } from '../i18n';
import { useMe } from '../lib/session';

function Check() {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" fill="currentColor" aria-hidden="true">
      <path d="M7.7 13.3 4.4 10 3 11.4l4.7 4.7L17 6.8l-1.4-1.4z" />
    </svg>
  );
}

export default function Landing() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const signedIn = Boolean(me.data?.user);

  return (
    <div className="min-h-dvh bg-white">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <span className="flex items-center gap-2 text-lg font-bold">
          <img src="/icons/icon.svg" alt="" className="h-8 w-8" /> Slotwise
        </span>
        <nav className="flex items-center gap-3 text-sm">
          <button type="button" className="text-slate-600" onClick={() => setLang(i18n.language === 'el' ? 'en' : 'el')}>
            {i18n.language === 'el' ? 'EN' : 'ΕΛ'}
          </button>
          <Link to={signedIn ? '/app' : '/login'} className="rounded-lg px-3 py-2 font-semibold text-brand-700 hover:bg-brand-50">
            {signedIn ? 'Dashboard' : t('landing.signIn')}
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-3xl px-4 pb-12 pt-10 text-center sm:pt-16">
          <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">{t('landing.tagline')}</h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-600">{t('landing.sub')}</p>
          <Link
            to={signedIn ? '/app' : '/login'}
            className="mt-8 inline-block rounded-xl bg-brand-600 px-6 py-4 text-base font-semibold text-white shadow-lg shadow-brand-600/20 hover:bg-brand-700"
          >
            {t('landing.cta')}
          </Link>
        </section>

        <section className="mx-auto grid max-w-5xl gap-4 px-4 pb-16 sm:grid-cols-3">
          {([1, 2, 3] as const).map((n) => (
            <div key={n} className="rounded-2xl border border-slate-200 p-6">
              <h2 className="text-lg font-semibold">{t(`landing.promise${n}Title`)}</h2>
              <p className="mt-2 text-slate-600">{t(`landing.promise${n}`)}</p>
            </div>
          ))}
        </section>

        <section className="bg-slate-50 py-16" aria-labelledby="pricing">
          <div className="mx-auto max-w-4xl px-4">
            <h2 id="pricing" className="text-center text-3xl font-bold">{t('landing.pricingTitle')}</h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-6">
                <h3 className="text-lg font-semibold">{t('common.free')}</h3>
                <p className="mt-2 text-4xl font-extrabold">€0</p>
                <ul className="mt-6 space-y-2 text-sm text-slate-700">
                  {t('landing.freeFeatures').split('\n').map((f) => (
                    <li key={f} className="flex gap-2"><Check />{f}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border-2 border-brand-600 bg-white p-6">
                <h3 className="text-lg font-semibold text-brand-700">{t('common.pro')}</h3>
                <p className="mt-2 text-4xl font-extrabold">
                  €9<span className="text-base font-medium text-slate-500">{t('landing.perMonth')}</span>
                </p>
                <p className="text-sm text-slate-500">{t('landing.orYearly')}</p>
                <ul className="mt-6 space-y-2 text-sm text-slate-700">
                  {t('landing.proFeatures').split('\n').map((f) => (
                    <li key={f} className="flex gap-2"><Check />{f}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-6 text-center text-sm font-medium text-slate-700">{t('landing.noLockIn')}</p>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-5xl justify-between px-4 py-8 text-sm text-slate-500">
        <span>© Slotwise</span>
        <Link to="/privacy" className="underline">{t('landing.privacy')}</Link>
      </footer>
    </div>
  );
}
