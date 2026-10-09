import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { z } from 'zod';
import { billingMode, config } from '../config.js';
import { one, pool, tx } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { MANAGERS, parse, requireMember, requireUser } from '../http.js';
import { tenantIdParam } from './tenant.js';

let stripeClient: Stripe | undefined;
function stripe(): Stripe {
  stripeClient ??= new Stripe(config.stripe.secretKey);
  return stripeClient;
}

function periodEnd(sub: Stripe.Subscription): Date | null {
  const raw =
    sub.items?.data?.[0]?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;
  return raw ? new Date(raw * 1000) : null;
}

/** Mirrors a Stripe subscription onto the tenant. Founding plans are never downgraded to Pro. */
async function syncSubscription(sub: Stripe.Subscription, tenantIdHint?: string | null) {
  const tenantId = tenantIdHint || (sub.metadata?.tenant_id as string | undefined);
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const interval = sub.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'year' : 'month';
  const ended = sub.status === 'canceled' || sub.status === 'incomplete_expired';
  await pool.query(
    `update subscriptions set
        plan = case when plan = 'founding' then plan when $3 then 'free' else 'pro' end,
        status = $4, billing_interval = $5, stripe_customer_id = $2,
        stripe_subscription_id = case when $3 then null else $6 end,
        current_period_end = $7, updated_at = now()
      where ($1::uuid is not null and tenant_id = $1) or stripe_customer_id = $2`,
    [tenantId ?? null, customerId, ended, ended ? 'active' : sub.status, interval, sub.id, periodEnd(sub)],
  );
}

export async function billingRoutes(app: FastifyInstance) {
  app.post('/api/t/:tid/billing/checkout', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const user = requireUser(req);
    const { interval } = parse(z.object({ interval: z.enum(['month', 'year']).default('month') }), req.body ?? {});

    if (billingMode === 'dev') {
      // No Stripe keys: flip the plan directly so the whole flow can be tried locally.
      await pool.query(
        `update subscriptions set plan = case when plan = 'founding' then plan else 'pro' end,
                status = 'active', billing_interval = $2,
                current_period_end = now() + case when $2 = 'year' then interval '1 year' else interval '1 month' end,
                updated_at = now()
          where tenant_id = $1`,
        [tid, interval],
      );
      return { url: '/app/billing?upgraded=1' };
    }

    const price = interval === 'year' && config.stripe.priceYearly ? config.stripe.priceYearly : config.stripe.priceMonthly;
    const sub = await one<{ stripe_customer_id: string | null }>(
      pool,
      'select stripe_customer_id from subscriptions where tenant_id = $1',
      [tid],
    );
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: tid,
      ...(sub?.stripe_customer_id ? { customer: sub.stripe_customer_id } : { customer_email: user.email }),
      subscription_data: { metadata: { tenant_id: tid } },
      metadata: { tenant_id: tid },
      allow_promotion_codes: true,
      success_url: `${config.appUrl}/app/billing?upgraded=1`,
      cancel_url: `${config.appUrl}/app/billing`,
    });
    if (!session.url) throw badRequest('checkout_failed');
    return { url: session.url };
  });

  app.post('/api/t/:tid/billing/portal', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    if (billingMode === 'dev') {
      await pool.query(
        `update subscriptions set plan = case when plan = 'founding' then plan else 'free' end,
                status = 'active', billing_interval = null, current_period_end = null, updated_at = now()
          where tenant_id = $1`,
        [tid],
      );
      return { url: '/app/billing?cancelled=1' };
    }
    const sub = await one<{ stripe_customer_id: string | null }>(
      pool,
      'select stripe_customer_id from subscriptions where tenant_id = $1',
      [tid],
    );
    if (!sub?.stripe_customer_id) throw notFound('no_billing_account');
    const session = await stripe().billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${config.appUrl}/app/billing`,
    });
    return { url: session.url };
  });

  // Stripe needs the raw body to verify the signature, so this route gets its
  // own JSON parser in an encapsulated scope.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.post('/api/stripe/webhook', async (req, reply) => {
      if (billingMode !== 'stripe' || !config.stripe.webhookSecret) return reply.status(404).send();
      let event: Stripe.Event;
      try {
        event = stripe().webhooks.constructEvent(
          req.body as Buffer,
          req.headers['stripe-signature'] as string,
          config.stripe.webhookSecret,
        );
      } catch {
        return reply.status(400).send({ error: 'bad_signature' });
      }

      // Idempotency: Stripe retries; each event is handled once.
      const fresh = await tx(async (db) => {
        const res = await db.query(
          'insert into stripe_events (id, type) values ($1, $2) on conflict do nothing',
          [event.id, event.type],
        );
        return res.rowCount === 1;
      });
      if (!fresh) return { received: true, duplicate: true };

      try {
        switch (event.type) {
          case 'checkout.session.completed': {
            const s = event.data.object as Stripe.Checkout.Session;
            if (s.mode === 'subscription' && s.subscription) {
              const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription.id;
              const sub = await stripe().subscriptions.retrieve(subId);
              await syncSubscription(sub, s.client_reference_id);
            }
            break;
          }
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted':
            await syncSubscription(event.data.object as Stripe.Subscription);
            break;
          case 'invoice.payment_failed': {
            const inv = event.data.object as Stripe.Invoice;
            const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
            if (customer) {
              await pool.query(
                `update subscriptions set status = 'past_due', updated_at = now() where stripe_customer_id = $1`,
                [customer],
              );
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        // Let Stripe retry: forget the event so the retry is processed.
        await pool.query('delete from stripe_events where id = $1', [event.id]);
        throw err;
      }
      return { received: true };
    });
  });
}
