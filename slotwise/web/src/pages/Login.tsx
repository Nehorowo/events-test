import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Alert, Button, Card, ErrorText, Input } from '../components/ui';
import { post } from '../lib/api';
import { useMe } from '../lib/session';

export default function Login() {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const redirect = params.get('redirect') ?? '/app';
  const error = params.get('error');
  const me = useMe();
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: () => post('/auth/magic-link', { email, redirect, locale: i18n.language }) });

  if (me.data?.user) return <Navigate to={redirect} replace />;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <Link to="/" className="mb-6 flex items-center justify-center gap-2 text-xl font-bold">
        <img src="/icons/icon.svg" alt="" className="h-9 w-9" /> Slotwise
      </Link>
      <Card>
        {send.isSuccess ? (
          <div className="space-y-3 text-center">
            <div className="text-4xl" aria-hidden="true">✉️</div>
            <h1 className="text-xl font-semibold">{t('login.checkTitle')}</h1>
            <p className="text-slate-600">{t('login.checkBody', { email })}</p>
            <Button variant="ghost" onClick={() => send.reset()}>{t('login.useOther')}</Button>
          </div>
        ) : (
          <div className="space-y-5">
            <h1 className="text-xl font-semibold">{t('login.title')}</h1>
            {error && <Alert tone="red">{t(`errors.${error}`, { defaultValue: t('errors.generic') })}</Alert>}
            {me.data?.config.googleEnabled && (
              <>
                <a
                  href={`/api/auth/google?redirect=${encodeURIComponent(redirect)}`}
                  className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-4 py-3 font-semibold hover:bg-slate-50"
                >
                  <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
                  {t('login.google')}
                </a>
                <div className="flex items-center gap-3 text-xs uppercase text-slate-400">
                  <span className="h-px flex-1 bg-slate-200" />{t('common.or')}<span className="h-px flex-1 bg-slate-200" />
                </div>
              </>
            )}
            <form
              className="space-y-3"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                send.mutate();
              }}
            >
              <Input label={t('login.emailLabel')} type="email" required autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              <ErrorText error={send.error} />
              <Button type="submit" size="lg" loading={send.isPending}>{t('login.send')}</Button>
              <p className="text-center text-xs text-slate-500">{t('login.noPassword')}</p>
            </form>
          </div>
        )}
      </Card>
    </main>
  );
}
