import { migrate, one, pool } from './db.js';

// Operator CLI.
//   node dist/admin.js founding <slug>   Pro free for 3 months, then €5/month for life
//   node dist/admin.js plan <slug> <free|pro|founding>
//   node dist/admin.js tenants           list businesses with plan and usage

const [cmd, slug, arg] = process.argv.slice(2);

await migrate(() => {});
try {
  switch (cmd) {
    case 'founding': {
      const row = await one(
        pool,
        `update subscriptions s set plan = 'founding', status = 'active',
                founding_until = now() + interval '3 months', updated_at = now()
           from tenants t where t.id = s.tenant_id and t.slug = $1 returning t.slug, s.founding_until`,
        [slug],
      );
      console.log(row ? `${row.slug}: founding until ${row.founding_until.toISOString()}` : `no business "${slug}"`);
      break;
    }
    case 'plan': {
      if (!['free', 'pro', 'founding'].includes(arg ?? '')) throw new Error('plan must be free, pro or founding');
      const row = await one(
        pool,
        `update subscriptions s set plan = $2, status = 'active', updated_at = now()
           from tenants t where t.id = s.tenant_id and t.slug = $1 returning t.slug`,
        [slug, arg],
      );
      console.log(row ? `${slug}: plan=${arg}` : `no business "${slug}"`);
      break;
    }
    case 'tenants': {
      const { rows } = await pool.query(
        `select t.slug, t.name, s.plan, t.published, t.created_at::date as created,
                (select count(*) from appointments a where a.tenant_id = t.id and a.source = 'online') as online_bookings
           from tenants t left join subscriptions s on s.tenant_id = t.id order by t.created_at`,
      );
      console.table(rows);
      break;
    }
    default:
      console.log('usage: admin.js founding <slug> | plan <slug> <free|pro|founding> | tenants');
  }
} finally {
  await pool.end();
}
