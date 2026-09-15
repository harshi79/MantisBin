/**
 * Burn-after-reading (roadmap 2.2 §2).
 *
 * Rules, in one place:
 *
 *   never  — nothing burns.
 *   view   — the paste is consumed by the first successful **HTML view**.
 *   read   — the paste is consumed by the first successful read of any kind
 *            (HTML view, web /raw, API JSON, API raw).
 *
 * Consumption is claimed with a single atomic statement:
 *
 *   UPDATE pastes SET burned = 1 WHERE id = ? AND burned = 0 AND burn_mode <> 'never'
 *
 * `changes === 1` means "this request is the one allowed read". Exactly one of
 * any number of concurrent requests can see that, so a one-time paste can never
 * be handed to two readers. The winner then deletes the row immediately (the
 * response is built from the row it already holds), and `pruneBurned` sweeps
 * anything left behind if a process dies between the claim and the delete.
 *
 * Everything here runs *after* authorisation (see lib/access.js) and only for
 * requests that will actually be served, so a wrong passphrase, a 401, a 404, an
 * expired paste, a lock screen or a rate-limited request can never burn one.
 */

import { BURN_MODES, DEFAULT_BURN_MODE } from '../config.js';
import { deletePasteRows } from './pastes.js';

/** @typedef {import('../db/turso.js').Db} Db */
/** @typedef {'view' | 'read'} ReadKind */

/** Whitelist a stored/incoming burn mode. */
export function normalizeBurnMode(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BURN_MODES.some((mode) => mode.id === id) ? id : DEFAULT_BURN_MODE;
}

/** @param {any} paste */
export function burnModeOf(paste) {
  return normalizeBurnMode(paste?.burn_mode);
}

/** Human-readable metadata line, safe to show before unlock (never content). */
export function burnLabel(paste) {
  const mode = burnModeOf(paste);
  const found = BURN_MODES.find((entry) => entry.id === mode);
  return mode === DEFAULT_BURN_MODE ? null : found?.short ?? null;
}

/**
 * Does a successful read of this kind consume the paste?
 * @param {any} paste
 * @param {ReadKind} kind
 */
export function shouldBurn(paste, kind) {
  const mode = burnModeOf(paste);
  if (mode === 'never') return false;
  if (mode === 'read') return true;
  return kind === 'view';
}

/** True when the row is already consumed and must be treated as gone. */
export function isBurned(paste) {
  return Number(paste?.burned ?? 0) === 1;
}

/**
 * Atomically claim the single allowed read.
 * @param {Db} db
 * @param {string} id
 * @returns {Promise<boolean>} true for the winner, false for every loser
 */
export async function claimBurn(db, id) {
  const result = await db.run(
    "UPDATE pastes SET burned = 1 WHERE id = ? AND burned = 0 AND burn_mode <> ?",
    [id, DEFAULT_BURN_MODE],
  );
  return result.changes === 1;
}

/**
 * Apply the burn rule for one successful, already-authorised read.
 *
 * Call this *before* building the response: the winner deletes the row and then
 * serves the copy it already holds, so the content is unreachable in the
 * database the moment it is handed out.
 *
 * @param {Db} db
 * @param {any} paste row including burn_mode/burned
 * @param {ReadKind} kind
 * @returns {Promise<boolean>} false when another request consumed the paste first
 */
export async function claimBurnForRead(db, paste, kind) {
  if (!shouldBurn(paste, kind)) return true;
  const won = await claimBurn(db, paste.id);
  if (!won) return false;
  try {
    await deletePasteRows(db, paste.id);
  } catch (error) {
    // The row is already unreadable (burned = 1) and the cron sweeps it.
    console.warn('[mantisbin] could not delete a burned paste', paste.id, error);
  }
  return true;
}

/**
 * Safety net for rows whose winning request died before deleting them. Bounded
 * batch, called from the hourly maintenance run.
 * @param {Db} db
 * @returns {Promise<number>} rows removed
 */
export async function pruneBurned(db, limit = 500) {
  const rows = await db.all('SELECT id FROM pastes WHERE burned = 1 LIMIT ?', [limit]);
  if (!rows.length) return 0;
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  await db.batch([
    { sql: `DELETE FROM paste_views WHERE paste_id IN (${placeholders})`, params: ids },
    { sql: `DELETE FROM pastes WHERE id IN (${placeholders})`, params: ids },
  ]);
  return ids.length;
}
