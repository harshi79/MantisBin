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

import { appSecret } from '../lib/access.js';
import { COOKIE, PROFILE_PASTE_LIMIT, PROFILE_PIN_LIMIT, RATE_LIMITS, VIEW_DEDUPE_SECONDS } from '../config.js';
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
  parseFormValues,
  readBody,
  redirect,
  svgResponse,
} from '../lib/http.js';
import { consume } from '../lib/ratelimit.js';
import { countPinnedPastes, listPublicPastes, setPastePinned, userStats, visitorHash } from '../lib/pastes.js';
import { validateUsername, isValidPasteId } from '../lib/validate.js';
import {
  ACCENT_PRESETS,
  BANNER_TYPES,
  PROFILE_LIMITS,
  badgesFor,
  profileView,
  readProfileInput,
  resolveStatus,
  themeCss,
  themeHash,
} from '../lib/profiles.js';
import { loadStickers, stickerIndex } from '../lib/formatting.js';
import { groupedNameEffects } from '../lib/nameEffects.js';
import {
  accountRank,
  awardTag,
  deleteTag,
  ensureProfile,
  getProfile,
  isFollowing,
  listPinnedPublicPastes,
  listUserTags,
  listTags,
  profileCounts,
  recordProfileView,
  revokeTag,
  saveProfile as storeProfile,
  upsertTag,
} from '../lib/social.js';
import { normalizeTagColor, tagIdFromLabel } from '../lib/profiles.js';
import { serializePaste } from './api.js';
import { withThumbnails } from './web.js';
import { goodbyePage, settingsPage } from '../views/settings.js';
import { profilePage } from '../views/profile.js';
import { profileCustomiserPage } from '../views/profileEdit.js';

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

/**
 * GET /u/:username — the opt-in discovery surface (indexable, content-free).
 *
 * A profile is cosmetic; the *pastes* on it are what make it public. Nothing
 * here can reveal an unlisted paste: the listing is the same public-only query
 * as before, now with pins first.
 */
export async function publicProfile(ctx, params) {
  const account = await requireProfileAccount(ctx.db, params.username);
  const isOwner = !!ctx.user && Number(ctx.user.id) === Number(account.id);
  const [row, pastes, stats, counts, tags, rank, stickerRows] = await Promise.all([
    getProfile(ctx.db, account.id),
    listPinnedPublicPastes(ctx.db, account.id, PROFILE_PASTE_LIMIT, ctx.now),
    userStats(ctx.db, account.id, ctx.now),
    profileCounts(ctx.db, account.id),
    listUserTags(ctx.db, account.id),
    accountRank(ctx.db, account.id),
    loadStickers(ctx.db),
  ]);
  const stored = profileView(row, account);
  // The viewer's own follow state, for the one button in the hero. One indexed
  // primary-key probe, and never for the owner.
  const viewerFollows = isOwner || !ctx.user ? false : await isFollowing(ctx.db, ctx.user.id, account.id);

  // A profile visit counts once per visitor per window, exactly like a paste
  // view, and the owner's own visits never count.
  let views = stored.views;
  if (!isOwner) {
    const visitor = await visitorHash(appSecret(ctx), ctx.ip, `u:${account.id}`);
    views = await recordProfileView(ctx.db, account.id, visitor, ctx.now, VIEW_DEDUPE_SECONDS).catch(() => stored.views);
  }
  const profile = { ...stored, views };

  const body = profilePage({
    ...pageCtx(ctx),
    account: { username: account.username, created_at: account.created_at },
    profile,
    pastes: withThumbnails(pastes, ctx.env).map((paste) => ({ ...paste, pinned: Number(paste.pinned ?? 0) === 1 })),
    stats,
    counts,
    tags: tags.map((tag) => ({ ...tag, color: normalizeTagColor(tag.color) })),
    badges: badgesFor({ profile, stats: { publicPastes: stats.publicPastes, views: stats.views, accountRank: rank } }),
    status: resolveStatus(profile.statusEmoji, stickerIndex(stickerRows)),
    isOwner,
    isFollowing: viewerFollows,
    themeHash: await themeHash(profile),
  });
  // Only the *anonymous* copy may be shared: a signed-in viewer sees their own
  // follow state in the hero (and the owner sees manage links), so those
  // responses are private and uncached. Crawlers and signed-out readers — the
  // audience the discovery page exists for — still get the cacheable copy.
  const cache = !ctx.user ? 'public, max-age=60' : 'private, no-store';
  return htmlResponse(body, 200, {}, { cache });
}

