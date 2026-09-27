/** Server-rendered administration. Every entry point checks the separate admin session. */
import { ADMIN_COOKIE, ADMIN_LOGIN_COOKIE, adminCookie, adminForm, auditStatement, checkAdminPassword,
  requireAdmin, requireAdminConfig, resolveAdmin, startAdminSession } from '../lib/admin.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError, htmlResponse, redirect } from '../lib/http.js';
import { consume } from '../lib/ratelimit.js';
import { adminLoginPage, adminPage, confirmationPage } from '../views/admin.js';

const PAGE_SIZE = 25;
const ACTIVE = '(p.expires_at IS NULL OR p.expires_at > ?) AND p.burned = 0';

export const ACTIONS = {
  delete_paste: { label: 'Delete paste', type: 'paste', explanation: 'Permanently deletes this paste and its view log. External thumbnail images are not deleted from their host.' },
  suspend_user: { label: 'Suspend account', type: 'user', explanation: 'Blocks sign-in and API authentication and revokes all sessions and API keys. Existing pastes stay readable; remove abusive pastes separately.' },
  restore_user: { label: 'Restore account', type: 'user', explanation: 'Allows this account to sign in again. Previously revoked sessions and API keys are not restored.' },
  revoke_user: { label: 'Revoke access', type: 'user', explanation: 'Signs out every session and permanently revokes every API key. The account can sign in again unless suspended.' },
  delete_user: { label: 'Delete account', type: 'user', explanation: 'Permanently deletes the account, sessions and API keys. Pastes are kept but anonymised and made unlisted. This cannot be undone.' },
  cleanup: { label: 'Clean expired pastes', type: 'maintenance', explanation: 'Permanently removes up to 200 expired or already-consumed pastes and their view logs. Active one-time pastes are never read or consumed.' },
};

function page(ctx, body, status = 200) {
  return htmlResponse(body, status, { 'Referrer-Policy': 'same-origin' }, { noindex: true });
}

function paging(ctx) {
  const value = Number(ctx.url.searchParams.get('page') || 1);
  const number = Number.isSafeInteger(value) ? Math.min(10000, Math.max(1, value)) : 1;
  return { number, offset: (number - 1) * PAGE_SIZE };
}

export async function loginForm(ctx) {
  requireAdminConfig(ctx);
  if (await resolveAdmin(ctx)) return redirect('/admin');
  const csrf = randomToken(48);
  const response = page(ctx, adminLoginPage(ctx, csrf));
  response.headers.append('Set-Cookie', adminCookie(ADMIN_LOGIN_COOKIE, csrf, ctx.secure, 600));
  return response;
}

export async function login(ctx) {
  requireAdminConfig(ctx);
  const csrf = ctx.cookies[ADMIN_LOGIN_COOKIE];
  const form = await adminForm(ctx, /^[A-Za-z0-9]{48}$/.test(csrf || '') ? csrf : '');
  if (!(await checkAdminPassword(ctx, form.password))) {
    await ctx.db.batch([auditStatement('unauthenticated', 'login_failed', 'admin', 'Invalid administrator password', ctx.now)]);
    return page(ctx, adminLoginPage(ctx, csrf, 'Incorrect administrator password.'), 401);
  }
  const token = await startAdminSession(ctx);
  const response = redirect('/admin');
  response.headers.append('Set-Cookie', adminCookie(ADMIN_COOKIE, token, ctx.secure));
  response.headers.append('Set-Cookie', adminCookie(ADMIN_LOGIN_COOKIE, '', ctx.secure, 0));
  return response;
}

export async function logout(ctx) {
  const session = await requireAdmin(ctx);
  await adminForm(ctx, session.csrf);
  await ctx.db.batch([
    { sql: 'DELETE FROM admin_sessions WHERE token_hash = ?', params: [session.tokenHash] },
    auditStatement(session.actor, 'logout', 'admin', 'Signed out', ctx.now),
  ]);
  const response = redirect('/admin/login');
  response.headers.append('Set-Cookie', adminCookie(ADMIN_COOKIE, '', ctx.secure, 0));
  return response;
}

