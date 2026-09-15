/**
 * Test harness: runs the real application code against an in-memory SQLite
 * database through the same `handleRequest` the Worker uses.
 */

import { handleRequest } from '../src/app.js';
import { ensureSchema } from '../src/db/schema.js';
import { createNodeDb } from '../src/db/node-sqlite.js';

export const ORIGIN = 'https://mantisbin.test';

/**
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 */
export async function createApp(options = {}) {
  const db = createNodeDb(':memory:');
  await ensureSchema(db);
  const env = { APP_SECRET: 'test-secret-value', SITE_URL: ORIGIN, ...options.env };

  /** @type {Map<string, Map<string, string>>} named cookie jars */
  const jars = new Map();

  function jar(name = 'default') {
    if (!jars.has(name)) jars.set(name, new Map());
    return jars.get(name);
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: string | Uint8Array, headers?: Record<string,string>, jar?: string, ip?: string }} [opts]
   * @returns {Promise<Response>}
   */
  async function request(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    const cookies = jar(opts.jar);
    if (cookies.size) {
      headers.set('cookie', [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    if (opts.ip) headers.set('x-forwarded-for', opts.ip);
    let body = opts.body;
    if (typeof body === 'string' && !headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
    }
    if (body instanceof Uint8Array && !headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
    }
    const request = new Request(ORIGIN + path, {
      method: opts.method || (body ? 'POST' : 'GET'),
      headers,
      body: body === undefined ? undefined : /** @type {any} */ (body),
    });
    const response = await handleRequest({ request, env, db });
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/Max-Age=0/i.test(setCookie)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  }

  return {
    db,
    env,
    request,
    jar,
    /** Close the underlying database. */
    async close() {
      await db.close?.();
    },
  };
}

/** URL-encoded form body from an object. */
export function form(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params.toString();
}

export function jsonBody(values) {
  return JSON.stringify(values);
}

/** Pull the paste id out of a `Location: /p/:id?created=1` header. */
export function pasteIdFrom(response) {
  const location = response.headers.get('location') || '';
  const match = /\/p\/([A-Za-z0-9]+)/.exec(location);
  return match ? match[1] : null;
}

/** Register + return a session jar name with a fresh account. */
export async function registerUser(app, username, password = 'correct-horse-1', jarName = username) {
  const response = await app.request('/register', { body: form({ username, password }), jar: jarName });
  return response;
}

export async function createApiKeyFor(app, jarName) {
  const response = await app.request('/me/keys', { body: form({ label: 'tests' }), jar: jarName });
  const html = await response.text();
  const match = /id="new-key"[^>]*value="([^"]+)"/.exec(html);
  if (!match) throw new Error(`no api key in response (status ${response.status})`);
  return match[1];
}
