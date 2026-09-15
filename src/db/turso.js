/**
 * Turso / libSQL adapter for the Cloudflare Worker runtime.
 *
 * Uses the `@libsql/client/web` entry point, which is built for edge runtimes
 * (no Node built-ins) and talks to Turso over WebSockets.
 *
 * The rest of the app only sees the tiny `Db` interface documented below, so the
 * exact same handlers run against Node's built-in SQLite in dev/tests.
 *
 * @typedef {object} Db
 * @property {(sql: string, params?: unknown[]) => Promise<Record<string, any>[]>} all
 * @property {(sql: string, params?: unknown[]) => Promise<Record<string, any> | null>} get
 * @property {(sql: string, params?: unknown[]) => Promise<{ changes: number, lastInsertRowid: number | null }>} run
 * @property {(statements: Array<{ sql: string, params?: unknown[] }>) => Promise<void>} batch
 * @property {(() => Promise<void>) | undefined} [close]
 */

import { createClient } from '@libsql/client/web';

const clients = new Map();

/**
 * @param {{ TURSO_DATABASE_URL?: string, TURSO_AUTH_TOKEN?: string }} env
 * @returns {Db}
 */
export function createTursoDb(env) {
  const url = env?.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TURSO_DATABASE_URL is not set. Run `wrangler secret put TURSO_DATABASE_URL` (and TURSO_AUTH_TOKEN).',
    );
  }
  const authToken = env?.TURSO_AUTH_TOKEN || undefined;
  const cacheKey = `${url}|${authToken ? authToken.slice(0, 8) : ''}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = createClient({ url, authToken });
    clients.set(cacheKey, client);
  }
  return wrapClient(client);
}

/** @param {import('@libsql/client').Client} client */
export function wrapClient(client) {
  return {
    async all(sql, params = []) {
      const result = await client.execute({ sql, args: normalize(params) });
      return result.rows.map(rowToRecord);
    },
    async get(sql, params = []) {
      const result = await client.execute({ sql, args: normalize(params) });
      const row = result.rows[0];
      return row ? rowToRecord(row) : null;
    },
    async run(sql, params = []) {
      const result = await client.execute({ sql, args: normalize(params) });
      return {
        changes: Number(result.rowsAffected ?? 0),
        lastInsertRowid:
          result.lastInsertRowid === null || result.lastInsertRowid === undefined
            ? null
            : Number(result.lastInsertRowid),
      };
    },
    async batch(statements) {
      if (!statements.length) return;
      await client.batch(
        statements.map((s) => ({ sql: s.sql, args: normalize(s.params || []) })),
        'write',
      );
    },
    async close() {
      client.close();
    },
  };
}

/** libSQL only accepts null | string | number | bigint | ArrayBuffer. */
function normalize(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      return value;
    }
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer;
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
    return String(value);
  });
}

function rowToRecord(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}
