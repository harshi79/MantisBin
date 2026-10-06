/** Server-rendered administration. Every entry point checks the separate admin session. */
import { ADMIN_COOKIE, ADMIN_LOGIN_COOKIE, adminCookie, adminForm, auditStatement, checkAdminPassword,
  requireAdmin, requireAdminConfig, resolveAdmin, startAdminSession } from '../lib/admin.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError, htmlResponse, redirect } from '../lib/http.js';
import { consume } from '../lib/ratelimit.js';
import { broadcastAll, countBroadcastRecipients, listRecentBroadcasts, userGraphStatements, awardTag, listTags, revokeTag, upsertTag } from '../lib/social.js';
import { MEDIA, SOCIAL } from '../config.js';
import { importSticker, listStickerRows, countStickers, readStickerInput, removeSticker, addSticker, STICKER_LIMITS } from '../lib/stickers.js';
import { nekoCategories } from '../lib/media.js';
import { TAG_COLORS, TAG_EFFECTS, TAG_EFFECT_IDS, normalizeTagColor, tagIdFromLabel } from '../lib/profiles.js';
import { findUserByUsername } from '../lib/auth.js';
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

/**
 * GET /admin/tags — the tag catalogue and the award form.
 *
 * `?u=username` pre-fills the account field (the Accounts table links here).
 */
export async function tags(ctx) {
  const session = await requireAdmin(ctx);
  const rows = await listTags(ctx.db);
  const detailed = await Promise.all(
    rows.map(async (tag) => {
      const [count, holders] = await Promise.all([
        ctx.db.get('SELECT COUNT(*) AS n FROM user_tags WHERE tag_id = ?', [tag.id]),
        ctx.db.all(
          `SELECT u.username FROM user_tags ut JOIN users u ON u.id = ut.user_id
            WHERE ut.tag_id = ? ORDER BY ut.created_at ASC LIMIT 20`,
          [tag.id],
        ),
      ]);
      return { ...tag, count: Number(count?.n ?? 0), holders: holders.map((row) => row.username) };
    }),
  );
  return page(
    ctx,
    adminPage(ctx, session, 'tags', {
      rows: detailed,
      colors: TAG_COLORS,
      effects: TAG_EFFECTS,
      username: (ctx.url.searchParams.get('u') || '').slice(0, 20),
      session,
    }),
  );
}

/** POST /admin/tags — award or revoke one tag (audited). */
export async function tagAction(ctx) {
  const session = await requireAdmin(ctx);
  const form = await adminForm(ctx, session.csrf);
  const username = String(form.username ?? '').trim();
  const account = await findUserByUsername(ctx.db, username);
  if (!account) throw new HttpError(400, 'No account with that username.');
  const verdict = await consume(ctx.db, `admin:actions:${session.actor}`, { limit: 60, window: 60 }, ctx.now);
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many administrator actions. Wait a minute.', { 'Retry-After': String(verdict.retryAfter) });
  }

  if (form.action === 'revoke') {
    const tagId = String(form.tag_id ?? '').slice(0, 32);
    const removed = await revokeTag(ctx.db, account.id, tagId);
    const entry = auditStatement(session.actor, 'tag_revoke', `user:${account.id}`, `Revoked tag ${tagId} (${removed} award(s))`, ctx.now);
    await ctx.db.run(entry.sql, entry.params);
    return redirect('/admin/tags?done=1');
  }

  const label = String(form.label ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  const tagId = tagIdFromLabel(label);
  if (label.length < 2 || !tagId) throw new HttpError(400, 'A tag needs a label of 2–30 characters.');
  const color = normalizeTagColor(form.color);
  const effect = TAG_EFFECT_IDS.has(String(form.effect ?? '')) ? String(form.effect) : '';
  await upsertTag(ctx.db, { id: tagId, label, color, effect }, ctx.now);
  await awardTag(ctx.db, account.id, tagId, ctx.now);
  const entry = auditStatement(session.actor, 'tag_award', `user:${account.id}`, `Awarded tag "${label}" (${color})`, ctx.now);
  await ctx.db.run(entry.sql, entry.params);
  return redirect('/admin/tags?done=1');
}

/**
 * GET /admin/stickers — the curated pack, plus the two ways to grow it.
 *
 * `?error=<code>` carries a failure back from the POST as a short code rather
 * than a message, so nothing an operator typed is ever echoed into a page.
 */
