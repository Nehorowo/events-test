import { useTranslation } from 'react-i18next';
import { CopyButton } from './ui';

export function ShareCard({ url, slug }: { url: string; slug: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700">{t('settings.shareLink')}</p>
        <div className="flex items-center gap-2">
          <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate rounded-lg bg-slate-100 px-3 py-2.5 font-mono text-sm text-brand-700">
            {url.replace(/^https?:\/\//, '')}
          </a>
          <CopyButton text={url} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <img src={`/api/public/${slug}/qr.png?size=320`} alt={t('settings.qr')} width={140} height={140} className="rounded-lg border border-slate-200 bg-white" />
        <div className="space-y-2">
          <a href={`/api/public/${slug}/qr.png?size=1200&download=1`} className="block text-sm font-semibold text-brand-700 underline">
            {t('settings.downloadQr')}
          </a>
          <CopyButton text={t('onboarding.bioText', { url })} label={t('onboarding.copyBio')} />
        </div>
      </div>
    </div>
  );
}
