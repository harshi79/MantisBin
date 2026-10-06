/**
 * Social routes (merge phase 3): follows, bookmarks, reactions, notifications.
 *
 * Every one of these is an ordinary HTML form POST — no fetch, no client state
 * — so the whole social layer works with JavaScript switched off and the
 * "no third-party JS, strict CSP" invariants are untouched.
 *
 * The rules that shape the file:
 *
 *  - **Signed in, always.** Guests get a redirect to `/login` that returns them
 *    to where they were, exactly like the rest of the account surface. There is
 *    no anonymous actor anywhere in the social layer (VibeBin had IP-hashed
 *    anonymous likes; MantisBin deliberately does not).
 *  - **Discovery stays opt-in.** Reactions exist only on `public` pastes, and
 *    the notification fanout only ever mentions public, unprotected pastes.
 *    Bookmarks are the opposite — a private act, allowed on anything the
 *    visitor may read, including an unlisted link they hold.
 *  - **Validate, write, then redirect with a human notice.** Targets are
 *    resolved first (account, paste), the write is rate-limited and
 *    same-origin, and the browser is sent back to the page it came from.
 */

import { REACTIONS, RATE_LIMITS, SOCIAL } from '../config.js';
import { canReadPaste } from '../lib/access.js';
import { findUserByUsername } from '../lib/auth.js';
import { HttpError, htmlResponse, jsonResponse, parseForm, readBody, redirect } from '../lib/http.js';
import { getPaste } from '../lib/pastes.js';
import { consume } from '../lib/ratelimit.js';
import {
  clearReactionNotice,
  countFollows,
  followUser,
  isFollowing,
  listBookmarks,
  listFollows,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  normalizeReaction,
  unreadNotificationCount,
  notifyReaction,
  setBookmark,
  setReaction,
  unfollowUser,
} from '../lib/social.js';
import { isValidPasteId, validateUsername } from '../lib/validate.js';
import { bookmarksPage, followListPage, notificationsPage } from '../views/social.js';
import { pageCtx, withThumbnails } from './web.js';

/** Social forms carry a few bytes: a token, a flag, a reaction. */
const FORM_MAX_BYTES = 4 * 1024;