const STICKER_ERRORS = {
  token: 'That token is not usable. Use letters, numbers, dashes or underscores, like :wave:.',
  invalid: 'That sticker could not be added. Check the token and try again.',
  duplicate: 'That token already exists in the pack.',
  limit: `The pack is full (${STICKER_LIMITS.pack} stickers). Remove one first.`,
  unverified: 'That GIF could not be verified with its provider, so nothing was added.',
  source: 'Unknown GIF source.',
  input: 'Check the highlighted fields and try again.',
  delete: 'That sticker no longer exists.',
};

export async function stickers(ctx) {
  const session = await requireAdmin(ctx);
  const [rows, count] = await Promise.all([listStickerRows(ctx.db), countStickers(ctx.db)]);
  const error = STICKER_ERRORS[String(ctx.url.searchParams.get('error') || '')] || null;
  return page(
    ctx,
    adminPage(ctx, session, 'stickers', {
      rows,
      count,
      limit: STICKER_LIMITS.pack,
      categories: nekoCategories(),
      errors: error ? [error] : [],
      values: {
        token: (ctx.url.searchParams.get('token') || '').slice(0, STICKER_LIMITS.token),
        label: (ctx.url.searchParams.get('label') || '').slice(0, STICKER_LIMITS.label),
      },
      session,
    }),
  );
}

/**
 * POST /admin/stickers — add, import or remove one sticker (audited).
 *
 * Import never trusts the posted URL: it takes a provider + id/category and
 * re-resolves the image server-side (`importSticker`), so the operator cannot
 * accidentally point every reader's browser at an arbitrary host.
 */
export async function stickerAction(ctx) {
  const session = await requireAdmin(ctx);
  const form = await adminForm(ctx, session.csrf);
  const verdict = await consume(ctx.db, `admin:actions:${session.actor}`, { limit: 60, window: 60 }, ctx.now);
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many administrator actions. Wait a minute.', { 'Retry-After': String(verdict.retryAfter) });
  }
  const action = String(form.action ?? 'add');

  if (action === 'delete') {
    const removed = await removeSticker(ctx.db, form.id);
    const entry = auditStatement(session.actor, 'sticker_delete', `sticker:${String(form.id ?? '').slice(0, 32)}`, removed ? 'Removed from the pack' : 'Already gone', ctx.now);
    await ctx.db.run(entry.sql, entry.params);
    return redirect(removed ? '/admin/stickers?done=1' : '/admin/stickers?error=delete');
  }

  if (action === 'import') {
    const result = await importSticker(
      ctx.db,
      {
        source: String(form.source ?? ''),
        id: String(form.gif_id ?? ''),
        category: String(form.category ?? ''),
        token: form.token,
        label: form.label,
        emoji: form.emoji,
        now: ctx.now,
      },
      ctx.env,
    );
    const entry = auditStatement(
      session.actor,
      'sticker_import',
      `sticker:${result.token || String(form.source ?? 'unknown')}`,
      result.ok ? `Imported from ${String(form.source)}` : `Import refused (${result.reason})`,
      ctx.now,
    );
    await ctx.db.run(entry.sql, entry.params);
    if (!result.ok) return redirect(`/admin/stickers?error=${encodeURIComponent(result.reason || 'unverified')}`);
    return redirect('/admin/stickers?done=1');
  }

  const input = readStickerInput(form);
  if (!input.ok) {
    // Nothing is written and no operator input is echoed back: the page simply
    // lists what was wrong.
    const entry = auditStatement(session.actor, 'sticker_add', 'sticker:invalid', 'Rejected by validation', ctx.now);
    await ctx.db.run(entry.sql, entry.params);
    return htmlResponse(
      adminPage(ctx, session, 'stickers', {
        rows: await listStickerRows(ctx.db),
        count: await countStickers(ctx.db),
        limit: STICKER_LIMITS.pack,
        categories: nekoCategories(),
        errors: input.errors,
        values: { token: input.value.token, label: input.value.label },
        session,
      }),
      400,
      { 'Referrer-Policy': 'same-origin' },
      { noindex: true },
    );
  }

  const result = await addSticker(ctx.db, { ...input.value, now: ctx.now });
  const entry = auditStatement(
    session.actor,
    'sticker_add',
    `sticker:${input.value.token}`,
    result.ok ? 'Added to the pack' : `Refused (${result.reason})`,
    ctx.now,
  );
  await ctx.db.run(entry.sql, entry.params);
  if (!result.ok) return redirect(`/admin/stickers?error=${encodeURIComponent(result.reason || 'input')}`);
  return redirect('/admin/stickers?done=1');
}

