import webpush from 'web-push';
import { config } from '../config.js';
import { one, pool } from '../db.js';

let keys: { publicKey: string; privateKey: string } | undefined;

/**
 * VAPID keys come from the environment when set; otherwise a pair is generated
 * once and kept in app_settings so existing push subscriptions stay valid.
 */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (keys) return keys;
  if (config.vapid.publicKey && config.vapid.privateKey) {
    keys = { publicKey: config.vapid.publicKey, privateKey: config.vapid.privateKey };
    return keys;
  }
  const generated = webpush.generateVAPIDKeys();
  await pool.query(
    `insert into app_settings (key, value) values ('vapid', $1) on conflict (key) do nothing`,
    [JSON.stringify(generated)],
  );
  const row = await one<{ value: string }>(pool, `select value from app_settings where key = 'vapid'`);
  keys = JSON.parse(row!.value);
  return keys!;
}

export async function getVapidPublicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/** Sends to every device of a user; prunes subscriptions the browser revoked. */
export async function pushToUser(userId: string, payload: PushPayload): Promise<number> {
  const k = await vapidKeys();
  const { rows } = await pool.query(
    'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1',
    [userId],
  );
  let delivered = 0;
  for (const sub of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { vapidDetails: { subject: config.vapid.subject, ...k }, TTL: 3600 },
      );
      delivered++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await pool.query('delete from push_subscriptions where id = $1', [sub.id]);
      } else {
        throw err;
      }
    }
  }
  return delivered;
}