/**
 * GET /u/:username/theme.css — the profile's generated stylesheet.
 *
 * This is how a profile gets an arbitrary accent colour, animation speed and
 * banner without a single inline style: the sheet is same-origin (allowed by
 * `style-src 'self'`) and holds only values that passed validation.
 *
 * `?v=<hash>` makes it immutable-cacheable; the owner may pass `?preview=1`
 * plus any theme field to preview unsaved values in the customiser, which is
 * served `no-store` and never for anyone else.
 */
export async function themeStylesheet(ctx, params) {
  const account = await requireProfileAccount(ctx.db, params.username);
  const row = await getProfile(ctx.db, account.id);
  const stored = profileView(row, account);
  const isOwner = !!ctx.user && Number(ctx.user.id) === Number(account.id);
  const query = ctx.url.searchParams;

  let profile = stored;
  let cache = 'public, max-age=300';
  if (isOwner && query.has('preview')) {
    profile = profileView(
      {
        ...row,
        accent: query.get('accent') ?? row?.accent,
        name_effect: query.get('effect') ?? row?.name_effect,
        effect_speed: query.get('speed') ?? row?.effect_speed,
        effect_intensity: query.get('intensity') ?? row?.effect_intensity,
        banner_type: query.get('bannerType') ?? row?.banner_type,
        banner_url: query.has('banner') ? query.get('banner') : row?.banner_url,
      },
      account,
    );
    cache = 'private, no-store';
  } else if (query.get('v') && query.get('v') === (await themeHash(stored))) {
    cache = 'public, max-age=31536000, immutable';
  }

  return new Response(themeCss(profile, account.username), {
    status: 200,
    headers: headers({
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': cache,
      'X-Robots-Tag': 'noindex',
    }),
  });
}

/** GET /u/:username/avatar.svg — deterministic forever (usernames never change). */
export async function avatar(ctx, params) {
  const account = await requireProfileAccount(ctx.db, params.username);
  return svgResponse(avatarSvg(account.username), {}, { cache: 'public, max-age=31536000, immutable' });
}

/**
 * GET /api/users/:username — profile metadata as JSON (never content).
 *
 * The customisation is included (it is already public on the HTML profile) so
 * a client can render the same page; badges are computed, never stored.
 */
export async function apiProfile(ctx, params) {
  const verdict = await consume(ctx.db, `apiread:${ctx.ip}`, RATE_LIMITS.apiRead);
  if (!verdict.ok) {
    throw new HttpError(429, 'Rate limit exceeded.', { 'Retry-After': String(verdict.retryAfter) });
  }
  const account = await requireProfileAccount(ctx.db, params.username);
  const [row, pastes, stats, counts, tags, rank] = await Promise.all([
    getProfile(ctx.db, account.id),
    listPinnedPublicPastes(ctx.db, account.id, PROFILE_PASTE_LIMIT, ctx.now),
    userStats(ctx.db, account.id, ctx.now),
    profileCounts(ctx.db, account.id),
    listUserTags(ctx.db, account.id),
    accountRank(ctx.db, account.id),
  ]);
  const profile = profileView(row, account);
  return jsonResponse({
    username: account.username,
    displayName: profile.displayName || null,
    createdAt: new Date(Number(account.created_at) * 1000).toISOString(),
    bio: profile.bioEnabled ? profile.bio : '',
    status: profile.statusEmoji || profile.statusText ? { emoji: profile.statusEmoji, text: profile.statusText } : null,
    accent: profile.accent,
    nameEffect: profile.nameEffect,
    banner: profile.bannerUrl ? { type: profile.bannerType, url: profile.bannerUrl } : profile.bannerType === 'gradient' ? { type: 'gradient', url: null } : null,
    links: profile.links.map((link) => ({ platform: link.platform, label: link.label, url: link.url })),
    tags: tags.map((tag) => ({ id: tag.id, label: tag.label, color: normalizeTagColor(tag.color) })),
    badges: badgesFor({ profile, stats: { publicPastes: stats.publicPastes, views: stats.views, accountRank: rank } }).map((badge) => badge.id),
    stats: {
      publicPastes: stats.publicPastes,
      views: stats.views,
      profileViews: profile.views,
      followers: counts.followers,
      following: counts.following,
    },
    pastes: pastes.map((paste) => serializePaste(paste, ctx.url.origin, { env: ctx.env })),
  });
}

// ---------------------------------------------------------------------------
// Customiser (phase 2)
// ---------------------------------------------------------------------------

/** One (non-repeated) form value as a string; a repeated field reads as ''. */
function single(value) {
  return Array.isArray(value) ? '' : String(value ?? '');
}

/** A repeated form field as an array (tolerating the single-value case). */
function listOf(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? '')) : value ? [String(value)] : [];
}

/** GET /me/profile — the profile customiser. */
export async function editProfile(ctx) {
  if (!ctx.user) return redirect(`/login?next=${encodeURIComponent('/me/profile')}`);
  return renderCustomiser(ctx, {});
}

