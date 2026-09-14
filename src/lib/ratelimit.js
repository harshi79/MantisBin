/**
 * Rate limiting backed by the same database as everything else.
 *
 * No KV, no Durable Objects, no extra infrastructure: one row per bucket with a
 * reset timestamp. Limits are intentionally generous — this exists to stop
 * obvious abuse (scripts hammering create/login), not to police real users.
 */

/**
 * @typedef {import('../db/turso.js').Db} Db
 * @typedef {{ limit: number, window: number }} Rule
 * @typedef {{ ok: boolean, remaining: number, retryAfter: number }} Verdict
 */

/**
 * Consume one unit from a bucket.
 * @param {Db} db
 * @param {string} key
 * @param {Rule} rule
 * @param {number} [now]
 * @returns {Promise<Verdict>}
 */
export async function consume(db, key, rule, now = Math.floor(Date.now() / 1000)) {
  const bucket = `${key}:${rule.window}`;
  const resetAt = now + rule.window;

  // Upsert: start a fresh window if the old one elapsed, otherwise increment.
  await db.run(
    `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END`,
    [bucket, resetAt, now, now, resetAt],
  );

  const row = await db.get('SELECT count, reset_at FROM rate_limits WHERE bucket = ?', [bucket]);
  const count = Number(row?.count ?? 1);
  const reset = Number(row?.reset_at ?? resetAt);
  return {
    ok: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfter: Math.max(1, reset - now),
  };
}

/**
 * Remove buckets whose window has elapsed (called from the cleanup job).
 * `DELETE ... LIMIT` is not portable across SQLite builds, so use a rowid subquery.
 */
export async function pruneRateLimits(db, now = Math.floor(Date.now() / 1000), limit = 5000) {
  const result = await db.run(
    'DELETE FROM rate_limits WHERE rowid IN (SELECT rowid FROM rate_limits WHERE reset_at <= ? LIMIT ?)',
    [now, limit],
  );
  return result.changes;
}
