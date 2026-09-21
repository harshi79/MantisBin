/**
 * Public profiles + account settings.
 *
 *   GET  /u/:username             public profile: avatar, stats, public pastes (indexable)
 *   GET  /u/:username/avatar.svg  deterministic avatar image (immutable, public)
 *   GET  /api/users/:username     the same profile as JSON (metadata only)
 *   GET  /me/settings             account hub: profile link, password, sessions, delete
 *   POST /me/password             change password (revokes other sessions)
 *   POST /me/sessions/revoke      revoke one session by id
 *   POST /me/delete               delete the account, anonymise its pastes
 *
 * Profiles are strictly opt-in: a paste appears here only when its owner sets
 * it to `public`. Unlisted pastes, anonymous pastes and expired/consumed pastes
 * never appear, and flipping a paste back to unlisted unlists it immediately.
 * Paste pages themselves stay `noindex` — the profile is the discovery
 * surface, and it links titles, never content, for search engines to find.
 */

import { COOKIE, PROFILE_PASTE_LIMIT, RATE_LIMITS } from '../config.js';
import {
  authenticate,
  changePassword,
  clearSessionCookie,
  currentSessionRowId,
  destroyUser,
  findUserById,
  findUserByUsername,
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from '../lib/auth.js';
import { avatarSvg } from '../lib/avatar.js';
import {
  HttpError,
  headers,
  htmlResponse,
  jsonResponse,
  parseForm,
  readBody,
  redirect,
  svgResponse,
} from '../lib/http.js';
import { consume } from '../lib/ratelimit.js';
import { listPublicPastes, userStats } from '../lib/pastes.js';
import { validateUsername } from '../lib/validate.js';
import { serializePaste } from './api.js';
import { withThumbnails } from './web.js';
import { goodbyePage, settingsPage } from '../views/settings.js';
import { profilePage } from '../views/profile.js';

/** @typedef {import('../app.js').Ctx} Ctx */

function pageCtx(ctx) {
  return { theme: ctx.theme, user: ctx.user, path: ctx.url.pathname };
}

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

/** GET /me/settings */
export async function settings(ctx) {
  if (!ctx.user) return redirect(`/login?next=${encodeURIComponent('/me/settings')}`);
  return renderSettings(ctx, {});
}

/**
 * @param {Ctx} ctx
 * @param {{ errors?: string[] | null, notice?: string | null }} [options]
 */
async function renderSettings(ctx, options = {}) {
  const [account, stats, sessions, currentId] = await Promise.all([
    findUserById(ctx.db, ctx.user.id),
    userStats(ctx.db, ctx.user.id, ctx.now),
    listSessions(ctx.db, ctx.user.id, ctx.now),
    currentSessionRowId(ctx.db, ctx.cookies[COOKIE.session]),
  ]);
  if (!account) throw new HttpError(401, 'That account no longer exists.');
  const query = ctx.url.searchParams;
  const notice =
    options.notice ??
    (query.get('password') === '1'
      ? 'Password changed. Every other session was signed out.'
      : query.get('revoked') === '1'
        ? 'Session revoked.'
        : null);
  const body = settingsPage({
    ...pageCtx(ctx),
    account: { id: account.id, username: account.username, created_at: account.created_at },
    stats,
    sessions,
    currentSessionId: currentId,
    profileUrl: `${ctx.url.origin}/u/${account.username}`,
    errors: options.errors || null,
    notice,
  });
  return htmlResponse(body, options.errors ? 400 : 200, {}, { noindex: true });
}

/** POST /me/password — the current password is always required. */
export async function updatePassword(ctx) {
  if (!ctx.user) throw new HttpError(401);
  const verdict = await consume(ctx.db, `auth:${ctx.ip}`, RATE_LIMITS.auth);
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many attempts. Wait a few minutes.', { 'Retry-After': String(verdict.retryAfter) });
  }
  const form = parseForm(await readBody(ctx.request, 16 * 1024));
  const result = await changePassword(ctx.db, ctx.user.id, form.current_password, form.new_password);
  if (!result.ok) return renderSettings(ctx, { errors: [result.error] });
  await revokeOtherSessions(ctx.db, ctx.user.id, ctx.cookies[COOKIE.session]);
  return redirect('/me/settings?password=1');
}

