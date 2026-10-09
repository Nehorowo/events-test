import { randomBytes } from 'node:crypto';

const env = process.env;

function int(name: string, fallback: number): number {
  const v = env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

const production = env.NODE_ENV === 'production';

const appSecret = env.APP_SECRET ?? (production ? '' : 'dev-insecure-secret-change-me');
if (production && appSecret.length < 32) {
  throw new Error('APP_SECRET must be set to at least 32 characters in production');
}

export const config = {
  production,
  port: int('PORT', 3000),
  host: env.HOST ?? '0.0.0.0',
  /** Public origin of the app, used in emails and OAuth redirects. */
  appUrl: (env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL ?? 'postgres://slotwise:slotwise@localhost:5432/slotwise',
  appSecret: appSecret || randomBytes(32).toString('hex'),
  /** Directory with the built SPA; served by the API when present. */
  webDist: env.WEB_DIST ?? '',
  migrationsDir: env.MIGRATIONS_DIR ?? new URL('../../db/migrations', import.meta.url).pathname,
  runMigrations: env.RUN_MIGRATIONS !== 'false',

  email: {
    from: env.EMAIL_FROM ?? 'Slotwise <bookings@slotwise.local>',
    resendApiKey: env.RESEND_API_KEY ?? '',
    smtpUrl: env.SMTP_URL ?? '',
  },

  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
    priceMonthly: env.STRIPE_PRICE_MONTHLY ?? '',
    priceYearly: env.STRIPE_PRICE_YEARLY ?? '',
  },

  vapid: {
    publicKey: env.VAPID_PUBLIC_KEY ?? '',
    privateKey: env.VAPID_PRIVATE_KEY ?? '',
    subject: env.VAPID_SUBJECT ?? 'mailto:support@slotwise.local',
  },

  analytics: {
    umamiScriptUrl: env.UMAMI_SCRIPT_URL ?? '',
    umamiWebsiteId: env.UMAMI_WEBSITE_ID ?? '',
  },

  worker: {
    pollMs: int('WORKER_POLL_MS', 10_000),
    maxAttempts: int('WORKER_MAX_ATTEMPTS', 6),
  },
};

export type BillingMode = 'stripe' | 'dev';
export const billingMode: BillingMode =
  config.stripe.secretKey && config.stripe.priceMonthly ? 'stripe' : 'dev';
