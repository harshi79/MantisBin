/**
 * Tiny HTTP helpers shared by the web and API routers.
 */

import { SafeHtml } from './html.js';
import { allowedThumbnailHosts } from './thumbnail.js';

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} [message]
   * @param {Record<string, string>} [headers]
   */
  constructor(status, message, headers) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Frame-Options': 'DENY',
};

/**
 * Strict CSP: everything is same-origin, nothing is inlined.
 *
 * `img-src` is the one directive that is not purely `'self'`, because paste
 * thumbnails are hosted off-site. It lists the *exact* image hosts from
 * `lib/thumbnail.js` — never `https:` — so a stored URL that somehow escaped
 * validation still cannot make a reader's browser talk to an arbitrary origin.
 */
function cspFor(env) {
  const images = ["'self'", 'data:', ...allowedThumbnailHosts(env).map((host) => `https://${host}`)];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${images.join(' ')}`,
    "font-src 'none'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Policy for a request's environment; cached per env object (one per isolate). */
const cspCache = new WeakMap();

/** @param {any} [env] */
export function contentSecurityPolicy(env) {
  if (!env || typeof env !== 'object') return cspFor(env);
  let policy = cspCache.get(env);
  if (!policy) {
    policy = cspFor(env);
    cspCache.set(env, policy);
  }
  return policy;
}

/** The default policy (no operator-configured hosts) — used by tests and fallbacks. */
export const CSP = cspFor({});

/**
 * @param {Record<string, string>} [extra]
 * @param {{ noindex?: boolean, cache?: string }} [options]
 */
export function headers(extra = {}, options = {}) {
  const out = { ...BASE_HEADERS, ...extra };
  if (options.noindex) out['X-Robots-Tag'] = 'noindex, nofollow';
  if (options.cache) out['Cache-Control'] = options.cache;
  else if (out['Cache-Control'] === undefined) out['Cache-Control'] = 'no-store';
  return out;
}

/** @param {SafeHtml | string} body */
export function htmlResponse(body, status = 200, extra = {}, options = {}) {
  return new Response(String(body), {
    status,
    headers: headers({ 'Content-Type': 'text/html; charset=utf-8', ...extra }, options),
  });
}

export function jsonResponse(data, status = 200, extra = {}, options = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=utf-8', ...extra }, options),
  });
}

export function textResponse(text, status = 200, extra = {}, options = {}) {
  return new Response(text, {
    status,
    headers: headers({ 'Content-Type': 'text/plain; charset=utf-8', ...extra }, options),
  });
}

export function svgResponse(svg, extra = {}, options = {}) {
  return new Response(svg, {
    status: 200,
    headers: headers({ 'Content-Type': 'image/svg+xml', ...extra }, options),
  });
}

export function redirect(location, status = 303) {
  return new Response(null, {
    status,
    headers: headers({ Location: location, 'Cache-Control': 'no-store' }),
  });
}

/** True when the outer request arrived over TLS (Cloudflare terminates TLS). */
export function isSecure(request) {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return true;
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0].trim() === 'https';
  return false;
}

/** Best-effort client IP; only ever hashed, never stored raw. */
export function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return 'unknown';
}

/**
 * Read a request body as text with a hard byte ceiling.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export async function readBody(request, maxBytes) {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(413, 'Request body is too large.');
    }
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new HttpError(413, 'Request body is too large.');
  }
  return new TextDecoder().decode(buffer);
}

/** Parse an urlencoded form body into a plain object (last value wins). */
export function parseForm(text) {
  const params = new URLSearchParams(text);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of params.entries()) {
    if (key.length > 200) continue; // ignore junk keys
    out[key] = value;
  }
  return out;
}

/** Parse a JSON body, rejecting anything that is not an object. */
export function parseJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Body must be a JSON object.');
  }
  return value;
}

/** Only allow same-site relative redirects. */
export function safeRedirectTarget(value, fallback = '/') {
  const target = String(value || '');
  if (!target.startsWith('/') || target.startsWith('//')) return fallback;
  if (/[\r\n]/.test(target)) return fallback;
  return target.slice(0, 500);
}
