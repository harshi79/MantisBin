/**
 * Scheduled maintenance: delete expired pastes and prune housekeeping rows.
 *
 * Runs from the Worker `scheduled` trigger (cron in wrangler.jsonc) and is also
 * invoked opportunistically on paste creation, so expired content never lingers
 * even if a cron run is delayed. All deletes are batched and bounded, which is
 * exactly what the Cloudflare + Turso model wants: small, fast transactions.
 */

import { CLEANUP_BATCH } from '../config.js';
import { pruneExpired, pruneViewLog } from './pastes.js';
import { pruneSessions } from './auth.js';
import { pruneRateLimits } from './ratelimit.js';

/**
 * @param {import('../db/turso.js').Db} db
 * @param {number} [now]
 */
export async function runMaintenance(db, now = Math.floor(Date.now() / 1000)) {
  const expired = await pruneExpired(db, now, CLEANUP_BATCH);
  const views = await pruneViewLog(db, now);
  const sessions = await pruneSessions(db, now);
  const rateLimits = await pruneRateLimits(db, now);
  const summary = { expired, viewLog: views, sessions, rateLimits };
  console.log('[mantisbin] maintenance', JSON.stringify(summary));
  return summary;
}
