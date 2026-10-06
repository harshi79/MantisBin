/**
 * Paste storage: creation, lookup, updates, ownership, views and expiration.
 */

import { DEFAULT_BURN_MODE, DEFAULT_VISIBILITY, LIMITS, VIEW_DEDUPE_SECONDS } from '../config.js';
import { hmacSha256Hex, randomToken } from './crypto.js';
import { byteLength } from './validate.js';

/** @typedef {import('../db/turso.js').Db} Db */

/**
 * Columns shared by every paste row.
 * `content` is deliberately excluded from list queries — pastes can be 10 MB.
 */
export const PASTE_META_COLUMNS =
  'id, title, language, font, font_size, size, views, user_id, created_at, updated_at, expires_at, password_hash, burn_mode, burned, visibility, thumbnail_url, title_color, pinned';

/**
 * The same column list qualified for a joined query (`p.id, p.title, …`).
 * Without the prefix, `id`/`created_at` are ambiguous the moment a query joins
 * `pastes` with any other table that has them — `users` always does.
 * @param {string} alias
 */
export function pasteMetaColumns(alias) {
  return PASTE_META_COLUMNS.split(',')
    .map((column) => `${alias}.${column.trim()}`)
    .join(', ');
}

/**
 * @typedef {object} Paste
 * @property {string} id
 * @property {string} title
 * @property {string} [content]
 * @property {string} language
 * @property {string} font
 * @property {number} font_size
 * @property {number} size
 * @property {number} views
 * @property {number | null} user_id
 * @property {number} created_at
 * @property {number} updated_at
 * @property {number | null} expires_at
 * @property {string | null} [password_hash] PBKDF2 hash when the paste is protected
 * @property {string} [burn_mode] 'never' | 'view' | 'read'
 * @property {number} [burned] 1 once a one-time paste has been handed out
 * @property {string} [visibility] 'unlisted' | 'public'
 * @property {string | null} [thumbnail_url] public image URL, or null
 * @property {string | null} [formatting] JSON overlay of line-level display hints, or null
 * @property {string | null} [title_color] per-paste title colour id, or null
 * @property {number} [pinned] 1 when pinned to the top of a profile
 */

/**
 * @param {Db} db
 * @param {{
 *   title: string, content: string, language: string, font: string,
 *   fontSize: number, expiresAt: number | null, userId?: number | null,
 *   passwordHash?: string | null, burnMode?: string, visibility?: string,
 *   thumbnailUrl?: string | null, formatting?: string | null,
 *   titleColor?: string | null, now?: number
 * }} input
 * @returns {Promise<Paste>}
 */
