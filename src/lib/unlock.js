/**
 * Paste passphrases and unlock sessions (roadmap 2.2 §1).
 *
 *  - Storage: only a PBKDF2-HMAC-SHA256 hash (`pbkdf2-sha256$iters$salt$hash`,
 *    written by lib/crypto.js). The passphrase itself never reaches the
 *    database, a URL, HTML, a log line or client JavaScript.
 *  - Unlock proof: a stateless, HMAC(APP_SECRET)-signed token in an HttpOnly,
 *    SameSite=Lax cookie — no extra table, no extra query on the hot path. The
 *    signature covers the paste id and the expiry, so a token cannot be moved
 *    to another paste and stops working after `UNLOCK_TTL_SECONDS`.
 *  - Multiple pastes: the cookie holds a short, newest-first list (bounded by
 *    `UNLOCK_MAX_TOKENS`) so unlocking a second paste does not lock you out of
 *    the first one.
 *  - Brute force: lib/ratelimit.js buckets keyed on paste id + IP.
 *
 * Token wire format (all base62/base36/hex, so no cookie escaping needed):
 *
 *   cookie   := entry ( '~' entry )*
 *   entry    := pasteId ':' expiryBase36 ':' macHex
 *   mac      := HMAC-SHA256(APP_SECRET, 'unlock|' pasteId '|' expiryBase36)[0..16]
 */

import { COOKIE, LIMITS, UNLOCK_MAX_TOKENS, UNLOCK_TTL_SECONDS } from '../config.js';
import { cookie } from './auth.js';
import { hmacSha256Hex, hashPassword, safeEqual, verifyPassword } from './crypto.js';

/** Maximum entries inspected from a cookie, whatever the client sends. */
const MAX_PARSED_ENTRIES = 8;
/** Full HMAC is 64 hex chars; 128 bits is plenty for a 30 minute cookie. */
const MAC_LENGTH = 32;

/**
 * Hash a paste passphrase. Same PBKDF2 parameters as account passwords, so the
 * Cloudflare Workers iteration ceiling is enforced in exactly one place.
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
export async function hashPassphrase(passphrase) {
  return hashPassword(String(passphrase));
}

/**
 * Constant-work passphrase check. An empty or over-long value still burns a
 * PBKDF2 round, so verification time does not reveal input shape.
 * @param {unknown} passphrase
 * @param {string | null | undefined} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassphrase(passphrase, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('pbkdf2-sha256$')) return false;
  const candidate = typeof passphrase === 'string' ? passphrase.slice(0, LIMITS.passphraseMax) : '';
  try {
    return await verifyPassword(candidate, stored);
  } catch {
    // A malformed record must never turn a request into a 500.
    return false;
  }
}

/** @param {any} paste */
export function isProtected(paste) {
  return Boolean(paste && paste.password_hash);
}

/** Rate-limit bucket: one paste, one visitor. */
export function unlockBucketKey(pasteId, ip) {
  return `unlock:${pasteId}:${ip}`;
}

function expiryToBase36(expiresAt) {
  return Math.max(0, Math.floor(expiresAt)).toString(36);
}

async function signEntry(secret, pasteId, expiry) {
  const mac = await hmacSha256Hex(secret, `unlock|${pasteId}|${expiry}`);
  return mac.slice(0, MAC_LENGTH);
}

/**
 * Mint an unlock token for one paste.
 * @param {string} secret APP_SECRET
 * @param {string} pasteId
 * @param {number} expiresAt unix seconds
 * @returns {Promise<string>} cookie entry
 */
export async function issueUnlockToken(secret, pasteId, expiresAt) {
  const expiry = expiryToBase36(expiresAt);
  const mac = await signEntry(secret, pasteId, expiry);
  return `${pasteId}:${expiry}:${mac}`;
}

/**
 * Validate one cookie entry.
 * @param {string} entry
 * @param {string} secret
 * @param {string} pasteId
 * @param {number} now unix seconds
 * @returns {Promise<boolean>}
 */
export async function verifyUnlockEntry(entry, secret, pasteId, now) {
  const parts = String(entry || '').split(':');
  if (parts.length !== 3) return false;
  const [id, expiry, mac] = parts;
  if (id !== pasteId) return false;
  if (!/^[A-Za-z0-9]+$/.test(expiry) || !/^[0-9a-f]{32}$/.test(mac)) return false;
  const expiresAt = parseInt(expiry, 36);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const expected = await signEntry(secret, id, expiry);
  return safeEqual(expected, mac);
}

/** True when the cookie already proves this paste (and this paste's token) is unlocked. */
export async function hasUnlock(secret, cookieValue, pasteId, now = Math.floor(Date.now() / 1000)) {
  for (const entry of parseEntries(cookieValue, now)) {
    if (entry.split(':')[0] !== pasteId) continue;
    if (await verifyUnlockEntry(entry, secret, pasteId, now)) return true;
  }
  return false;
}

/**
 * Structural filter: keep only well-formed, unexpired, distinct entries.
 * Signatures are checked lazily (only for the paste being opened), so a cookie
 * carrying junk entries costs nothing.
 * @param {string} cookieValue
 * @param {number} now
 */
export function parseEntries(cookieValue, now = Math.floor(Date.now() / 1000)) {
  const raw = String(cookieValue || '');
  if (!raw) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const entry of raw.split('~').slice(0, MAX_PARSED_ENTRIES)) {
    const parts = entry.split(':');
    if (parts.length !== 3) continue;
    const [id, expiry, mac] = parts;
    if (!/^[A-Za-z0-9]{1,32}$/.test(id)) continue;
    if (!/^[A-Za-z0-9]{1,10}$/.test(expiry) || !/^[0-9a-f]{32}$/.test(mac)) continue;
    if (parseInt(expiry, 36) <= now) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Add/replace an entry, newest first, bounded by `UNLOCK_MAX_TOKENS`.
 * @param {string} cookieValue
 * @param {string} entry
 * @param {number} [now]
 * @param {number} [max] keep this many entries
 */
export function rememberUnlock(cookieValue, entry, now = Math.floor(Date.now() / 1000), max = UNLOCK_MAX_TOKENS) {
  const pasteId = String(entry).split(':')[0];
  const kept = parseEntries(cookieValue, now).filter((item) => item.split(':')[0] !== pasteId);
  return [entry, ...kept].slice(0, Math.max(1, max)).join('~');
}

/**
 * HttpOnly, SameSite=Lax unlock cookie. `auth.cookie()` is the single place
 * that decides cookie flags, so the unlock cookie cannot drift from the
 * session cookie's hardening.
 * @param {string} value
 * @param {{ secure?: boolean, maxAge?: number }} [options]
 */
export function unlockCookieString(value, options = {}) {
  return cookie(COOKIE.unlock, value, {
    maxAge: options.maxAge ?? UNLOCK_TTL_SECONDS,
    secure: options.secure ?? true,
  });
}