export async function overview(ctx) {
  const session = await resolveAdmin(ctx);
  if (!session) return redirect('/admin/login');
  const start = Math.floor(ctx.now / 86400) * 86400 - 13 * 86400;
  const [pastes, users, daily, audit] = await Promise.all([
    ctx.db.get(`SELECT COUNT(*) AS stored, COALESCE(SUM(size), 0) AS bytes,
      COALESCE(SUM(CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN ${ACTIVE} AND p.user_id IS NULL THEN 1 ELSE 0 END), 0) AS guests,
      COALESCE(SUM(views), 0) AS views FROM pastes p`, [ctx.now, ctx.now]),
    ctx.db.get('SELECT COUNT(*) AS total, COUNT(suspended_at) AS suspended FROM users'),
    ctx.db.all(`SELECT CAST(created_at / 86400 AS INTEGER) * 86400 AS day,
      SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS guests,
      SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) AS accounts
      FROM pastes WHERE created_at >= ? AND created_at <= ? GROUP BY day ORDER BY day`, [start, ctx.now]),
    ctx.db.all('SELECT actor, action, target, reason, created_at FROM admin_audit ORDER BY created_at DESC, id DESC LIMIT 5'),
  ]);
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = start + i * 86400;
    return daily.find((row) => Number(row.day) === day) || { day, guests: 0, accounts: 0 };
  });
  return page(ctx, adminPage(ctx, session, 'overview', { pastes, users, days, audit }));
}

