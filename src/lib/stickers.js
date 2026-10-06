/**
 * The curated sticker pack (merge phase 4).
 *
 * A sticker is one row: `token` (`:wave:`), an optional `url` (a remote image,
 * always `https:`) and an optional `emoji`. Rendering resolves the token at
 * *render* time — the pack is never copied into a paste — so editing the pack
 * changes every existing paste at once, and an unknown token stays exactly as
 * the author typed it. See `lib/formatting.js` for the render side.
 *
 * Only an administrator writes here. That matters: the pack is the one place
 * where the operator can put a remote image in front of every reader, so
 * imports are restricted to URLs re-resolved **server-side** from one of the
 * two known providers rather than whatever a form happened to contain.
 */

import { MEDIA } from '../config.js';
import { randomToken } from './crypto.js';
import { safeStickerUrl, shortcodeName } from './formatting.js';
import { giphyById, isTrustedMediaUrl, nekoGif } from './media.js';

export const STICKER_LIMITS = {
  /** A token is `:` + a name of at most 31 characters + `:`. */
  token: 34,
  label: 40,
  /** Emoji field: a few code points, never markup. */
  emoji: 8,
  url: 500,
  /** Rows in the pack. The render path loads at most this many. */
  pack: 400,
};

/**
 * Sanitise the emoji field: strip control characters and whitespace, keep up to
 * four code points. A URL or markup in this field would render as text next to
 * the sticker, so it is normalised down to something that cannot be either.
 * @param {unknown} value
 */
export function normalizeStickerEmoji(value) {
  if (typeof value !== 'string') return '';
  const points = Array.from(
    value
      .normalize('NFC')
      // Control characters, whitespace and markup characters all go: this field
      // is shown as text next to a sticker, never as markup.
      .replace(/[\u0000-\u001f\u007f\s<>]+/g, ''),
  )
    .filter((point) => !/[\u2028\u2029]/.test(point))
    .slice(0, 4);
  return points.join('').slice(0, STICKER_LIMITS.emoji * 2);
}

/** A label is plain text: no markup, no newlines, capped. */
export function normalizeStickerLabel(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STICKER_LIMITS.label);
}

/** `wave` / `:wave:` / `;wave;` → `:wave:`; anything else → null. */
export function normalizeStickerToken(value) {
  const name = shortcodeName(value);
  return name ? `:${name}:` : null;
}

/**
 * Read and validate the "add a sticker" form.
 *
 * All-or-nothing: one bad field returns every error, and nothing is written.
 * A row needs a token and at least one of `url`/`emoji` — otherwise the token
 * would resolve to nothing and the author would see a literal `:token:`.
 * @returns {{ ok: boolean, errors: string[], value: { token: string, label: string, emoji: string, url: string } }}
 */
export function readStickerInput(form = {}) {
  const errors = [];
  const token = normalizeStickerToken(form.token);
  if (!token) {
    errors.push('Token must look like :wave: — letters, numbers, dashes and underscores only.');
  } else if (token.length > STICKER_LIMITS.token) {
    errors.push(`Token must be at most ${STICKER_LIMITS.token} characters.`);
  }
  const label = normalizeStickerLabel(form.label);
  const emoji = normalizeStickerEmoji(form.emoji);
  const rawUrl = String(form.url ?? '').trim();
  let url = '';
  if (rawUrl) {
    const safe = safeStickerUrl(rawUrl);
    if (!safe) errors.push('Image URL must be a plain https:// address.');
    else url = safe;
  }
  if (!url && !emoji) errors.push('Give the sticker an image URL, an emoji, or both.');
  return { ok: errors.length === 0, errors, value: { token: token || '', label, emoji, url } };
}

/**
 * The pack, sorted by token, re-validated on the way out.
 *
 * Rows are normalised exactly like `profileView` normalises a profile: the
 * database is written only by an administrator, but a hand-edited row (or one
 * written before a rule existed) still must not be able to hand a
 * `javascript:` URL to a browser. A row that loses both its URL and its emoji
 * on the way out is dropped — the token then stays literal text, which is the
 * documented degradation.
 */
export async function listStickerPack(db) {
  /** @type {Array<any>} */
  let rows;
  try {
    rows = await db.all(
      'SELECT token, url, emoji, label FROM stickers ORDER BY token ASC LIMIT ?',
      [STICKER_LIMITS.pack],
    );
  } catch {
    // A database that predates the sticker table has an empty pack.
    return [];
  }
  const pack = [];
  for (const row of rows) {
    const token = normalizeStickerToken(row?.token);
    if (!token) continue;
    const url = safeStickerUrl(row?.url);
    const emoji = normalizeStickerEmoji(row?.emoji);
    if (!url && !emoji) continue;
    pack.push({ token, url, emoji, label: normalizeStickerLabel(row?.label) });
  }
  return pack;
}

