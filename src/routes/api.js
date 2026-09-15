/**
 * Public JSON API.
 *
 *   POST   /api/pastes          create (API key)
 *   GET    /api/pastes/mine     list own (API key)
 *   GET    /api/pastes/:id      fetch (public)
 *   PATCH  /api/pastes/:id      update own (API key)
 *   DELETE /api/pastes/:id      delete own (API key)
 *   GET    /api/pastes/:id/raw  raw text (public)
 *   POST   /api/pastes/:id/unlock  unlock a password-protected paste (public)
 *   GET    /api/meta            vocabularies + limits (public)
 *   GET    /api/health          liveness (public)
 */

import {
  COOKIE,
  EXPIRATIONS,
  FONTS,
  FONT_SIZES,
  LANGUAGES,
  LIMITS,
  RATE_LIMITS,
  SITE,
  UNLOCK_MAX_TOKENS,
  UNLOCK_TTL_SECONDS,
} from '../config.js';
import { authenticateApiKey } from '../lib/auth.js';
import { appSecret, canReadPaste } from '../lib/access.js';
import { HttpError, jsonResponse, parseJson, readBody, textResponse } from '../lib/http.js';
import { consume } from '../lib/ratelimit.js';
import {
  hashPassphrase,
  issueUnlockToken,
  isProtected,
  rememberUnlock,
  unlockBucketKey,
  unlockCookieString,
  verifyPassphrase,
} from '../lib/unlock.js';
import {
  isValidPasteId,
  normalizeExpiration,
  normalizeFont,
  normalizeFontSize,
  normalizeLanguage,
  safeFilename,
  validateContent,
  validatePassphrase,
  validateTitle,
} from '../lib/validate.js';
import { createPaste, deletePaste, getPaste, listUserPastes, updatePaste } from '../lib/pastes.js';
import { maxBytesFor } from './web.js';

/** @typedef {import('../app.js').Ctx} Ctx */

function iso(seconds) {
  if (seconds === null || seconds === undefined) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}

/**
 * @param {any} paste
 * @param {string} origin
 * @param {{ content?: boolean }} [options]
 */
export function serializePaste(paste, origin, options = {}) {
  const base = {
    id: paste.id,
    url: `${origin}/p/${paste.id}`,
    rawUrl: `${origin}/p/${paste.id}/raw`,
    title: paste.title,
    language: paste.language,
    font: paste.font,
    fontSize: Number(paste.font_size),
    size: Number(paste.size),
    views: Number(paste.views),
    createdAt: iso(paste.created_at),
    updatedAt: iso(paste.updated_at),
    expiresAt: iso(paste.expires_at),
    /** True when reading the paste requires an unlocked passphrase. */
    protected: isProtected(paste),
  };
  if (options.content) base.content = paste.content;
  return base;
}

/**
 * Read the optional passphrase from a JSON body. `undefined` must mean "field
 * absent" (keep the current lock), so this uses key presence — `??` would
 * silently turn an explicit `password: null` (remove the lock) into "absent".
 * @param {any} body
 * @returns {{ provided: boolean, value: any }}
 */
function readPasswordInput(body) {
  if (Object.hasOwn(body, 'password')) return { provided: true, value: body.password };
  if (Object.hasOwn(body, 'passphrase')) return { provided: true, value: body.passphrase };
  return { provided: false, value: undefined };
}

/** Pull an API key out of Authorization: Bearer or X-API-Key. */
function keyFromRequest(request) {
  const auth = request.headers.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const direct = request.headers.get('x-api-key');
  if (direct) return direct.trim();
  return null;
}

/**
 * Ownership proof for locked reads, without paying for a key lookup on the
 * common path: this runs only when a paste is protected *and* still locked. An
 * API key that belongs to the paste's account is exactly the same proof as a
 * signed-in session on the web, so owners never need their own passphrase.
 * @param {Ctx} ctx
 * @param {any} paste
 */
async function apiKeyOwnsPaste(ctx, paste) {
  if (paste.user_id === null || paste.user_id === undefined) return false;
  const key = keyFromRequest(ctx.request);
  if (!key) return false;
  const auth = await authenticateApiKey(ctx.db, key, ctx.now);
  return Boolean(auth) && Number(paste.user_id) === Number(auth.user.id);
}

/** @param {Ctx} ctx */
async function requireKey(ctx) {
  const key = keyFromRequest(ctx.request);
  if (!key) throw new HttpError(401, 'An API key is required. Send Authorization: Bearer <key>.');
  const auth = await authenticateApiKey(ctx.db, key, ctx.now);
  if (!auth) throw new HttpError(401, 'That API key is not valid.');
  return auth;
}

/** GET /api/health */
export async function health(ctx) {
  return jsonResponse({ status: 'ok', service: SITE.name, time: new Date(ctx.now * 1000).toISOString() });
}

