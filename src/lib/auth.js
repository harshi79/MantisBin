/**
 * Accounts, sessions and API keys.
 *
 *  - Passwords: PBKDF2-HMAC-SHA256, 100k iterations (the Cloudflare Workers
 *    ceiling), per-user random salt. The count lives in the stored string, so
 *    it can be tuned without invalidating existing passwords.
 *  - Sessions: opaque random tokens in an HttpOnly cookie; only their SHA-256
 *    hash is stored, so a database leak cannot be replayed as a session.
 *  - API keys: `mb_` + 32 random chars, stored as a SHA-256 hash with a short
 *    display prefix. The plaintext is shown exactly once.
 */

import { COOKIE, SESSION_TTL_SECONDS } from '../config.js';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from './crypto.js';
import { validatePassword, validateUsername } from './validate.js';

/** @typedef {import('../db/turso.js').Db} Db */

/**
 * @typedef {object} User
 * @property {number} id
 * @property {string} username
 * @property {string} password
 * @property {number} created_at
 */

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/** @param {string | null} header */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

/** @param {string} name @param {string} value @param {{ maxAge?: number, secure?: boolean }} [options] */
export function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly'];
  parts.push(`SameSite=Lax`);
  if (options.secure) parts.push('Secure');
  parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge ?? 0))}`);
  return parts.join('; ');
}

export function sessionCookie(token, { maxAge = SESSION_TTL_SECONDS, secure = true } = {}) {
  return cookie(COOKIE.session, token, { maxAge, secure });
}

export function clearSessionCookie(secure = true) {
  return cookie(COOKIE.session, '', { maxAge: 0, secure });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * @param {Db} db
 * @returns {Promise<{ ok: boolean, user?: User, error?: string, field?: string }>}
 */
export async function registerUser(db, rawUsername, rawPassword, now = Math.floor(Date.now() / 1000)) {
  const username = validateUsername(rawUsername);
  if (!username.ok) return { ok: false, error: username.error, field: 'username' };
  const password = validatePassword(rawPassword);
  if (!password.ok) return { ok: false, error: password.error, field: 'password' };

  const existing = await db.get('SELECT id FROM users WHERE username_key = ?', [
    username.value.toLowerCase(),
  ]);
  if (existing) {
    return { ok: false, error: 'That username is already taken.', field: 'username' };
  }

  const hash = await hashPassword(password.value);
  const result = await db.run(
    'INSERT INTO users (username, username_key, password, created_at) VALUES (?, ?, ?, ?)',
    [username.value, username.value.toLowerCase(), hash, now],
  );
  return {
    ok: true,
    user: {
      id: Number(result.lastInsertRowid),
      username: username.value,
      password: hash,
      created_at: now,
    },
  };
}

/** @param {Db} db */
export async function findUserByUsername(db, username) {
  const key = String(username || '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  const row = await db.get('SELECT id, username, password, created_at FROM users WHERE username_key = ?', [key]);
  return /** @type {User | null} */ (row);
}

/** @param {Db} db */
export async function findUserById(db, id) {
  if (!Number.isFinite(Number(id))) return null;
  const row = await db.get('SELECT id, username, password, created_at FROM users WHERE id = ?', [Number(id)]);
  return /** @type {User | null} */ (row);
}

/**
 * @param {Db} db
 * @returns {Promise<User | null>}
 */
/** Built once per isolate so a missing user costs the same work as a wrong password. */
let dummyHashPromise = null;

async function burnPasswordTime(password) {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('mantisbin-timing-equaliser-never-matches');
  await verifyPassword(String(password || ''), await dummyHashPromise);
}

export async function authenticate(db, username, password) {
  const user = await findUserByUsername(db, username);
  if (!user) {
    // Hash a dummy password so a missing user costs the same time as a wrong one.
    await burnPasswordTime(password);
    return null;
  }
  if (typeof password !== 'string' || password.length === 0) return null;
  const ok = await verifyPassword(password, user.password);
  return ok ? user : null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * @param {Db} db
 * @returns {Promise<{ token: string, expiresAt: number }>}
 */
export async function createSession(db, userId, ipHash = null, now = Math.floor(Date.now() / 1000)) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_SECONDS;
  await db.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip_hash) VALUES (?, ?, ?, ?, ?)',
    [tokenHash, userId, now, expiresAt, ipHash],
  );
  return { token, expiresAt };
}

/**
 * Resolve a session cookie to a user. Expired sessions are dropped lazily.
 * @param {Db} db
 * @returns {Promise<{ user: User, tokenHash: string, expiresAt: number } | null>}
 */
export async function resolveSession(db, token, now = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  const tokenHash = await sha256Hex(token);
  const session = await db.get(
    'SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?',
    [tokenHash],
  );
  if (!session) return null;
  if (Number(session.expires_at) <= now) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    return null;
  }
  const user = await findUserById(db, session.user_id);
  if (!user) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    return null;
  }
  return { user, tokenHash, expiresAt: Number(session.expires_at) };
}

/** @param {Db} db */
export async function destroySession(db, token) {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
}

/** Drop sessions that expired more than a day ago (cleanup job). */
export async function pruneSessions(db, now = Math.floor(Date.now() / 1000), limit = 1000) {
  const result = await db.run(
    'DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at <= ? LIMIT ?)',
    [now - 86400, limit],
  );
  return result.changes;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const API_KEY_PREFIX = 'mb_';

/**
 * @param {Db} db
 * @returns {Promise<{ plain: string, id: number, prefix: string }>}
 */
export async function createApiKey(db, userId, label, now = Math.floor(Date.now() / 1000)) {
  const secret = randomToken(32);
  const plain = `${API_KEY_PREFIX}${secret}`;
  const keyHash = await sha256Hex(plain);
  const prefix = `${API_KEY_PREFIX}${secret.slice(0, 6)}…`;
  const result = await db.run(
    'INSERT INTO api_keys (user_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, keyHash, prefix, String(label || '').slice(0, 40) || null, now],
  );
  return { plain, id: Number(result.lastInsertRowid), prefix };
}

/**
 * Validate a bearer / X-API-Key value.
 * @param {Db} db
 * @returns {Promise<{ key: any, user: User } | null>}
 */
export async function authenticateApiKey(db, plainKey, now = Math.floor(Date.now() / 1000)) {
  if (typeof plainKey !== 'string' || !plainKey.startsWith(API_KEY_PREFIX)) return null;
  const keyHash = await sha256Hex(plainKey.trim());
  const key = await db.get(
    'SELECT id, user_id, key_hash, prefix, label, created_at FROM api_keys WHERE key_hash = ?',
    [keyHash],
  );
  if (!key) return null;
  const user = await findUserById(db, key.user_id);
  if (!user) return null;
  // Fire-and-forget style touch; failures must not break the request.
  await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, key.id]).catch(() => {});
  return { key, user };
}

/** @param {Db} db */
export async function listApiKeys(db, userId) {
  return db.all(
    'SELECT id, prefix, label, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
  );
}

/** @param {Db} db */
export async function revokeApiKey(db, userId, keyId) {
  const result = await db.run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [
    Number(keyId),
    userId,
  ]);
  return result.changes > 0;
}

/** Keep at most 3 active keys per user; returns the ids that were removed. */
export async function enforceApiKeyLimit(db, userId, max = 3) {
  const keys = await listApiKeys(db, userId);
  if (keys.length <= max) return [];
  const stale = keys.slice(max);
  for (const key of stale) await revokeApiKey(db, userId, key.id);
  return stale;
}