export async function pastes(ctx) {
  const session = await requireAdmin(ctx);
  const { number, offset } = paging(ctx);
  const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 80);
  const owner = ctx.url.searchParams.get('owner') || '';
  const state = ctx.url.searchParams.get('state') || '';
  const protection = ctx.url.searchParams.get('protection') || '';
  const clauses = ['1 = 1'];
  const params = [];
  if (q) { clauses.push('(instr(lower(p.id), lower(?)) > 0 OR instr(u.username_key, lower(?)) > 0)'); params.push(q, q); }
  if (owner === 'guest') clauses.push('p.user_id IS NULL');
  if (owner === 'account') clauses.push('p.user_id IS NOT NULL');
  if (state === 'active') { clauses.push(ACTIVE); params.push(ctx.now); }
  if (state === 'expired') { clauses.push('((p.expires_at IS NOT NULL AND p.expires_at <= ?) OR p.burned = 1)'); params.push(ctx.now); }
  if (protection === 'password') clauses.push("p.password_hash IS NOT NULL AND p.password_hash != ''");
  if (protection === 'burn') clauses.push("p.burn_mode != 'never'");
  // Deliberately never select title, content, thumbnail URLs or password hashes.
  const rows = await ctx.db.all(`SELECT p.id, p.language, p.size, p.views, p.created_at, p.expires_at,
    p.burn_mode, p.burned, CASE WHEN p.password_hash IS NOT NULL AND p.password_hash != '' THEN 1 ELSE 0 END AS protected,
    p.user_id, u.username FROM pastes p LEFT JOIN users u ON u.id = p.user_id
    WHERE ${clauses.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, [...params, PAGE_SIZE + 1, offset]);
  return page(ctx, adminPage(ctx, session, 'pastes', { rows: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE, number, q, owner, state, protection }));
}

export async function users(ctx) {
  const session = await requireAdmin(ctx);
  const { number, offset } = paging(ctx);
  const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 80);
  const state = ctx.url.searchParams.get('state') === 'suspended' ? 'suspended' : '';
  const rows = await ctx.db.all(`SELECT u.id, u.username, u.created_at, u.suspended_at,
    (SELECT COUNT(*) FROM pastes p WHERE p.user_id = u.id) AS pastes
    FROM users u WHERE instr(u.username_key, lower(?)) > 0 ${state ? 'AND u.suspended_at IS NOT NULL' : ''}
    ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`, [q, PAGE_SIZE + 1, offset]);
  return page(ctx, adminPage(ctx, session, 'users', { rows: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE, number, q, state }));
}

export async function audit(ctx) {
  const session = await requireAdmin(ctx);
  const { number, offset } = paging(ctx);
  const rows = await ctx.db.all('SELECT actor, action, target, reason, created_at FROM admin_audit ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [PAGE_SIZE + 1, offset]);
  return page(ctx, adminPage(ctx, session, 'audit', { rows: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE, number }));
}

async function actionTarget(ctx, action, target) {
  if (!Object.hasOwn(ACTIONS, action)) throw new HttpError(400, 'Unknown administrator action.');
  const spec = ACTIONS[action];
  if (spec.type === 'maintenance') return { target: 'expired', label: 'Expired and consumed pastes', spec };
  if (spec.type === 'paste') {
    if (!/^[A-Za-z0-9]{8}$/.test(target || '')) throw new HttpError(400, 'Invalid paste ID.');
    const row = await ctx.db.get('SELECT id FROM pastes WHERE id = ?', [target]);
    if (!row) throw new HttpError(404, 'That paste no longer exists.');
    return { target, label: `Paste ${target}`, spec };
  }
  if (!/^[1-9][0-9]{0,14}$/.test(target || '')) throw new HttpError(400, 'Invalid account ID.');
  const row = await ctx.db.get('SELECT id, username FROM users WHERE id = ?', [Number(target)]);
  if (!row) throw new HttpError(404, 'That account no longer exists.');
  return { target: String(row.id), label: `Account ${row.username} (#${row.id})`, spec };
}

export async function confirm(ctx) {
  const session = await requireAdmin(ctx);
  const action = ctx.url.searchParams.get('action') || '';
  const target = await actionTarget(ctx, action, ctx.url.searchParams.get('target') || '');
  return page(ctx, confirmationPage(ctx, session, action, target));
}

export async function perform(ctx) {
  const session = await requireAdmin(ctx);
  const form = await adminForm(ctx, session.csrf);
  const reason = (form.reason || '').trim();
  if (form.confirm !== 'yes' || reason.length < 5 || reason.length > 300) throw new HttpError(400, 'Confirm the action and provide a reason between 5 and 300 characters.');
  const { target, spec } = await actionTarget(ctx, form.action, form.target);
  const verdict = await consume(ctx.db, `admin:actions:${session.actor}`, { limit: 60, window: 60 }, ctx.now);
  if (!verdict.ok) throw new HttpError(429, 'Too many administrator actions. Wait a minute.', { 'Retry-After': String(verdict.retryAfter) });
  const statements = [];
  let auditReason = reason;
  if (form.action === 'delete_paste') {
    statements.push({ sql: 'DELETE FROM paste_views WHERE paste_id = ?', params: [target] },
      { sql: 'DELETE FROM pastes WHERE id = ?', params: [target] });
  } else if (form.action === 'cleanup') {
    const rows = await ctx.db.all('SELECT id FROM pastes WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR burned = 1 ORDER BY created_at LIMIT 200', [ctx.now]);
    if (rows.length) {
      const placeholders = rows.map(() => '?').join(',');
      const ids = rows.map((row) => row.id);
      // An owner may extend expiration between selection and this transaction.
      const eligible = `SELECT id FROM pastes WHERE id IN (${placeholders}) AND ((expires_at IS NOT NULL AND expires_at <= ?) OR burned = 1)`;
      statements.push({ sql: `DELETE FROM paste_views WHERE paste_id IN (${eligible})`, params: [...ids, ctx.now] },
        { sql: `DELETE FROM pastes WHERE id IN (${eligible})`, params: [...ids, ctx.now] });
    }
    auditReason = `${reason} — selected ${rows.length} expired/consumed pastes.`;
  } else {
    const id = Number(target);
    if (form.action === 'restore_user') {
      statements.push({ sql: 'DELETE FROM sessions WHERE user_id = ?', params: [id] },
        { sql: 'DELETE FROM api_keys WHERE user_id = ?', params: [id] },
        { sql: 'UPDATE users SET suspended_at = NULL WHERE id = ?', params: [id] });
    } else {
      statements.push({ sql: 'DELETE FROM sessions WHERE user_id = ?', params: [id] },
        { sql: 'DELETE FROM api_keys WHERE user_id = ?', params: [id] });
      if (form.action === 'suspend_user') statements.push({ sql: 'UPDATE users SET suspended_at = ? WHERE id = ?', params: [ctx.now, id] });
      if (form.action === 'delete_user') statements.push(
        { sql: "UPDATE pastes SET user_id = NULL, visibility = 'unlisted' WHERE user_id = ?", params: [id] },
        { sql: 'DELETE FROM users WHERE id = ?', params: [id] });
    }
  }
  // Auditing is part of the SAME transaction: an audit failure rolls the action back.
  statements.push(auditStatement(session.actor, form.action, target, auditReason, ctx.now));
  await ctx.db.batch(statements);
  return redirect(`/admin${spec.type === 'user' ? '/users' : spec.type === 'paste' ? '/pastes' : ''}?done=1`);
}