/** GET /api/meta */
export async function meta(ctx) {
  return jsonResponse({
    name: SITE.name,
    tagline: SITE.tagline,
    languages: LANGUAGES,
    fonts: FONTS.map((f) => ({ id: f.id, label: f.label })),
    fontSizes: FONT_SIZES,
    expirations: EXPIRATIONS.map((e) => ({ id: e.id, label: e.label, seconds: e.seconds })),
    limits: {
      anonymousBytes: LIMITS.anonMaxBytes,
      accountBytes: LIMITS.userMaxBytes,
      titleMax: LIMITS.titleMax,
      highlightBytes: LIMITS.highlightMaxBytes,
      passphraseMin: LIMITS.passphraseMin,
      passphraseMax: LIMITS.passphraseMax,
    },
    unlock: {
      seconds: UNLOCK_TTL_SECONDS,
      maxRemembered: UNLOCK_MAX_TOKENS,
      attempts: RATE_LIMITS.unlock.limit,
      windowSeconds: RATE_LIMITS.unlock.window,
    },
    rateLimits: RATE_LIMITS,
  });
}

/** POST /api/pastes */
export async function create(ctx) {
  const auth = await requireKey(ctx);
  const verdict = await consume(ctx.db, `apicreate:key:${auth.key.id}`, RATE_LIMITS.apiCreate);
  if (!verdict.ok) {
    throw new HttpError(429, 'Rate limit exceeded for this API key.', { 'Retry-After': String(verdict.retryAfter) });
  }

  const body = parseJson(await readBody(ctx.request, LIMITS.bodyMaxBytes + 64 * 1024));
  const title = validateTitle(body.title);
  if (!title.ok) throw new HttpError(400, title.error);
  const content = validateContent(body.content, maxBytesFor(auth.user));
  if (!content.ok) throw new HttpError(413, content.error);

  const expiration = normalizeExpiration(body.expiresIn ?? body.expiration);
  // `password` (camelcase JSON) or `passphrase`; empty/omitted means no lock.
  const passphrase = readPasswordInput(body);
  let passwordHash = null;
  if (passphrase.value !== undefined && passphrase.value !== null && passphrase.value !== '') {
    const check = validatePassphrase(passphrase.value);
    if (!check.ok) throw new HttpError(400, check.error);
    passwordHash = await hashPassphrase(String(check.value));
  }
  const paste = await createPaste(ctx.db, {
    title: title.value,
    content: content.value,
    language: normalizeLanguage(body.language),
    font: normalizeFont(body.font),
    fontSize: normalizeFontSize(body.fontSize ?? body.font_size),
    expiresAt: expiration.expiresAt,
    userId: auth.user.id,
    passwordHash,
    now: ctx.now,
  });

  return jsonResponse(serializePaste(paste, ctx.url.origin, { content: false }), 201);
}

/** GET /api/pastes/mine */
export async function mine(ctx) {
  const auth = await requireKey(ctx);
  const pastes = await listUserPastes(ctx.db, auth.user.id, 200, ctx.now);
  return jsonResponse({
    pastes: pastes.map((paste) => serializePaste(paste, ctx.url.origin)),
  });
}

/** GET /api/pastes/:id */
export async function get(ctx, params) {
  const verdict = await consume(ctx.db, `apiread:${ctx.ip}`, RATE_LIMITS.apiRead);
  if (!verdict.ok) {
    throw new HttpError(429, 'Rate limit exceeded.', { 'Retry-After': String(verdict.retryAfter) });
  }
  if (!isValidPasteId(params.id)) throw new HttpError(404, 'Unknown paste id.');
  const paste = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
  if (!paste) throw new HttpError(404, 'Paste not found, expired or deleted.');
  // Nothing about a protected paste leaks here — not even the title.
  if (!(await canReadPaste(ctx, paste)) && !(await apiKeyOwnsPaste(ctx, paste))) throw protectedError();
  return jsonResponse(serializePaste(paste, ctx.url.origin, { content: true }), 200, {}, { noindex: true });
}

/** 401 for every JSON route that refuses to serve a locked paste. Empty body. */
function protectedError() {
  return new HttpError(
    401,
    'This paste is password-protected. Unlock it first: POST /api/pastes/:id/unlock (or open /p/:id in a browser).',
    { 'WWW-Authenticate': 'mantisbin-unlock' },
  );
}

/**
 * POST /api/pastes/:id/unlock — scriptable unlock. Verifies the passphrase,
 * sets the same HttpOnly cookie the web form sets (use `curl -c jar`), and
 * returns when the unlock expires. Never returns the content or the passphrase.
 */