/** POST /me/sessions/revoke */
export async function revoke(ctx) {
  if (!ctx.user) throw new HttpError(401);
  const form = parseForm(await readBody(ctx.request, 4 * 1024));
  const currentId = await currentSessionRowId(ctx.db, ctx.cookies[COOKIE.session]);
  const revokedCurrent = currentId !== null && Number(form.id) === currentId;
  await revokeSession(ctx.db, ctx.user.id, form.id);
  if (revokedCurrent) {
    return new Response(null, {
      status: 303,
      headers: headers({ Location: '/login', 'Set-Cookie': clearSessionCookie(ctx.secure) }),
    });
  }
  return redirect('/me/settings?revoked=1');
}

/**
 * POST /me/delete — password-confirmed. The account, its sessions and its API
 * keys are deleted; owned pastes are anonymised (URLs keep working, the owner
 * is cleared and anything public drops back to unlisted).
 */
export async function removeAccount(ctx) {
  if (!ctx.user) throw new HttpError(401);
  const verdict = await consume(ctx.db, `auth:${ctx.ip}`, RATE_LIMITS.auth);
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many attempts. Wait a few minutes.', { 'Retry-After': String(verdict.retryAfter) });
  }
  const form = parseForm(await readBody(ctx.request, 16 * 1024));
  const account = await findUserById(ctx.db, ctx.user.id);
  const ok = account && (await authenticate(ctx.db, account.username, form.password));
  if (!ok) return renderSettings(ctx, { errors: ['That password is not correct — the account was not deleted.'] });
  const { pastes } = await destroyUser(ctx.db, account.id);
  const body = goodbyePage({ theme: ctx.theme, user: null, path: '/me/settings', pastes });
  return htmlResponse(body, 200, { 'Set-Cookie': clearSessionCookie(ctx.secure) }, { noindex: true });
}

// ---------------------------------------------------------------------------
// Public profiles
// ---------------------------------------------------------------------------

/**
 * @param {Db} db
 * @param {string} raw
 * @returns {Promise<{ id: number, username: string, created_at: number }>}
 * @typedef {import('../db/turso.js').Db} Db
 */
async function requireProfileAccount(db, raw) {
  const username = validateUsername(raw);
  if (!username.ok) throw new HttpError(404, 'No such profile.');
  const account = await findUserByUsername(db, username.value);
  if (!account) throw new HttpError(404, 'No such profile.');
  return account;
}

/** GET /u/:username — the opt-in discovery surface (indexable, content-free). */
export async function publicProfile(ctx, params) {
  const account = await requireProfileAccount(ctx.db, params.username);
  const [pastes, stats] = await Promise.all([
    listPublicPastes(ctx.db, account.id, PROFILE_PASTE_LIMIT, ctx.now),
    userStats(ctx.db, account.id, ctx.now),
  ]);
  const isOwner = !!ctx.user && Number(ctx.user.id) === Number(account.id);
  const body = profilePage({
    ...pageCtx(ctx),
    account: { username: account.username, created_at: account.created_at },
    pastes: withThumbnails(pastes, ctx.env),
    stats,
    isOwner,
  });
  // Owners see manage links, so their copy is never cached; the visitor copy
  // is a plain public page.
  return htmlResponse(body, 200, {}, isOwner ? { cache: 'no-store' } : { cache: 'public, max-age=60' });
}

/** GET /u/:username/avatar.svg — deterministic forever (usernames never change). */
export async function avatar(ctx, params) {
  const account = await requireProfileAccount(ctx.db, params.username);
  return svgResponse(avatarSvg(account.username), {}, { cache: 'public, max-age=31536000, immutable' });
}

/** GET /api/users/:username — profile metadata as JSON (never content). */
export async function apiProfile(ctx, params) {
  const verdict = await consume(ctx.db, `apiread:${ctx.ip}`, RATE_LIMITS.apiRead);
  if (!verdict.ok) {
    throw new HttpError(429, 'Rate limit exceeded.', { 'Retry-After': String(verdict.retryAfter) });
  }
  const account = await requireProfileAccount(ctx.db, params.username);
  const pastes = await listPublicPastes(ctx.db, account.id, PROFILE_PASTE_LIMIT, ctx.now);
  return jsonResponse({
    username: account.username,
    createdAt: new Date(Number(account.created_at) * 1000).toISOString(),
    pastes: pastes.map((paste) => serializePaste(paste, ctx.url.origin, { env: ctx.env })),
  });
}
