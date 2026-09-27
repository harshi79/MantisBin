/** Separate, secret-backed administrator authentication. No account can grant itself access. */
import { hmacSha256Hex, randomToken, safeEqual, sha256Hex } from './crypto.js';
import { HttpError, parseForm, readBody } from './http.js';
import { consume } from './ratelimit.js';

export const ADMIN_COOKIE = 'mb_admin';
export const ADMIN_LOGIN_COOKIE = 'mb_admin_login';
export const ADMIN_TTL = 3600;

/** Fail closed for missing or undersized configuration. Never expose secret values. */
export function adminEnabled(env) {
  return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.trim().length >= 16 &&
    env.ADMIN_PASSWORD.length <= 256 && typeof env.APP_SECRET === 'string' && env.APP_SECRET.length >= 16;
}

export function requireAdminConfig(ctx) {
  if (!adminEnabled(ctx.env)) throw new HttpError(503, 'Administration is disabled. Configure ADMIN_PASSWORD (16–256 characters) and APP_SECRET (at least 16 characters) as Cloudflare secrets.');
}

export function adminCookie(name, token, secure, maxAge = ADMIN_TTL) {
  return `${name}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

async function credentialVersion(env) {
  return hmacSha256Hex(env.APP_SECRET, `admin-credential:v1:${env.ADMIN_PASSWORD}`);
}

export function auditStatement(actor, action, target, reason, now) {
  return {
    sql: 'INSERT INTO admin_audit (actor, action, target, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    params: [actor, action, target, reason, now],
  };
}

/** Database hashes are not bearer credentials. Rotating either secret invalidates sessions. */
export async function resolveAdmin(ctx) {
  requireAdminConfig(ctx);
  const token = ctx.cookies[ADMIN_COOKIE];
  if (!token || !/^[A-Za-z0-9]{48}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const session = await ctx.db.get('SELECT actor, credential_version, expires_at FROM admin_sessions WHERE token_hash = ?', [tokenHash]);
  if (!session) return null;
  if (Number(session.expires_at) <= ctx.now || !safeEqual(session.credential_version, await credentialVersion(ctx.env))) {
    await ctx.db.run('DELETE FROM admin_sessions WHERE token_hash = ?', [tokenHash]);
    return null;
  }
  return {
    actor: String(session.actor), tokenHash,
    csrf: await hmacSha256Hex(ctx.env.APP_SECRET, `admin-csrf:v1:${token}`),
  };
}

export async function requireAdmin(ctx) {
  const session = await resolveAdmin(ctx);
  if (!session) throw new HttpError(401, 'Your administrator session has expired. Sign in at /admin/login.');
  return session;
}

/** All admin POSTs require both an exact same-origin request and a form token. */
export async function adminForm(ctx, expectedCsrf) {
  const origin = ctx.request.headers.get('origin');
  if (origin !== ctx.url.origin) throw new HttpError(403, 'Administrator actions require a same-origin request.');
  if (!(ctx.request.headers.get('content-type') || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new HttpError(415, 'Submit an HTML form.');
  }
  const form = parseForm(await readBody(ctx.request, 4096));
  if (!expectedCsrf || !form.csrf || !safeEqual(form.csrf, expectedCsrf)) throw new HttpError(403, 'Invalid form token. Reload the page and try again.');
  return form;
}

export async function checkAdminPassword(ctx, password) {
  // Keyed pseudonyms, not raw IP addresses, persist in the rate-limit table.
  const ip = await hmacSha256Hex(ctx.env.APP_SECRET, `admin-login:${ctx.ip}`);
  const local = await consume(ctx.db, `admin:login:${ip}`, { limit: 5, window: 900 }, ctx.now);
  const global = await consume(ctx.db, 'admin:login:global', { limit: 50, window: 900 }, ctx.now);
  if (!local.ok || !global.ok) throw new HttpError(429, 'Too many administrator sign-in attempts. Try again later.', {
    'Retry-After': String(!local.ok ? local.retryAfter : global.retryAfter),
  });
  // Compare equal-length digests instead of short-circuiting on password prefixes.
  return safeEqual(await sha256Hex(String(password || '')), await sha256Hex(ctx.env.ADMIN_PASSWORD));
}

export async function startAdminSession(ctx) {
  const token = randomToken(48);
  const tokenHash = await sha256Hex(token);
  const actor = `admin-${randomToken(12)}`;
  const old = ctx.cookies[ADMIN_COOKIE];
  await ctx.db.batch([
    { sql: 'DELETE FROM admin_sessions WHERE expires_at <= ?', params: [ctx.now] },
    { sql: 'DELETE FROM admin_sessions WHERE token_hash = ?', params: [old ? await sha256Hex(old) : ''] },
    { sql: 'INSERT INTO admin_sessions (token_hash, actor, credential_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      params: [tokenHash, actor, await credentialVersion(ctx.env), ctx.now, ctx.now + ADMIN_TTL] },
    auditStatement(actor, 'login', 'admin', 'Password sign-in', ctx.now),
  ]);
  return token;
}
