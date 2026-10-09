import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Button, Card, ErrorText, PageSpinner } from '../components/ui';
import { get, post } from '../lib/api';
import { storeTenantId, useMe } from '../lib/session';

export default function Invite() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => get<{ email: string; role: string; tenantName: string; acceptedAt: string | null; expired: boolean }>(`/invites/${token}`),
  });
  const accept = useMutation({
    mutationFn: () => post<{ tenantId: string }>(`/invites/${token}/accept`),
    onSuccess: async (r) => {
      storeTenantId(r.tenantId);
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/app');
    },
  });

  if (invite.isLoading || me.isLoading) return <PageSpinner />;
  const inv = invite.data;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <Card>
        {!inv || inv.expired || inv.acceptedAt ? (
          <Alert tone="red">{t('invite.expired')}</Alert>
        ) : (
          <div className="space-y-4">
            <h1 className="text-xl font-semibold">{t('invite.title', { name: inv.tenantName })}</h1>
            <p className="text-slate-600">{t('invite.body', { name: inv.tenantName, email: inv.email })}</p>
            <ErrorText error={accept.error} />
            {me.data?.user ? (
              <Button size="lg" loading={accept.isPending} onClick={() => accept.mutate()}>{t('invite.accept')}</Button>
            ) : (
              <Link
                to={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`}
                className="block rounded-lg bg-brand-600 px-4 py-3 text-center font-semibold text-white"
              >
                {t('invite.signInFirst', { email: inv.email })}
              </Link>
            )}
          </div>
        )}
      </Card>
    </main>
  );
}