/** Only same-site relative targets are ever used for a redirect back. */
function safeNext(form, fallback) {
  const next = typeof form.next === 'string' ? form.next : '';
  return next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

/** Append one query flag to a relative path, keeping any it already has. */
function flag(path, key, value) {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

/**
 * Sign-in gate + shared rate limit for a social POST.
 * @returns {Promise<{ redirectTo?: string }>}
 */
async function socialActor(ctx, next) {
  if (!ctx.user) return { redirectTo: `/login?next=${encodeURIComponent(next)}` };
  const verdict = await consume(ctx.db, `social:${ctx.user.id}`, RATE_LIMITS.social, ctx.now);
  if (!verdict.ok) {
    throw new HttpError(429, `Too many social actions. Try again in about ${Math.ceil(verdict.retryAfter / 60)} minute(s).`, {
      'Retry-After': String(verdict.retryAfter),
    });
  }
  return {};
}

/** Resolve `:username` to an account row, or 404 (same rule as the profile page). */
async function accountFromParams(ctx, params) {
  const check = validateUsername(params.username);
  if (!check.ok) throw new HttpError(404, 'No such profile.');
  const account = await findUserByUsername(ctx.db, check.value);
  if (!account) throw new HttpError(404, 'No such profile.');
  return account;
}

/** POST /u/:username/follow — one button, both directions (`follow=0` unfollows). */
export async function follow(ctx, params) {
  const account = await accountFromParams(ctx, params);
  const form = parseForm(await readBody(ctx.request, FORM_MAX_BYTES));
  const back = safeNext(form, `/u/${account.username}`);
  const gate = await socialActor(ctx, back);
  if (gate.redirectTo) return redirect(gate.redirectTo);

  if (Number(account.id) === Number(ctx.user.id)) throw new HttpError(400, 'You cannot follow yourself.');
  const wanted = String(form.follow ?? '1') !== '0';
  const result = wanted
    ? await followUser(ctx.db, ctx.user.id, account.id, ctx.now)
    : await unfollowUser(ctx.db, ctx.user.id, account.id);
  if (!result.ok) throw new HttpError(400, 'That follow could not be saved.');
  return redirect(flag(back, 'notice', wanted ? 'followed' : 'unfollowed'));
}

/** GET /u/:username/followers */
export async function followers(ctx, params) {
  return followList(ctx, params, 'followers');
}

/** GET /u/:username/following */
export async function following(ctx, params) {
  return followList(ctx, params, 'following');
}

async function followList(ctx, params, direction) {
  const account = await accountFromParams(ctx, params);
  const page = Math.max(1, Math.min(10000, Number(ctx.url.searchParams.get('page') || 1) || 1));
  const limit = SOCIAL.followListPage;
  const [rows, total, following] = await Promise.all([
    listFollows(ctx.db, account.id, direction, { viewerId: ctx.user?.id ?? null, limit, offset: (page - 1) * limit }),
    countFollows(ctx.db, account.id, direction),
    ctx.user && Number(ctx.user.id) !== Number(account.id)
      ? isFollowing(ctx.db, ctx.user.id, account.id)
      : Promise.resolve(false),
  ]);
  const body = followListPage({
    ...pageCtx(ctx),
    account: { username: account.username, created_at: account.created_at },
    direction,
    rows,
    total,
    page,
    pageSize: limit,
    isFollowing: following,
    isOwner: Boolean(ctx.user && Number(ctx.user.id) === Number(account.id)),
  });
  return htmlResponse(body, 200, {}, { noindex: true });
}

const BOOKMARK_NOTICES = {
  saved: 'Saved to your bookmarks.',
  removed: 'Removed from your bookmarks.',
  limit: `Your bookmark list is full (${SOCIAL.bookmarks} pastes). Remove one to save another.`,
  locked: 'Unlock that paste before bookmarking it.',
  missing: 'That paste does not exist, or it expired.',
};

/** GET /me/bookmarks — the account's own saved pastes (never anybody else's). */
export async function bookmarks(ctx) {
  if (!ctx.user) return redirect(`/login?next=${encodeURIComponent('/me/bookmarks')}`);
  const page = Math.max(1, Math.min(10000, Number(ctx.url.searchParams.get('page') || 1) || 1));
  const limit = 50;
  const rows = await listBookmarks(ctx.db, ctx.user.id, { limit, offset: (page - 1) * limit, now: ctx.now });
  const body = bookmarksPage({
    ...pageCtx(ctx),
    rows: withThumbnails(rows, ctx.env),
    page,
    pageSize: limit,
    hasNext: rows.length === limit,
    notice: BOOKMARK_NOTICES[ctx.url.searchParams.get('notice') || ''] ?? null,
  });
  return htmlResponse(body, 200, {}, { noindex: true });
}

/**
 * POST /p/:id/bookmark — save or unsave.
 *
 * A bookmark is private, so it is allowed on any paste the visitor may read: a
 * public one, an unlisted link they hold, or a protected paste they unlocked.
 */
export async function toggleBookmark(ctx, params) {
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const back = safeNext({ next: `/p/${params.id}` }, `/p/${params.id}`);
  const gate = await socialActor(ctx, back);
  if (gate.redirectTo) return redirect(gate.redirectTo);

  const paste = await getPaste(ctx.db, params.id, { now: ctx.now });
  if (!paste) return redirect(flag(back, 'notice', 'missing'));
  if (!(await canReadPaste(ctx, paste))) return redirect(flag(back, 'notice', 'locked'));

  const form = parseForm(await readBody(ctx.request, FORM_MAX_BYTES));
  const wanted = String(form.saved ?? '1') !== '0';
  const result = await setBookmark(ctx.db, ctx.user.id, paste.id, wanted, ctx.now);
  if (!result.ok) return redirect(flag(back, 'notice', result.reason || 'limit'));
  return redirect(flag(back, 'notice', wanted ? 'saved' : 'removed'));
}

const REACTION_NOTICES = {
  reacted: 'Reaction saved.',
  unreacted: 'Reaction removed.',
  private: 'Reactions are only available on public pastes.',
  missing: 'That paste does not exist, or it expired.',
};

/**
 * POST /p/:id/react — set, change or clear this account's single reaction.
 *
 * Public pastes only: a reaction is a counted, visible signal, and MantisBin
 * never publishes a signal about a paste that is not listed.
 */
export async function react(ctx, params) {
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const back = safeNext({ next: `/p/${params.id}` }, `/p/${params.id}`);
  const gate = await socialActor(ctx, back);
  if (gate.redirectTo) return redirect(gate.redirectTo);

  const paste = await getPaste(ctx.db, params.id, { now: ctx.now });
  if (!paste) return redirect(flag(back, 'notice', 'missing'));
  if (paste.visibility !== 'public') return redirect(flag(back, 'notice', 'private'));

  const form = parseForm(await readBody(ctx.request, FORM_MAX_BYTES));
  const raw = String(form.reaction ?? '');
  const reaction = raw === '' ? null : normalizeReaction(raw);
  if (raw !== '' && !reaction) throw new HttpError(400, 'Pick a reaction from the palette.');
  await setReaction(ctx.db, ctx.user.id, paste.id, reaction, ctx.now);
  // The author hears about it once; a withdrawn reaction withdraws an unread
  // notice with it. Neither can fail the reaction itself.
  if (reaction) {
    await notifyReaction(ctx.db, paste, ctx.user, reaction, ctx.now).catch(() => false);
  } else {
    await clearReactionNotice(ctx.db, paste.id, ctx.user.id).catch(() => false);
  }
  return redirect(flag(back, 'notice', reaction ? 'reacted' : 'unreacted'));
}

/** GET /notifications — the account's own mailbox. */
export async function notifications(ctx) {
  if (!ctx.user) return redirect(`/login?next=${encodeURIComponent('/notifications')}`);
  const page = Math.max(1, Math.min(10000, Number(ctx.url.searchParams.get('page') || 1) || 1));
  const limit = SOCIAL.notificationPage;
  const rows = await listNotifications(ctx.db, ctx.user.id, { limit, offset: (page - 1) * limit });
  const body = notificationsPage({
    ...pageCtx(ctx),
    rows,
    page,
    pageSize: limit,
    hasNext: rows.length === limit,
    notice: ctx.url.searchParams.get('notice') === 'read' ? 'All caught up — every notification is marked read.' : null,
  });
  return htmlResponse(body, 200, {}, { noindex: true });
}

/** POST /notifications/read — mark one (`id`) or every (`all=1`) notification read. */
export async function readNotifications(ctx) {
  if (!ctx.user) return redirect(`/login?next=${encodeURIComponent('/notifications')}`);
  const gate = await socialActor(ctx, '/notifications');
  if (gate.redirectTo) return redirect(gate.redirectTo);
  const form = parseForm(await readBody(ctx.request, FORM_MAX_BYTES));
  const back = safeNext(form, '/notifications');
  if (String(form.all ?? '') === '1') {
    await markAllNotificationsRead(ctx.db, ctx.user.id);
    return redirect('/notifications?notice=read');
  }
  const id = String(form.id ?? '').slice(0, 32);
  if (id) await markNotificationRead(ctx.db, ctx.user.id, id);
  return redirect(back);
}

/**
 * GET /api/notifications/unread — the number the header bell shows.
 *
 * The session query already carries this count, so the common case is answered
 * from the request context with **no** database round trip. It exists so a page
 * that is already open can refresh the badge without reloading; the
 * server-rendered bell is the source of truth and works with scripting off.
 */
export async function unread(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Sign in to read your notifications.');
  const verdict = await consume(ctx.db, `notifypoll:${ctx.user.id}`, RATE_LIMITS.notifyPoll, ctx.now);
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many notification checks.', { 'Retry-After': String(verdict.retryAfter) });
  }
  const unread = Number.isFinite(ctx.user.unread) ? ctx.user.unread : await unreadNotificationCount(ctx.db, ctx.user.id);
  return jsonResponse(
    { unread, user: ctx.user.username },
    200,
    {},
    { noindex: true, cache: 'no-store' },
  );
}

/** The reaction palette the paste page renders (config is the only source). */
export const REACTION_PALETTE = REACTIONS;
