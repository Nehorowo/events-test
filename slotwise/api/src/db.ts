import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings; they are calendar days in
// the tenant's timezone, not instants.
pg.types.setTypeParser(1082, (v) => v);
// bigint counts fit comfortably in a JS number here.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Db;

export async function tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` as the RLS-restricted role with the tenant pinned for the
 * transaction. Anything `fn` queries is limited to that tenant's rows.
 */
export function withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return tx(async (db) => {
    await db.query('set local role slotwise_tenant');
    await db.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn(db);
  });
}

export async function one<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await db.query(sql, params);
  return rows[0] as T | undefined;
}

export async function many<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

/** Applies db/migrations/*.sql in order, once each, under an advisory lock. */
export async function migrate(log: (msg: string) => void = console.log): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set(
      (await client.query('select name from schema_migrations')).rows.map((r) => r.name as string),
    );
    const files = (await readdir(config.migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(config.migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        log(`migration applied: ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

const camelKey = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** snake_case row keys → camelCase for JSON responses. */
export function camel<T = any>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v;
  return out as T;
}

export async function manyCamel<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await db.query(sql, params);
  return rows.map((r) => camel<T>(r));
}

export async function oneCamel<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await db.query(sql, params);
  return rows[0] ? camel<T>(rows[0]) : undefined;
}
