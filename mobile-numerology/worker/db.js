// Connection to Kamala's Postgres database (Supabase). On Cloudflare it goes through Hyperdrive (binding HYPERDRIVE),
// which keeps a warm pool next to the database; DATABASE_URL is the fallback (local runs, tests).
// A runner connects on its first query, so a database outage surfaces as a query error that saveLead handles
// (it then writes the lead straight to the Sheet).
import pg from 'pg';

export const databaseUrl = env => env.HYPERDRIVE?.connectionString || env.DATABASE_URL || null;

export function lazyRunner(env) {
  const url = databaseUrl(env);
  let client = null;
  let connecting = null;
  const run = async (text, params) => {
    if (!client) {
      connecting ??= (async () => {
        const c = new pg.Client({
          connectionString: url,
          // Hyperdrive handles TLS to the database itself; a direct DATABASE_URL to Supabase needs TLS.
          ...(env.HYPERDRIVE ? {} : /localhost|127\.0\.0\.1/.test(url) ? {} : { ssl: { rejectUnauthorized: false } }),
          connectionTimeoutMillis: 10000
        });
        await c.connect();
        client = c;
      })();
      await connecting;
    }
    return (await client.query(text, params)).rows;
  };
  run.close = async () => { if (client) await client.end().catch(() => {}); };
  return run;
}

/** Runs fn(run) on one connection and always closes it. */
export async function withDb(env, fn) {
  const run = lazyRunner(env);
  try { return await fn(run); } finally { await run.close(); }
}