const BROADCAST_ERRORS = {
  title: 'A broadcast needs a title.',
  message: 'A broadcast needs a message.',
  link: 'That link is not usable. Use an https:// address or a path on this site.',
  empty: 'There are no accounts to send to yet.',
};

/** Same-origin paths and https URLs only: never `javascript:`, `data:` or `//host`. */
export function normalizeBroadcastLink(raw) {
  const value = String(raw ?? '').trim().slice(0, 300);
  if (!value) return { ok: true, value: null };
  if (value.startsWith('/') && !value.startsWith('//')) return { ok: true, value };
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return { ok: true, value: url.toString() };
  } catch {
    /* fall through to the error */
  }
  return { ok: false, value: null };
}

/** GET /admin/broadcast — the composer, plus what was sent recently. */
export async function broadcast(ctx) {
  const session = await requireAdmin(ctx);
  const [recipients, recent] = await Promise.all([countBroadcastRecipients(ctx.db), listRecentBroadcasts(ctx.db)]);
  const error = BROADCAST_ERRORS[String(ctx.url.searchParams.get('error') || '')] || null;
  return page(
    ctx,
    adminPage(ctx, session, 'broadcast', {
      recipients,
      recent,
      cap: SOCIAL.broadcastMax,
      titleMax: SOCIAL.broadcastTitle,
      messageMax: SOCIAL.broadcastMessage,
      errors: error ? [error] : [],
      values: { title: '', message: '', link: '' },
      session,
    }),
  );
}

/**
 * POST /admin/broadcast — one announcement to every active account (audited).
 *
 * Rate-limited to ten sends per hour per session: a broadcast is the only
 * action in the app that writes a row for *every* account, so the guard is
 * about the blast radius, not about the operator's convenience.
 */
export async function broadcastSend(ctx) {
  const session = await requireAdmin(ctx);
  const form = await adminForm(ctx, session.csrf);
  const verdict = await consume(ctx.db, `admin:broadcast:${session.actor}`, { limit: 10, window: 3600 }, ctx.now);
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many broadcasts. Wait before sending another.', { 'Retry-After': String(verdict.retryAfter) });
  }
  const title = String(form.title ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SOCIAL.broadcastTitle);
  const message = String(form.message ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, SOCIAL.broadcastMessage);
  const link = normalizeBroadcastLink(form.link);
  const errors = [];
  if (title.length < 3) errors.push(BROADCAST_ERRORS.title);
  if (!message) errors.push(BROADCAST_ERRORS.message);
  if (!link.ok) errors.push(BROADCAST_ERRORS.link);

  if (errors.length) {
    const [recipients, recent] = await Promise.all([countBroadcastRecipients(ctx.db), listRecentBroadcasts(ctx.db)]);
    return htmlResponse(
      adminPage(ctx, session, 'broadcast', {
        recipients,
        recent,
        cap: SOCIAL.broadcastMax,
        titleMax: SOCIAL.broadcastTitle,
        messageMax: SOCIAL.broadcastMessage,
        errors,
        values: { title, message, link: '' },
        session,
      }),
      400,
      { 'Referrer-Policy': 'same-origin' },
      { noindex: true },
    );
  }

  const result = await broadcastAll(ctx.db, { title, message, link: link.value, now: ctx.now });
  const entry = auditStatement(
    session.actor,
    'broadcast',
    `broadcast:${result.broadcastId}`,
    `Sent to ${result.written}/${result.recipients} account(s)${result.capped ? ` (capped at ${SOCIAL.broadcastMax})` : ''}: ${title}`,
    ctx.now,
  );
  await ctx.db.run(entry.sql, entry.params);
  return redirect('/admin/broadcast?done=1');
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
        // The social graph goes with the account, in the same transaction.
        ...userGraphStatements(id),
        { sql: 'DELETE FROM users WHERE id = ?', params: [id] });
    }
  }
  // Auditing is part of the SAME transaction: an audit failure rolls the action back.
  statements.push(auditStatement(session.actor, form.action, target, auditReason, ctx.now));
  await ctx.db.batch(statements);
  return redirect(`/admin${spec.type === 'user' ? '/users' : spec.type === 'paste' ? '/pastes' : ''}?done=1`);
}