/**
 * @param {Ctx} ctx
 * @param {{ errors?: string[] | null, values?: any, notice?: string | null }} [options]
 */
async function renderCustomiser(ctx, options = {}) {
  const account = await findUserById(ctx.db, ctx.user.id);
  if (!account) throw new HttpError(401, 'That account no longer exists.');
  const row = await ensureProfile(ctx.db, ctx.user.id);
  const stored = profileView(row, account);
  const values = options.values ?? {
    display_name: stored.displayName,
    bio: stored.bio,
    bio_enabled: stored.bioEnabled,
    accent: stored.accent,
    name_effect: stored.nameEffect,
    effect_speed: stored.effectSpeed,
    effect_intensity: stored.effectIntensity,
    banner_type: stored.bannerType,
    banner_url: stored.bannerUrl,
    status_emoji: stored.statusEmoji,
    status_text: stored.statusText,
    links: stored.links.map((link) => ({ url: link.url, label: link.label })),
  };
  const body = profileCustomiserPage({
    ...pageCtx(ctx),
    account: { username: account.username, created_at: account.created_at },
    profile: stored,
    values,
    accents: ACCENT_PRESETS,
    bannerTypes: BANNER_TYPES,
    effectGroups: groupedNameEffects(),
    limits: PROFILE_LIMITS,
    themeHash: await themeHash(stored),
    errors: options.errors || null,
    notice: options.notice ?? (ctx.url.searchParams.get('saved') ? 'Profile saved.' : null),
  });
  return htmlResponse(body, options.errors ? 400 : 200, {}, { noindex: true });
}

/** POST /me/profile — validate everything, then store it (all or nothing). */
export async function saveProfile(ctx) {
  if (!ctx.user) throw new HttpError(401);
  const verdict = await consume(ctx.db, `profile:${ctx.user.id}`, RATE_LIMITS.profile);
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many profile saves. Wait a few minutes.', {
      'Retry-After': String(verdict.retryAfter),
    });
  }
  const form = parseFormValues(await readBody(ctx.request, 32 * 1024));
  const input = readProfileInput(form);
  if (input.errors.length) {
    // Re-render with what was typed, never a half-saved profile.
    return renderCustomiser(ctx, {
      errors: input.errors,
      values: {
        // A repeated single field is rejected by `readProfileInput`, so only
        // the link rows can legitimately be arrays here.
        display_name: single(form.display_name),
        bio: single(form.bio),
        bio_enabled: form.bio_enabled !== undefined,
        accent: single(form.accent),
        name_effect: single(form.name_effect) || 'none',
        effect_speed: Number(single(form.effect_speed) || 50),
        effect_intensity: Number(single(form.effect_intensity) || 60),
        banner_type: single(form.banner_type) || 'image',
        banner_url: single(form.banner_url),
        status_emoji: single(form.status_emoji),
        status_text: single(form.status_text),
        links: listOf(form.link_url).map((url, index) => ({ url, label: listOf(form.link_label)[index] ?? '' })),
      },
    });
  }
  await storeProfile(ctx.db, ctx.user.id, input.values);
  return redirect('/me/profile?saved=1');
}

/**
 * POST /me/pastes/:id/pin — pin or unpin one of your own public pastes.
 *
 * A pin is only visible on a public profile, so unlisted pastes are refused
 * with a message instead of silently doing nothing, and the cap keeps a
 * profile from becoming one long pinned list.
 */
export async function togglePin(ctx, params) {
  if (!ctx.user) return redirect(`/login?next=${encodeURIComponent(`/p/${params.id}`)}`);
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const form = parseForm(await readBody(ctx.request, 4 * 1024));
  const pin = form.pinned !== '0';
  const back = typeof form.next === 'string' && form.next.startsWith('/') ? form.next : '/me';
  if (pin) {
    const verdict = await consume(ctx.db, `pin:${ctx.user.id}`, RATE_LIMITS.pin);
    if (!verdict.ok) {
      throw new HttpError(429, 'Too many pin changes. Wait a few minutes.', {
        'Retry-After': String(verdict.retryAfter),
      });
    }
    const already = await countPinnedPastes(ctx.db, ctx.user.id);
    if (already >= PROFILE_PIN_LIMIT) return redirect(`${back}?pin=limit`);
  }
  const result = await setPastePinned(ctx.db, params.id, ctx.user.id, pin);
  if (!result.ok) {
    if (result.reason === 'unlisted') return redirect(`${back}?pin=unlisted`);
    throw new HttpError(result.reason === 'missing' ? 404 : 403, result.reason === 'missing' ? undefined : 'Only the account that created a paste can pin it.');
  }
  return redirect(`${back}?pin=${pin ? 'on' : 'off'}`);
}