/** The pack for the administration table: ids included so rows can be removed. */
export async function listStickerRows(db) {
  try {
    return await db.all(
      'SELECT id, token, url, emoji, label, created_at FROM stickers ORDER BY token ASC LIMIT ?',
      [STICKER_LIMITS.pack],
    );
  } catch {
    return [];
  }
}

/** How many rows the pack holds. */
export async function countStickers(db) {
  const row = await db.get('SELECT COUNT(*) AS n FROM stickers');
  return Number(row?.n ?? 0);
}

/**
 * Add one row.
 * @returns {Promise<{ ok: boolean, reason?: 'invalid'|'duplicate'|'limit', id?: string }>}
 */
export async function addSticker(db, { token, label = '', emoji = '', url = '', now = Math.floor(Date.now() / 1000) }) {
  const canonical = normalizeStickerToken(token);
  if (!canonical) return { ok: false, reason: 'invalid' };
  const count = await countStickers(db);
  if (count >= STICKER_LIMITS.pack) return { ok: false, reason: 'limit' };
  const existing = await db.get('SELECT id FROM stickers WHERE token = ?', [canonical]);
  if (existing) return { ok: false, reason: 'duplicate' };
  const id = randomToken(12);
  await db.run('INSERT INTO stickers (id, token, url, emoji, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    canonical,
    safeStickerUrl(url),
    normalizeStickerEmoji(emoji),
    normalizeStickerLabel(label),
    now,
  ]);
  return { ok: true, id };
}

/**
 * Remove one row by id.
 *
 * Pastes are unaffected: shortcodes resolve at render time, so a removed
 * sticker falls back to its emoji (or to the literal token) everywhere at once.
 * @returns {Promise<boolean>} true when a row was deleted
 */
export async function removeSticker(db, id) {
  const clean = String(id ?? '').trim().slice(0, 64);
  if (!clean) return false;
  const result = await db.run('DELETE FROM stickers WHERE id = ?', [clean]);
  return Number(result?.changes ?? 0) > 0;
}

/**
 * Promote a search result into the pack.
 *
 * The URL is **re-resolved from the provider** rather than taken from the form,
 * and must land on that provider's own hosts, so a crafted post cannot plant an
 * arbitrary image (or a tracking pixel on an unrelated host) in front of every
 * reader. `token` is derived from the source when the operator does not pick
 * one.
 *
 * Only `source` is required: a Giphy import needs `id`, a Neko import needs
 * `category`, and `token`/`label`/`emoji` are the operator's overrides.
 *
 * @param {any} db
 * @param {{ source: string, id?: string, category?: string, token?: string, label?: string, emoji?: string, now?: number }} input
 * @param {any} [env]
 * @returns {Promise<{ ok: boolean, reason?: string, token?: string }>}
 */
export async function importSticker(db, { source, id, category, token, label, emoji, now }, env) {
  let url = '';
  let fallbackLabel = 'Sticker';
  let fallbackEmoji = '';
  let derived = '';

  if (source === 'giphy') {
    const gif = await giphyById(env, id);
    if (!gif || !isTrustedMediaUrl(gif.url, 'giphy')) return { ok: false, reason: 'unverified' };
    url = gif.url;
    fallbackLabel = gif.label || 'Giphy GIF';
    fallbackEmoji = '🎞️';
    derived = `:giphy-${String(gif.id).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20)}:`;
  } else if (source === 'neko') {
    const gif = await nekoGif(category);
    if (!gif || !isTrustedMediaUrl(gif.url, 'neko')) return { ok: false, reason: 'unverified' };
    url = gif.url;
    fallbackLabel = gif.label;
    fallbackEmoji = gif.emoji;
    derived = `:anime-${String(category).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20)}:`;
  } else {
    return { ok: false, reason: 'source' };
  }

  const canonical = normalizeStickerToken(token) || normalizeStickerToken(derived);
  if (!canonical) return { ok: false, reason: 'token' };
  const result = await addSticker(db, {
    token: canonical,
    label: normalizeStickerLabel(label) || fallbackLabel,
    emoji: normalizeStickerEmoji(emoji) || fallbackEmoji,
    url,
    now,
  });
  return result.ok ? { ok: true, token: canonical } : result;
}

/** The providers an import may name, for the administration form. */
export const IMPORT_SOURCES = ['giphy', 'neko'];

/**
 * Absolute ceiling, re-exported so the admin view, the docs and the library all
 * quote the same number. There is exactly one cap: the pack holds this many
 * rows, and `addSticker` refuses the next one.
 */
export const PACK_LIMIT = STICKER_LIMITS.pack;
