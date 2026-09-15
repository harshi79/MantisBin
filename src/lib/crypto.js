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

/**
 * Cloudflare Workers *hard-caps* PBKDF2 at 100 000 iterations per
 * `crypto.subtle.deriveBits()` call. Asking for more throws
 * `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 * supported (requested …)` — which every registration/login turned into a 500.
 *
 * The cap is production-only: `wrangler dev` / Miniflare happily run 1 000 000
 * iterations, so a value above this ceiling tests green locally and then breaks
 * on the edge. Never raise `PBKDF2_ITERATIONS` above `PBKDF2_MAX_ITERATIONS`.
 *
 * The count is embedded in every stored hash (`pbkdf2-sha256$<iters>$…`), so
 * changing it never invalidates existing passwords: verification reads the
 * count back out of the stored string. Lower it (only if a request ever trips
 * the Workers CPU-time limit) rather than raising it.
 */
export const PBKDF2_ITERATIONS = 100_000;
/** Documented Cloudflare Workers ceiling for a single PBKDF2 call. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
/** Floor used when a runtime rejects even the documented ceiling. */
const PBKDF2_MIN_ITERATIONS = 1_000;
const PBKDF2_KEY_LENGTH = 256; // bits

/**
 * Hash a password with PBKDF2-HMAC-SHA256 (salted).
 * Stored as a single self-describing string: `pbkdf2-sha256$iterations$salt$hash`.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { bits, iterations } = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(bits)}`;
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
  let expected;
  try {
    salt = base64UrlToBytes(parts[2]);
    expected = base64UrlToBytes(parts[3]);
  } catch {
    // Corrupt / truncated record: treat as "does not match" instead of throwing.
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  if (iterations > PBKDF2_MAX_ITERATIONS) {
    // Legacy records written by a runtime with a higher ceiling (e.g. local dev)
    // cannot be recomputed here. Fail the login, never the request.
    console.warn(
      `[mantisbin] stored password hash uses ${iterations} PBKDF2 iterations, above this runtime's ${PBKDF2_MAX_ITERATIONS} ceiling; the password has to be reset.`,
    );
  }
  const { bits } = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(expected, new Uint8Array(bits));
}

/**
 * A runtime refusing the iteration count looks like this — workerd throws
 * `NotSupportedError`, other WebCrypto implementations may word it differently.
 * @param {unknown} error
 */
function isIterationLimitError(error) {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = /** @type {Error} */ (error);
  if (name === 'NotSupportedError') return true;
  return /iteration count/i.test(String(message || ''));
}

/**
 * PBKDF2-HMAC-SHA256 that degrades instead of blowing up when the runtime
 * refuses the requested iteration count: it steps down to a supported value.
 * Returns the count actually used so callers can record it next to the salt.
 */
async function pbkdf2(password, salt, iterations) {
  if (!subtle) throw new Error('WebCrypto unavailable');
  const keyMaterial = await subtle.importKey(
    'raw',
    /** @type {BufferSource} */ (toBytes(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const requested = Number.isFinite(iterations) ? Math.floor(iterations) : PBKDF2_MIN_ITERATIONS;
  let count = Math.min(Math.max(requested, PBKDF2_MIN_ITERATIONS), PBKDF2_MAX_ITERATIONS);
  for (;;) {
    try {
      const bits = await subtle.deriveBits(
        { name: 'PBKDF2', salt: /** @type {BufferSource} */ (salt), iterations: count, hash: 'SHA-256' },
        keyMaterial,
        PBKDF2_KEY_LENGTH,
      );
      return { bits, iterations: count };
    } catch (error) {
      if (!isIterationLimitError(error) || count <= PBKDF2_MIN_ITERATIONS) throw error;
      count = Math.max(PBKDF2_MIN_ITERATIONS, Math.floor(count / 2));
      console.warn(`[mantisbin] PBKDF2 rejected ${requested} iterations on this runtime; retrying with ${count}.`);
    }
  }
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
