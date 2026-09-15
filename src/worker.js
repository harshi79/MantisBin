/**
 * Cloudflare Worker entry point.
 *
 * fetch  -> the whole app (HTML + JSON API + raw endpoints)
 * scheduled -> expiration cleanup + housekeeping (cron in wrangler.jsonc)
 *
 * Static files (app.css, app.js, robots.txt) are served by Cloudflare Assets
 * from ./public and never reach this Worker.
 */

import { handleRequest } from './app.js';
import { ensureSchema } from './db/schema.js';
import { createTursoDb } from './db/turso.js';
import { runMaintenance } from './lib/maintenance.js';

/** Schema is idempotent; applying it once per isolate keeps cold starts cheap. */
let schemaPromise = null;

function ensureSchemaOnce(db) {
  if (!schemaPromise) {
    schemaPromise = ensureSchema(db).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export default {
  /**
   * @param {Request} request
   * @param {any} env
   * @param {any} ctx Cloudflare ExecutionContext
   */
  async fetch(request, env, ctx) {
    const db = createTursoDb(env);
    await ensureSchemaOnce(db);
    return handleRequest({ request, env, db });
  },

  /**
   * @param {any} event Cloudflare ScheduledEvent
   * @param {any} env
   * @param {any} ctx Cloudflare ExecutionContext
   */
  async scheduled(event, env, ctx) {
    const db = createTursoDb(env);
    await ensureSchemaOnce(db);
    await runMaintenance(db);
  },
};
