/**
 * Scheduled maintenance: delete expired and burned pastes and prune housekeeping rows.
 *
 * Runs from the Worker `scheduled` trigger (cron in wrangler.jsonc) and is also
 * invoked opportunistically on paste creation, so expired content never lingers
 * even if a cron run is delayed. All deletes are batched and bounded, which is
 * exactly what the Cloudflare + Turso model wants: small, fast transactions.
 */

import { CLEANUP_BATCH } from '../config.js';
import { pruneBurned } from './burn.js';
import { pruneExpired, pruneViewLog } from './pastes.js';
import { pruneSessions } from './auth.js';
import { pruneRateLimits } from './ratelimit.js';
import { pruneNotifications } from './social.js';

/**
 * @param {import('../db/turso.js').Db} db
 * @param {number} [now]
 */
export async function runMaintenance(db, now = Math.floor(Date.now() / 1000)) {
  const expired = await pruneExpired(db, now, CLEANUP_BATCH);
  // One-time pastes claimed by a request that died before deleting them.
  const burned = await pruneBurned(db, CLEANUP_BATCH);
  const views = await pruneViewLog(db, now);
  const sessions = await pruneSessions(db, now);
  const rateLimits = await pruneRateLimits(db, now);
  // Read notifications only, older than the retention window: an unread one is
  // still news, however old it is.
  const notifications = await pruneNotifications(db, now, CLEANUP_BATCH);
  await db.run('DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions WHERE expires_at <= ? LIMIT 1000)', [now]);
  const summary = { expired, burned, viewLog: views, sessions, rateLimits, notifications };
  console.log('[mantisbin] maintenance', JSON.stringify(summary));
  return summary;
}