export async function createPaste(db, input) {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const size = byteLength(input.content);

  // Random base62 ids; retry on the (astronomically unlikely) collision.
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomToken(LIMITS.idLength);
    try {
      await db.run(
        `INSERT INTO pastes
           (id, title, content, language, font, font_size, size, views, user_id, created_at, updated_at, expires_at, password_hash, burn_mode, burned, visibility, thumbnail_url, formatting, title_color)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          id,
          input.title,
          input.content,
          input.language,
          input.font,
          input.fontSize,
          size,
          input.userId ?? null,
          now,
          now,
          input.expiresAt ?? null,
          input.passwordHash ?? null,
          input.burnMode ?? DEFAULT_BURN_MODE,
          input.visibility ?? DEFAULT_VISIBILITY,
          input.thumbnailUrl || null,
          input.formatting || null,
          input.titleColor || null,
        ],
      );
      return {
        id,
        title: input.title,
        content: input.content,
        language: input.language,
        font: input.font,
        font_size: input.fontSize,
        size,
        views: 0,
        user_id: input.userId ?? null,
        created_at: now,
        updated_at: now,
        expires_at: input.expiresAt ?? null,
        password_hash: input.passwordHash ?? null,
        burn_mode: input.burnMode ?? DEFAULT_BURN_MODE,
        burned: 0,
        visibility: input.visibility ?? DEFAULT_VISIBILITY,
        thumbnail_url: input.thumbnailUrl || null,
        formatting: input.formatting || null,
        title_color: input.titleColor || null,
      };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 3) throw error;
    }
  }
  throw new Error('Unable to allocate a paste id');
}

function isUniqueViolation(error) {
  const message = String(error?.message || error || '');
  return /unique|constraint/i.test(message);
}

/**
 * Fetch a paste by id. Expired pastes are deleted on sight and reported missing.
 * @param {Db} db
 * @param {string} id
 * @param {{ content?: boolean, now?: number }} [options]
 * @returns {Promise<Paste | null>}
 */
export async function getPaste(db, id, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const columns = options.content === false ? PASTE_META_COLUMNS : `${PASTE_META_COLUMNS}, content, formatting`;
  const paste = await db.get(`SELECT ${columns} FROM pastes WHERE id = ?`, [id]);
  if (!paste) return null;
  // A consumed one-time paste is gone even if a winner died before deleting it.
  if (Number(paste.burned) === 1) {
    await deletePasteRows(db, id).catch(() => {});
    return null;
  }
  if (paste.expires_at !== null && Number(paste.expires_at) <= now) {
    await deletePasteRows(db, id);
    return null;
  }
  return /** @type {Paste} */ (paste);
}

/**
 * Update an owned paste. Returns false when the paste does not exist or belongs
 * to somebody else.
 *
 * `fields.passwordHash` is tri-state: `undefined` keeps the stored hash,
 * `null` removes the protection, a string replaces it. `fields.burnMode` is
 * optional the same way (`undefined` keeps the current mode). Visibility and
 * `thumbnailUrl` follow the same rule: `undefined` keeps the stored value,
 * `null`/`''` clears it, a string replaces it.
 * @param {Db} db
 */
export async function updatePaste(db, id, userId, fields, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(userId)) return { ok: false, reason: 'unauthorized' };
  const existing = await db.get('SELECT id, user_id FROM pastes WHERE id = ?', [id]);
  if (!existing) return { ok: false, reason: 'missing' };
  if (Number(existing.user_id) !== Number(userId)) return { ok: false, reason: 'unauthorized' };

  const assignments = [
    'title = ?',
    'content = ?',
    'language = ?',
    'font = ?',
    'font_size = ?',
    'size = ?',
    'updated_at = ?',
    'expires_at = ?',
  ];
  const params = [
    fields.title,
    fields.content,
    fields.language,
    fields.font,
    fields.fontSize,
    byteLength(fields.content),
    now,
    fields.expiresAt ?? null,
  ];
  if (fields.passwordHash !== undefined) {
    assignments.push('password_hash = ?');
    params.push(fields.passwordHash);
  }
  if (fields.burnMode !== undefined) {
    assignments.push('burn_mode = ?');
    params.push(fields.burnMode);
  }
  if (fields.visibility !== undefined) {
    assignments.push('visibility = ?');
    params.push(fields.visibility);
  }
  if (fields.thumbnailUrl !== undefined) {
    assignments.push('thumbnail_url = ?');
    params.push(fields.thumbnailUrl || null);
  }
  // Tri-state: `undefined` keeps the stored overlay, `null`/'' clears it (the
  // author removed the formatting), a string replaces it.
  if (fields.formatting !== undefined) {
    assignments.push('formatting = ?');
    params.push(fields.formatting || null);
  }
  if (fields.titleColor !== undefined) {
    assignments.push('title_color = ?');
    params.push(fields.titleColor || null);
  }
  params.push(id, userId);

  await db.run(
    `UPDATE pastes SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
    params,
  );
  return { ok: true };
}

/**
 * Pin or unpin an owned paste.
 *
 * A pin only means something on a public profile, so an unlisted paste cannot
 * be pinned — the caller turns that into a message rather than a silent no-op.
 * The per-profile cap is enforced by the route (`PINNED_LIMIT`).
 * @param {Db} db
 */
export async function setPastePinned(db, id, userId, pinned) {
  if (!Number.isFinite(userId)) return { ok: false, reason: 'unauthorized' };
  const row = await db.get('SELECT id, user_id, visibility FROM pastes WHERE id = ?', [id]);
  if (!row) return { ok: false, reason: 'missing' };
  if (Number(row.user_id) !== Number(userId)) return { ok: false, reason: 'unauthorized' };
  if (pinned && String(row.visibility ?? 'unlisted') !== 'public') return { ok: false, reason: 'unlisted' };
  await db.run('UPDATE pastes SET pinned = ? WHERE id = ? AND user_id = ?', [pinned ? 1 : 0, id, userId]);
  return { ok: true };
}

/** How many pastes this account has pinned (the route enforces the cap). */
export async function countPinnedPastes(db, userId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM pastes WHERE user_id = ? AND pinned = 1', [Number(userId)]);
  return Number(row?.n ?? 0);
}

/**
 * Statements that erase everything pointing at one or more pastes.
 *
 * A deleted paste must not leave rows behind: a bookmark or a notification
 * pointing at a 404 is worse than no row, and reactions on a paste nobody can
 * open are noise. Every deletion path (owner delete, expiry sweep, burn sweep,
 * admin action) uses this list, so none of them can forget a table.
 *
 * The `pastes` row itself is deliberately *not* included — callers delete it
 * first when they need the affected-row count (ownership checks), or last when
 * they do not.
 *
 * @param {string | string[]} ids
 * @returns {import('./social.js').Statement[]}
 */
export function pasteChildStatements(ids) {
  const list = Array.isArray(ids) ? ids.map((id) => String(id)) : [String(ids)];
  const placeholders = list.map(() => '?').join(', ');
  return [
    { sql: `DELETE FROM bookmarks WHERE paste_id IN (${placeholders})`, params: list },
    { sql: `DELETE FROM reactions WHERE paste_id IN (${placeholders})`, params: list },
    { sql: `DELETE FROM notifications WHERE paste_id IN (${placeholders})`, params: list },
    { sql: `DELETE FROM paste_views WHERE paste_id IN (${placeholders})`, params: list },
  ];
}

/** Delete an owned paste (and its view log, bookmarks, reactions, notifications). */
export async function deletePaste(db, id, userId) {
  if (!Number.isFinite(userId)) return { ok: false, reason: 'unauthorized' };
  const result = await db.run('DELETE FROM pastes WHERE id = ? AND user_id = ?', [id, userId]);
  if (result.changes === 0) {
    const existing = await db.get('SELECT id FROM pastes WHERE id = ?', [id]);
    return { ok: false, reason: existing ? 'unauthorized' : 'missing' };
  }
  await db.batch(pasteChildStatements(id));
  return { ok: true };
}

/** Internal delete without ownership checks (expiry + admin sweeps). */
export async function deletePasteRows(db, id) {
  await db.batch([
    { sql: 'DELETE FROM pastes WHERE id = ?', params: [String(id)] },
    ...pasteChildStatements(id),
  ]);
}

/**
 * A user's pastes, newest first, without content.
 * @param {Db} db
 */
export async function listUserPastes(db, userId, limit = 200, now = Math.floor(Date.now() / 1000)) {
  return db.all(
    `SELECT ${PASTE_META_COLUMNS} FROM pastes
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) AND burned = 0
      ORDER BY pinned DESC, created_at DESC LIMIT ?`,
    [userId, now, Math.min(Math.max(limit, 1), 500)],
  );
}

/**
 * Count a view at most once per visitor per paste inside the dedupe window.
 * Two statements in one batch — no extra round trip, no analytics table.
 * @param {Db} db
 * @returns {Promise<number>} the new view total
 */
export async function recordView(db, id, visitor, now = Math.floor(Date.now() / 1000)) {
  const since = now - VIEW_DEDUPE_SECONDS;
  const existing = await db.get(
    'SELECT 1 AS seen FROM paste_views WHERE paste_id = ? AND visitor = ? AND created_at > ?',
    [id, visitor, since],
  );
  if (existing) {
    const current = await db.get('SELECT views FROM pastes WHERE id = ?', [id]);
    return Number(current?.views ?? 0);
  }
  await db.batch([
    { sql: 'DELETE FROM paste_views WHERE paste_id = ? AND visitor = ?', params: [id, visitor] },
    { sql: 'INSERT INTO paste_views (paste_id, visitor, created_at) VALUES (?, ?, ?)', params: [id, visitor, now] },
    { sql: 'UPDATE pastes SET views = views + 1 WHERE id = ?', params: [id] },
  ]);
  const updated = await db.get('SELECT views FROM pastes WHERE id = ?', [id]);
  return Number(updated?.views ?? 0);
}

/** Pseudonymise an IP so we never store raw visitor addresses. */
export async function visitorHash(secret, ip, pasteId) {
  return (await hmacSha256Hex(secret, `${ip}|${pasteId}`)).slice(0, 32);
}

/**
 * Delete expired pastes in bounded batches (scheduled trigger + on-demand sweep).
 * @param {Db} db
 * @returns {Promise<number>} number of pastes deleted
 */
export async function pruneExpired(db, now = Math.floor(Date.now() / 1000), batchSize = 500) {
  let total = 0;
  for (let pass = 0; pass < 20; pass++) {
    const rows = await db.all(
      'SELECT id FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?',
      [now, batchSize],
    );
    if (!rows.length) break;
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    await db.batch([
      { sql: `DELETE FROM pastes WHERE id IN (${placeholders})`, params: ids },
      ...pasteChildStatements(ids),
    ]);
    total += ids.length;
    if (ids.length < batchSize) break;
  }
  return total;
}

/** Drop view-log rows older than the dedupe window (cleanup job). */
export async function pruneViewLog(db, now = Math.floor(Date.now() / 1000), limit = 5000) {
  const cutoff = now - VIEW_DEDUPE_SECONDS;
  // Sequential rather than batched: `batch()` reports no row counts, and the
  // cleanup pass wants them.
  const pastes = await db.run(
    `DELETE FROM paste_views WHERE rowid IN (
       SELECT rowid FROM paste_views WHERE created_at <= ? LIMIT ?
     )`,
    [cutoff, limit],
  );
  const profiles = await db.run(
    `DELETE FROM profile_views WHERE rowid IN (
       SELECT rowid FROM profile_views WHERE created_at <= ? LIMIT ?
     )`,
    [cutoff, limit],
  );
  return Number(pastes?.changes ?? 0) + Number(profiles?.changes ?? 0);
}

/**
 * One account's public pastes, newest first, without content. Expired and
 * consumed one-time pastes never appear on a profile.
 * @param {Db} db
 */
export async function listPublicPastes(db, userId, limit = 100, now = Math.floor(Date.now() / 1000)) {
  return db.all(
    `SELECT ${PASTE_META_COLUMNS} FROM pastes
      WHERE user_id = ? AND visibility = 'public'
        AND (expires_at IS NULL OR expires_at > ?) AND burned = 0
      ORDER BY created_at DESC LIMIT ?`,
    [userId, now, Math.min(Math.max(limit, 1), 500)],
  );
}

/**
 * Live-paste totals for a settings/profile header.
 * @param {Db} db
 * @returns {Promise<{ pastes: number, views: number, bytes: number, publicPastes: number }>}
 */
export async function userStats(db, userId, now = Math.floor(Date.now() / 1000)) {
  const row = await db.get(
    `SELECT COUNT(*) AS pastes,
            COALESCE(SUM(views), 0) AS views,
            COALESCE(SUM(size), 0) AS bytes,
            COALESCE(SUM(CASE WHEN visibility = 'public' THEN 1 ELSE 0 END), 0) AS publicPastes
       FROM pastes
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) AND burned = 0`,
    [userId, now],
  );
  return {
    pastes: Number(row?.pastes ?? 0),
    views: Number(row?.views ?? 0),
    bytes: Number(row?.bytes ?? 0),
    publicPastes: Number(row?.publicPastes ?? 0),
  };
}