export async function unlock(ctx, params) {
  const verdict = await consume(ctx.db, `apiread:${ctx.ip}`, RATE_LIMITS.apiRead);
  if (!verdict.ok) {
    throw new HttpError(429, 'Rate limit exceeded.', { 'Retry-After': String(verdict.retryAfter) });
  }
  if (!isValidPasteId(params.id)) throw new HttpError(404, 'Unknown paste id.');
  const paste = await getPaste(ctx.db, params.id, { content: false, now: ctx.now });
  if (!paste) throw new HttpError(404, 'Paste not found, expired or deleted.');
  if (!isProtected(paste)) throw new HttpError(400, 'This paste is not password-protected.');

  const attempts = await consume(ctx.db, unlockBucketKey(paste.id, ctx.ip), RATE_LIMITS.unlock);
  if (!attempts.ok) {
    throw new HttpError(429, 'Too many unlock attempts for this paste.', {
      'Retry-After': String(attempts.retryAfter),
    });
  }

  const body = parseJson(await readBody(ctx.request, 4 * 1024));
  const passphrase = body.password ?? body.passphrase;
  const ok = await verifyPassphrase(passphrase, paste.password_hash);
  if (!ok) throw new HttpError(401, 'Wrong passphrase.');

  const expiresAt = ctx.now + UNLOCK_TTL_SECONDS;
  const entry = await issueUnlockToken(appSecret(ctx), paste.id, expiresAt);
  const value = rememberUnlock(ctx.cookies[COOKIE.unlock] || '', entry, ctx.now, UNLOCK_MAX_TOKENS);
  return jsonResponse(
    { unlocked: true, id: paste.id, expiresAt: iso(expiresAt) },
    200,
    { 'Set-Cookie': unlockCookieString(value, { secure: ctx.secure }) },
    { noindex: true },
  );
}

/** GET /api/pastes/:id/raw */
export async function raw(ctx, params) {
  const verdict = await consume(ctx.db, `apiread:${ctx.ip}`, RATE_LIMITS.apiRead);
  if (!verdict.ok) {
    throw new HttpError(429, 'Rate limit exceeded.', { 'Retry-After': String(verdict.retryAfter) });
  }
  if (!isValidPasteId(params.id)) throw new HttpError(404, 'Unknown paste id.');
  const paste = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
  if (!paste) throw new HttpError(404, 'Paste not found, expired or deleted.');
  if (!(await canReadPaste(ctx, paste)) && !(await apiKeyOwnsPaste(ctx, paste))) throw protectedError();
  return textResponse(
    paste.content,
    200,
    { 'Content-Disposition': `inline; filename="${safeFilename(paste.title)}.txt"` },
    { cache: 'private, max-age=60', noindex: true },
  );
}

/** PATCH /api/pastes/:id */
export async function update(ctx, params) {
  const auth = await requireKey(ctx);
  if (!isValidPasteId(params.id)) throw new HttpError(404, 'Unknown paste id.');
  const existing = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
  if (!existing) throw new HttpError(404, 'Paste not found, expired or deleted.');
  if (existing.user_id === null || Number(existing.user_id) !== Number(auth.user.id)) {
    throw new HttpError(403, 'This paste belongs to another account.');
  }

  const body = parseJson(await readBody(ctx.request, LIMITS.bodyMaxBytes + 64 * 1024));
  /** @type {import('../lib/validate.js').Result} */
  const title = body.title === undefined ? { ok: true, value: existing.title } : validateTitle(body.title);
  if (!title.ok) throw new HttpError(400, title.error);
  const contentValue = body.content === undefined ? existing.content : body.content;
  const content = validateContent(contentValue, maxBytesFor(auth.user));
  if (!content.ok) throw new HttpError(413, content.error);

  const expiration =
    body.expiresIn === undefined && body.expiration === undefined
      ? { expiresAt: existing.expires_at }
      : normalizeExpiration(body.expiresIn ?? body.expiration);

  // `password: null` removes the protection, a string replaces it, absent keeps it.
  const passphrase = readPasswordInput(body);
  let passwordHash;
  if (passphrase.provided) {
    if (passphrase.value === null || passphrase.value === undefined || passphrase.value === '') {
      passwordHash = null;
    } else {
      const check = validatePassphrase(passphrase.value);
      if (!check.ok) throw new HttpError(400, check.error);
      passwordHash = await hashPassphrase(String(check.value));
    }
  }

  const result = await updatePaste(
    ctx.db,
    params.id,
    auth.user.id,
    {
      title: title.value,
      content: content.value,
      language: normalizeLanguage(body.language ?? existing.language),
      font: normalizeFont(body.font ?? existing.font),
      fontSize: normalizeFontSize(body.fontSize ?? body.font_size ?? existing.font_size),
      expiresAt: expiration.expiresAt,
      passwordHash,
    },
    ctx.now,
  );
  if (!result.ok) throw new HttpError(result.reason === 'missing' ? 404 : 403);

  const updated = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
  return jsonResponse(serializePaste(updated, ctx.url.origin, { content: false }));
}

/** DELETE /api/pastes/:id */
export async function remove(ctx, params) {
  const auth = await requireKey(ctx);
  if (!isValidPasteId(params.id)) throw new HttpError(404, 'Unknown paste id.');
  const result = await deletePaste(ctx.db, params.id, auth.user.id);
  if (!result.ok) {
    throw new HttpError(result.reason === 'missing' ? 404 : 403, result.reason === 'missing' ? 'Paste not found.' : 'This paste belongs to another account.');
  }
  return jsonResponse({ deleted: true, id: params.id });
}
