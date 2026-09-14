/**
 * Application core: request context, routing, sessions and error handling.
 * Runtime-agnostic — the same module runs in a Cloudflare Worker and in the
 * Node dev server (see scripts/dev.js) and in tests.
 */

import { COOKIE, SESSION_REFRESH_SECONDS, SESSION_TTL_SECONDS } from './config.js';
import { parseCookies, resolveSession, sessionCookie } from './lib/auth.js';
import { CSP, HttpError, clientIp, headers, htmlResponse, isSecure, jsonResponse } from './lib/http.js';
import { errorPage } from './views/errors.js';
import * as web from './routes/web.js';
import * as api from './routes/api.js';

/**
 * @typedef {object} Ctx
 * @property {Request} request
 * @property {URL} url
 * @property {any} env
 * @property {import('./db/turso.js').Db} db
 * @property {{ id: number, username: string } | null} user
 * @property {Record<string, string>} cookies
 * @property {string} theme
 * @property {boolean} secure
 * @property {string} ip
 * @property {number} now
 */

/** Tiny path router: '/p/:id/raw' -> ^/p/([^/]+)/raw$ */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
}

/** @type {Array<[string, string, (ctx: Ctx, params: Record<string, string>) => Promise<Response>]>} */
const ROUTE_TABLE = [
  ['GET', '/', web.home],
  ['POST', '/p', web.create],
  ['GET', '/p/:id', web.view],
  ['GET', '/p/:id/raw', web.raw],
  ['GET', '/p/:id/edit', web.editForm],
  ['POST', '/p/:id/edit', web.editSave],
  ['POST', '/p/:id/delete', web.remove],
  ['GET', '/login', web.loginForm],
  ['POST', '/login', web.login],
  ['GET', '/register', web.registerForm],
  ['POST', '/register', web.register],
  ['POST', '/logout', web.logout],
  ['POST', '/theme', web.setTheme],
  ['GET', '/me', web.myPastes],
  ['POST', '/me/keys', web.createKey],
  ['POST', '/me/keys/revoke', web.revokeKey],
  ['GET', '/docs', web.docs],
  ['GET', '/favicon.svg', web.favicon],
  ['GET', '/logo.svg', web.logo],
  ['GET', '/mark.svg', web.mark],
  ['GET', '/api/health', api.health],
  ['GET', '/api/meta', api.meta],
  ['POST', '/api/pastes', api.create],
  ['GET', '/api/pastes/mine', api.mine],
  ['GET', '/api/pastes/:id', api.get],
  ['PATCH', '/api/pastes/:id', api.update],
  ['DELETE', '/api/pastes/:id', api.remove],
  ['GET', '/api/pastes/:id/raw', api.raw],
];

const ROUTES = ROUTE_TABLE.map(([method, pattern, handler]) => ({
  method,
  ...compile(pattern),
  handler,
}));

/**
 * @param {{ request: Request, env: any, db: import('./db/turso.js').Db }} args
 * @returns {Promise<Response>}
 */
export async function handleRequest({ request, env, db }) {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const cookies = parseCookies(request.headers.get('cookie'));
  const theme = cookies[COOKIE.theme] === 'light' ? 'light' : cookies[COOKIE.theme] === 'dark' ? 'dark' : 'auto';

  /** @type {Ctx} */
  const ctx = {
    request,
    url,
    env,
    db,
    user: null,
    cookies,
    theme,
    secure: isSecure(request),
    ip: clientIp(request),
    now,
  };

  let sessionCookieValue = null;
  try {
    const token = cookies[COOKIE.session];
    if (token) {
      const session = await resolveSession(db, token, now);
      if (session) {
        ctx.user = { id: session.user.id, username: session.user.username };
        // Slide the session forward when it is getting old.
        if (session.expiresAt - now < SESSION_REFRESH_SECONDS) {
          const expiresAt = now + SESSION_TTL_SECONDS;
          await db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [
            expiresAt,
            session.tokenHash,
          ]);
          sessionCookieValue = sessionCookie(token, { maxAge: SESSION_TTL_SECONDS, secure: ctx.secure });
        }
      }
    }

    const response = await dispatch(ctx);
    if (sessionCookieValue) response.headers.append('Set-Cookie', sessionCookieValue);
    return response;
  } catch (error) {
    return respondWithError(ctx, error);
  }
}

/** @param {Ctx} ctx */
async function dispatch(ctx) {
  const method = ctx.request.method === 'HEAD' ? 'GET' : ctx.request.method;
  const path = ctx.url.pathname.replace(/\/+$/, '') || '/';

  let methodKnown = false;
  for (const route of ROUTES) {
    const match = route.regex.exec(path);
    if (!match) continue;
    methodKnown = true;
    if (route.method !== method) continue;
    /** @type {Record<string, string>} */
    const params = {};
    route.names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]);
    });
    const response = await route.handler(ctx, params);
    if (!response.headers.has('Content-Security-Policy') && isHtml(response)) {
      response.headers.set('Content-Security-Policy', CSP);
    }
    return response;
  }

  if (methodKnown) throw new HttpError(405, 'Use one of the supported methods for this URL.');
  throw new HttpError(404, 'No such page. Paste URLs look like /p/a8Kx92Lm.');
}

function isHtml(response) {
  return (response.headers.get('Content-Type') || '').includes('text/html');
}

/** @param {Ctx} ctx */
function respondWithError(ctx, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const isApi = ctx.url.pathname.startsWith('/api/');

  if (status >= 500) {
    // Log for operators; never show internals to users.
    console.error(`[mantisbin] ${ctx.request.method} ${ctx.url.pathname} -> 500`, error);
  }

  const message =
    error instanceof HttpError && error.message ? error.message : status >= 500 ? undefined : String(error?.message || '');
  const extra = error instanceof HttpError && error.headers ? error.headers : {};

  if (isApi) {
    return jsonResponse(
      { error: message || (status >= 500 ? 'Internal server error.' : 'Request failed.') },
      status,
      extra,
      { noindex: true },
    );
  }

  const body = errorPage({
    status,
    message,
    theme: ctx.theme,
    user: ctx.user,
    path: ctx.url.pathname,
  });
  return htmlResponse(body, status, { ...extra, 'Content-Security-Policy': CSP }, { noindex: true });
}

