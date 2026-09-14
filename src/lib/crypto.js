/**
 * Crypto helpers that work unchanged on Cloudflare Workers and in Node 22+.
 * Everything uses WebCrypto — no Node-only APIs, no native modules.
 */

const subtle = globalThis.crypto?.subtle;

/** @param {number} n */
export function randomBytes(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** URL-safe base64 (no padding). */
export function bytesToBase64Url(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = '';
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Cryptographically random string from an unambiguous base62 alphabet (no `-`/`_`). */
export function randomToken(length = 32) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += B64_ALPHABET[bytes[i] % 62];
  return out;
}

/** @param {ArrayBuffer | Uint8Array | string} data */
function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** @param {ArrayBuffer | Uint8Array | string} data */
export async function sha256Hex(data) {
  if (!subtle) throw new Error('WebCrypto unavailable');
  return toHex(await subtle.digest('SHA-256', /** @type {BufferSource} */ (toBytes(data))));
}

/** Keyed hash used to pseudonymise IP addresses (never stored raw). */
export async function hmacSha256Hex(secret, data) {
  if (!subtle) throw new Error('WebCrypto unavailable');
  const key = await subtle.importKey(
    'raw',
    /** @type {BufferSource} */ (toBytes(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await subtle.sign('HMAC', key, /** @type {BufferSource} */ (toBytes(data))));
}

const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_KEY_LENGTH = 256; // bits

/**
 * Hash a password with PBKDF2-HMAC-SHA256 (salted).
 * Stored as a single self-describing string: `pbkdf2-sha256$iterations$salt$hash`.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

/**
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  let salt;
  try {
    salt = base64UrlToBytes(parts[2]);
  } catch {
    return false;
  }
  const expected = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(base64UrlToBytes(parts[3]), new Uint8Array(expected));
}

async function pbkdf2(password, salt, iterations) {
  if (!subtle) throw new Error('WebCrypto unavailable');
  const keyMaterial = await subtle.importKey(
    'raw',
    /** @type {BufferSource} */ (toBytes(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return await subtle.deriveBits(
    { name: 'PBKDF2', salt: /** @type {BufferSource} */ (salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    PBKDF2_KEY_LENGTH,
  );
}

/** Constant-time comparison of equal-length byte arrays. */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Constant-time comparison of strings (used for API keys / session tokens). */
export function safeEqual(a, b) {
  return timingSafeEqual(new TextEncoder().encode(String(a)), new TextEncoder().encode(String(b)));
}
