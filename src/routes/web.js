/**
 * HTML routes. Forms post urlencoded and work without JavaScript; every
 * validation here is also enforced for the JSON API in routes/api.js.
 */

import {
  AUTO_LANGUAGE,
  BURN_MODES,
  CLEANUP_BATCH,
  COOKIE,
  DEFAULT_BURN_MODE,
  DEFAULT_FILENAME,
  DEFAULT_VISIBILITY,
  LIMITS,
  UNLOCK_MAX_TOKENS,
  UNLOCK_TTL_SECONDS,
} from '../config.js';
import {
  authenticate,
  clearSessionCookie,
  createApiKey,
  createSession,
  destroySession,
  enforceApiKeyLimit,
  listApiKeys,
  registerUser,
  revokeApiKey,
  sessionCookie,
} from '../lib/auth.js';
import { HttpError, headers, htmlResponse, jsonResponse, parseForm, readBody, redirect, safeRedirectTarget, svgResponse, textResponse } from '../lib/http.js';
import { appSecret, canReadPaste, isPasteOwner } from '../lib/access.js';
import { burnLabel, burnModeOf, claimBurnForRead } from '../lib/burn.js';
import {
  hashPassphrase,
  issueUnlockToken,
  rememberUnlock,
  unlockBucketKey,
  unlockCookieString,
  verifyPassphrase,
} from '../lib/unlock.js';
import { addLineAnchors, renderCode } from '../lib/highlight.js';
import {
  safeThumbnailUrl,
  uploadThumbnail,
  uploadsEnabled,
  validateThumbnailUrl,
  validateUpload,
} from '../lib/thumbnail.js';
import { canonicalPasteUrl, normalizeLineAnchor, qrSvg } from '../lib/qr.js';
import { faviconSvg, logoSvg, markSvg } from '../assets/mark.js';
import { THUMBNAIL } from '../config.js';
import {
  cleanText,
  downloadFilename,
  expirationPresetFor,
  isValidPasteId,
  normalizeExpiration,
  normalizeFont,
  normalizeFontSize,
  normalizeLanguageChoice,
  resolveVisibility,
  validateBurnMode,
  validateContent,
  validatePassphrase,
  validateTitle,
} from '../lib/validate.js';
import {
  createPaste,
  deletePaste,
  getPaste,
  listUserPastes,
  pruneExpired,
  recordView,
  updatePaste,
  userStats,
  visitorHash,
} from '../lib/pastes.js';
import { consume } from '../lib/ratelimit.js';
import { resolvePasteLanguage } from '../lib/detect.js';
import { RATE_LIMITS } from '../config.js';
import { editorPage } from '../views/editor.js';
import { pastePage } from '../views/paste.js';
import { qrPage } from '../views/qr.js';
import { unlockPage } from '../views/unlock.js';
import { loginPage, registerPage } from '../views/auth.js';
import { myPastesPage } from '../views/mypastes.js';
import { docsPage } from '../views/docs.js';

/** @typedef {import('../app.js').Ctx} Ctx */

export function maxBytesFor(user) {
  return user ? LIMITS.userMaxBytes : LIMITS.anonMaxBytes;
}

function pageCtx(ctx) {
  return { theme: ctx.theme, user: ctx.user, path: ctx.url.pathname };
}

/**
 * Attach a render-safe `thumbnail` to list rows. Re-validating here means an
 * operator who removes a host from the allowlist immediately stops every page
 * from embedding images from it, without touching stored rows.
 * @param {any[]} pastes
 * @param {any} env
 */
export function withThumbnails(pastes, env) {
  return pastes.map((paste) => ({ ...paste, thumbnail: safeThumbnailUrl(paste.thumbnail_url, env) }));
}

/**
 * Optional passphrase field. Three intents share one input:
 *   create + empty            -> no protection
 *   edit + empty              -> keep the stored hash untouched
 *   edit + "remove" checkbox  -> clear the protection
 *   anything else             -> set (validated, hashed later)
 * @param {Record<string, string>} form
 * @param {'create' | 'edit'} mode
 */
function readPassphrase(form, mode) {
  const raw = typeof form.password === 'string' ? form.password : '';
  if (mode === 'edit') {
    if (form.remove_password === '1') return { state: { mode: 'clear' } };
    if (raw === '') return { state: { mode: 'keep' } };
  } else if (raw === '') {
    return { state: { mode: 'none' } };
  }
  const check = validatePassphrase(raw);
  if (!check.ok) return { error: check.error, state: { mode: 'keep' } };
  return { state: { mode: 'set', value: check.value } };
}

/**
 * Hash only after every other field validated, so a rejected paste never costs
 * PBKDF2 work. `undefined` means "leave the stored hash alone".
 * @param {{ mode: string, value?: string }} state
 * @returns {Promise<string | null | undefined>}
 */
async function resolvePassphraseHash(state) {
  if (state.mode === 'set') return hashPassphrase(String(state.value));
  if (state.mode === 'clear' || state.mode === 'none') return null;
  return undefined;
}

/**
 * Optional thumbnail field. The editor posts an already-uploaded URL in
 * `thumbnail_url` (JS fills it after `POST /p/thumbnail`, or the reader pastes
 * a link by hand), plus a `remove_thumbnail` checkbox when editing.
 *
 *   create + empty            -> no thumbnail
 *   edit   + empty            -> keep the stored URL untouched
 *   edit   + "remove" checked -> clear it
 *   anything else             -> set (validated as an https URL)
 *
 * @param {Record<string, string>} form
 * @param {'create' | 'edit'} mode
 * @param {any} env
 */
function readThumbnail(form, mode, env) {
  const raw = typeof form.thumbnail_url === 'string' ? form.thumbnail_url.trim() : '';
  if (mode === 'edit' && form.remove_thumbnail === '1') return { value: null, url: '', remove: true };
  if (raw === '') return { value: mode === 'edit' ? undefined : null, url: '' };
  const check = validateThumbnailUrl(raw, env);
  // On error the submitted URL is echoed back so the reader can fix a typo
  // rather than re-upload — it is a public link, never a secret.
  if (!check.ok) return { error: check.error, value: undefined, url: raw.slice(0, THUMBNAIL.maxUrlLength) };
  return { value: check.value, url: check.value };
}

/**
 * Read + validate a paste form (create and edit share the rules).
 * @param {Record<string, string>} form
 * @param {{ id: number } | null} user
 * @param {'create' | 'edit'} [mode]
 * @param {any} [env]
 */
function readPasteInput(form, user, mode = 'create', env = {}) {
  const errors = [];
  const title = validateTitle(form.title);
  if (!title.ok) errors.push(title.error);
  const content = validateContent(form.content, maxBytesFor(user));
  if (!content.ok) errors.push(content.error);
  const languageChoice = normalizeLanguageChoice(form.language);
  const language =
    languageChoice === AUTO_LANGUAGE && content.ok
      ? resolvePasteLanguage(languageChoice, title.ok ? title.value : String(form.title ?? ''), content.value, content.bytes)
      : languageChoice;
  const visibility = resolveVisibility(form.visibility, !!user);
  if (!visibility.ok) errors.push(visibility.error);
  const font = normalizeFont(form.font);
  const fontSize = normalizeFontSize(form.font_size ?? form.fontSize);
  const expiration = normalizeExpiration(form.expiration ?? form.expiresIn);
  const passphrase = readPassphrase(form, mode);
  if (passphrase.error) errors.push(passphrase.error);
  const burnMode = validateBurnMode(form.burn_after);
  if (!burnMode.ok) errors.push(burnMode.error);
  const thumbnail = readThumbnail(form, mode, env);
  if (thumbnail.error) errors.push(thumbnail.error);
  return {
    errors,
    thumbnailUrl: thumbnail.value,
    thumbnailValue: thumbnail.url,
    thumbnailRemove: Boolean(thumbnail.remove),
    title: title.ok ? title.value : String(form.title ?? '').slice(0, 200),
    content: content.ok ? content.value : String(form.content ?? ''),
    language,
    languageChoice,
    font,
    fontSize,
    expiration,
    passphrase: passphrase.state,
    burnMode: burnMode.ok ? burnMode.value : DEFAULT_BURN_MODE,
    visibility: visibility.ok ? visibility.value : DEFAULT_VISIBILITY,
  };
}

// ---------------------------------------------------------------------------
// Home / editor
// ---------------------------------------------------------------------------

/** GET / */
export async function home(ctx) {
  const body = editorPage({
    ...pageCtx(ctx),
    mode: 'create',
    values: {
      title: DEFAULT_FILENAME,
      content: '',
      language: AUTO_LANGUAGE,
      font: 'mono',
      font_size: 14,
      expiration: '1w',
      burn_after: DEFAULT_BURN_MODE,
      protected: false,
      visibility: DEFAULT_VISIBILITY,
      thumbnail_url: '',
    },
    maxBytes: maxBytesFor(ctx.user),
    uploads: uploadsEnabled(ctx.env),
  });
  return htmlResponse(body, 200, {}, { cache: 'no-store' });
}

/** POST /p */
export async function create(ctx) {
  const verdict = await consume(ctx.db, ctx.user ? `create:user:${ctx.user.id}` : `create:ip:${ctx.ip}`, RATE_LIMITS.create);
  if (!verdict.ok) {
    throw new HttpError(429, `Too many pastes created. Try again in about ${Math.ceil(verdict.retryAfter / 60)} minute(s).`, {
      'Retry-After': String(verdict.retryAfter),
    });
  }

  const form = parseForm(await readBody(ctx.request, LIMITS.bodyMaxBytes + 64 * 1024));
  const input = readPasteInput(form, ctx.user, 'create', ctx.env);
  if (input.errors.length) {
    // Never echo multi-megabyte bodies back into the form on error.
    const oversized = (form.content ?? '').length > 100_000;
    if (oversized) throw new HttpError(413, input.errors.find((e) => /limit/.test(e)) || input.errors[0]);
    const body = editorPage({
      ...pageCtx(ctx),
      mode: 'create',
      values: {
        title: input.title,
        content: cleanText(form.content ?? ''),
        language: input.languageChoice,
        font: input.font,
        font_size: input.fontSize,
        expiration: input.expiration.id,
        burn_after: input.burnMode,
        protected: input.passphrase.mode === 'set',
        visibility: input.visibility,
        thumbnail_url: input.thumbnailValue,
      },
      errors: input.errors,
      maxBytes: maxBytesFor(ctx.user),
      uploads: uploadsEnabled(ctx.env),
    });
    return htmlResponse(body, 400);
  }

  const paste = await createPaste(ctx.db, {
    title: input.title,
    content: input.content,
    language: input.language,
    font: input.font,
    fontSize: input.fontSize,
    expiresAt: input.expiration.expiresAt,
    userId: ctx.user ? ctx.user.id : null,
    passwordHash: await resolvePassphraseHash(input.passphrase),
    burnMode: input.burnMode,
    visibility: input.visibility,
    thumbnailUrl: input.thumbnailUrl,
    now: ctx.now,
  });

  // Opportunistic sweep so expired content disappears even between cron runs.
  await pruneExpired(ctx.db, ctx.now, CLEANUP_BATCH).catch(() => 0);

  return redirect(`/p/${paste.id}?created=1`);
}

// ---------------------------------------------------------------------------
// Paste view / raw / edit / delete
// ---------------------------------------------------------------------------

/** GET /p/:id */
export async function view(ctx, params) {
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const paste = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
  if (!paste) throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');

  // Password-protected and not (yet) unlocked: show the lock screen only.
  // A failed look-up is never counted as a view and never consumes anything.
  if (!(await canReadPaste(ctx, paste))) {
    return htmlResponse(
      unlockPage({
        ...pageCtx(ctx),
        paste,
        burnLabel: burnLabel(paste),
        thumbnailUrl: safeThumbnailUrl(paste.thumbnail_url, ctx.env),
      }),
      200,
      {},
      { noindex: true },
    );
  }

  // Burn-after-reading: claim the single allowed view before rendering, and
  // hand the losers the standard 404. This runs after the password gate, so a
  // lock screen can never consume a one-time paste.
  if (!(await claimBurnForRead(ctx.db, paste, 'view'))) {
    throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');
  }

  const burning = burnModeOf(paste) !== DEFAULT_BURN_MODE;
  const visitor = await visitorHash(appSecret(ctx), ctx.ip, paste.id);
  // A one-time paste is deleted as it is served, so there is nothing to count.
  const views = burning ? Number(paste.views) : await recordView(ctx.db, paste.id, visitor, ctx.now).catch(() => Number(paste.views));

  const oversized = paste.size > LIMITS.highlightMaxBytes;
  const contentHtml = oversized
    ? renderCode(paste.content, 'plaintext')
    : addLineAnchors(renderCode(paste.content, paste.language));

  const body = pastePage({
    ...pageCtx(ctx),
    paste: { ...paste, views },
    contentHtml,
    thumbnailUrl: safeThumbnailUrl(paste.thumbnail_url, ctx.env),
    highlighted: !oversized,
    lineNumbers: !oversized,
    share: ctx.url.searchParams.has('created'),
    absoluteUrl: `${ctx.url.origin}/p/${paste.id}`,
    isOwner: isPasteOwner(paste, ctx.user),
  });
  return htmlResponse(body, 200, {}, { noindex: true });
}

/** GET /p/:id/qr — server-rendered QR page; generating a share link never reads or burns content. */
export async function qr(ctx, params) {
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const paste = await getPaste(ctx.db, params.id, { content: false, now: ctx.now });
  if (!paste) throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');
  const anchor = normalizeLineAnchor(ctx.url.searchParams.get('line'));
  const targetUrl = canonicalPasteUrl(ctx.url.origin, paste.id, anchor);
  const query = anchor ? `?line=${anchor.slice('line-'.length)}` : '';
  let image;
  try {
    image = qrSvg(targetUrl);
  } catch {
    throw new HttpError(400, 'This paste URL is too long to encode as a QR code.');
  }
  return htmlResponse(
    qrPage({
      ...pageCtx(ctx),
      paste,
      unlocked: await canReadPaste(ctx, paste),
      targetUrl,
      imagePath: `/p/${paste.id}/qr.svg${query}`,
      downloadPath: `/p/${paste.id}/qr.svg${query}${query ? '&' : '?'}download=1`,
      qrSvg: image,
    }),
    200,
    {},
    { noindex: true },
  );
}

/** GET /p/:id/qr.svg — image-only QR endpoint; it has no paste-content read path. */
export async function qrImage(ctx, params) {
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const paste = await getPaste(ctx.db, params.id, { content: false, now: ctx.now });
  if (!paste) throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');
  const anchor = normalizeLineAnchor(ctx.url.searchParams.get('line'));
  const targetUrl = canonicalPasteUrl(ctx.url.origin, paste.id, anchor);
  let image;
  try {
    image = qrSvg(targetUrl);
  } catch {
    throw new HttpError(400, 'This paste URL is too long to encode as a QR code.');
  }
  const disposition = ctx.url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
  return svgResponse(
    image,
    {
      'Content-Disposition': `${disposition}; filename="mantisbin-${paste.id}-qr.svg"`,
      'X-Robots-Tag': 'noindex, nofollow',
    },
    { cache: 'private, max-age=300', noindex: true },
  );
}

/**
 * POST /p/:id/unlock — verify the passphrase and remember it in a signed,
 * HttpOnly cookie. The passphrase travels only in the request body (form post),
 * goes straight into PBKDF2 and is never logged, echoed or stored.
 */
export async function unlock(ctx, params) {
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const paste = await getPaste(ctx.db, params.id, { content: false, now: ctx.now });
  if (!paste) throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');
  if (!paste.password_hash) return redirect(`/p/${paste.id}`);

  const verdict = await consume(ctx.db, unlockBucketKey(paste.id, ctx.ip), RATE_LIMITS.unlock);
  if (!verdict.ok) {
    throw new HttpError(
      429,
      `Too many unlock attempts for this paste. Try again in about ${Math.ceil(verdict.retryAfter / 60)} minute(s).`,
      { 'Retry-After': String(verdict.retryAfter) },
    );
  }

  const form = parseForm(await readBody(ctx.request, 4 * 1024));
  const ok = await verifyPassphrase(form.password, paste.password_hash);
  if (!ok) {
    const body = unlockPage({
      ...pageCtx(ctx),
      paste,
      burnLabel: burnLabel(paste),
      errors: ['Wrong passphrase.'],
      locked: true,
      thumbnailUrl: safeThumbnailUrl(paste.thumbnail_url, ctx.env),
    });
    return htmlResponse(body, 401, {}, { noindex: true });
  }

  const entry = await issueUnlockToken(appSecret(ctx), paste.id, ctx.now + UNLOCK_TTL_SECONDS);
  const value = rememberUnlock(ctx.cookies[COOKIE.unlock] || '', entry, ctx.now, UNLOCK_MAX_TOKENS);
  return redirectWithCookie(
    safeRedirectTarget(form.next, `/p/${paste.id}`),
    unlockCookieString(value, { secure: ctx.secure }),
  );
}

/** GET /p/:id/raw and /api/pastes/:id/raw */
export async function raw(ctx, params) {
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const paste = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
  if (!paste) throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');
  // curl-friendly gate: plain text, 401, and not a single byte of content.
  if (!(await canReadPaste(ctx, paste))) {
    const minutes = Math.round(UNLOCK_TTL_SECONDS / 60);
    return textResponse(
      `This paste is password-protected.\nUnlock it at ${ctx.url.origin}/p/${paste.id} (the unlock lasts about ${minutes} minutes and needs cookies).\n`,
      401,
      { 'WWW-Authenticate': 'mantisbin-unlock', 'X-Robots-Tag': 'noindex, nofollow' },
      { cache: 'no-store' },
    );
  }
  // Burn-after-reading in `read` mode: /raw consumes the paste too. This runs
  // after the password gate and after the 401 above, so neither can burn it.
  if (!(await claimBurnForRead(ctx.db, paste, 'read'))) {
    return textResponse('This paste does not exist, or it expired and was deleted.\n', 404, {
      'X-Robots-Tag': 'noindex, nofollow',
    }, { cache: 'no-store' });
  }
  const filename = downloadFilename(paste.title);
  const disposition = ctx.url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
  return textResponse(
    paste.content,
    200,
    {
      'Content-Disposition': `${disposition}; filename="${filename}"`,
      'X-Robots-Tag': 'noindex, nofollow',
    },
    { cache: 'private, max-age=60' },
  );
}

/**
 * GET /p/:id/fork — the duplicate screen behind "Create a copy".
 *
 * The form is the ordinary editor (pre-filled from the source) posting to the
 * ordinary create endpoint, so a copy is a normal paste created by the actor:
 * own random id, own expiration, own view count, own ownership, and the create
 * limits/validation apply unchanged. Nothing is copied from a paste the actor
 * cannot read: a protected source shows the unlock screen first (the unlock form
 * posts `next` straight back here), and a one-time source is consumed by this
 * read exactly as a view would be.
 */
export async function forkForm(ctx, params) {
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const paste = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
  if (!paste) throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');

  if (!(await canReadPaste(ctx, paste))) {
    return htmlResponse(
      unlockPage({
        ...pageCtx(ctx),
        paste,
        burnLabel: burnLabel(paste),
        next: `/p/${paste.id}/fork`,
        thumbnailUrl: safeThumbnailUrl(paste.thumbnail_url, ctx.env),
      }),
      200,
      {},
      { noindex: true },
    );
  }

  const oneTime = burnLabel(paste);
  if (!(await claimBurnForRead(ctx.db, paste, 'view'))) {
    throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');
  }

  const body = editorPage({
    ...pageCtx(ctx),
    mode: 'fork',
    pasteId: paste.id,
    values: {
      title: paste.title,
      content: paste.content,
      language: paste.language,
      font: paste.font,
      font_size: paste.font_size,
      expiration: expirationPresetFor(paste.expires_at, ctx.now),
      burn_after: DEFAULT_BURN_MODE,
      protected: false,
      visibility: DEFAULT_VISIBILITY,
      // The thumbnail is a public URL on a shared host, so the copy can point
      // at the same image. Nothing is re-uploaded and the source is untouched.
      thumbnail_url: safeThumbnailUrl(paste.thumbnail_url, ctx.env) || '',
    },
    okMessage: oneTime
      ? `This was a one-time paste (${oneTime}) and has now been consumed — the copy you save is the only copy left.`
      : null,
    maxBytes: maxBytesFor(ctx.user),
    uploads: uploadsEnabled(ctx.env),
  });
  return htmlResponse(body, 200, {}, { noindex: true });
}

/** GET /p/:id/edit */
export async function editForm(ctx, params) {
  if (!ctx.user) return redirect(`/login?next=${encodeURIComponent(`/p/${params.id}/edit`)}`);
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const paste = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
  if (!paste) throw new HttpError(404, 'This paste does not exist, or it expired and was deleted.');
  if (paste.user_id === null || Number(paste.user_id) !== Number(ctx.user.id)) {
    throw new HttpError(403, 'Only the account that created a paste can edit it.');
  }

  const body = editorPage({
    ...pageCtx(ctx),
    mode: 'edit',
    pasteId: paste.id,
    values: {
      title: paste.title,
      content: paste.content,
      language: paste.language,
      font: paste.font,
      font_size: paste.font_size,
      expiration: expirationPresetFor(paste.expires_at, ctx.now),
      burn_after: burnModeOf(paste),
      protected: Boolean(paste.password_hash),
      visibility: paste.visibility,
      thumbnail_url: safeThumbnailUrl(paste.thumbnail_url, ctx.env) || '',
      had_thumbnail: Boolean(safeThumbnailUrl(paste.thumbnail_url, ctx.env)),
    },
    maxBytes: maxBytesFor(ctx.user),
    uploads: uploadsEnabled(ctx.env),
  });
  return htmlResponse(body, 200, {}, { noindex: true });
}

/** POST /p/:id/edit */
export async function editSave(ctx, params) {
  if (!ctx.user) throw new HttpError(401);
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const existing = await getPaste(ctx.db, params.id, { content: false, now: ctx.now });
  if (!existing) throw new HttpError(404);
  if (existing.user_id === null || Number(existing.user_id) !== Number(ctx.user.id)) {
    throw new HttpError(403, 'Only the account that created a paste can edit it.');
  }

  const form = parseForm(await readBody(ctx.request, LIMITS.bodyMaxBytes + 64 * 1024));
  const input = readPasteInput(form, ctx.user, 'edit', ctx.env);
  if (input.errors.length) {
    if ((form.content ?? '').length > 100_000) {
      throw new HttpError(413, input.errors.find((e) => /limit/.test(e)) || input.errors[0]);
    }
    const full = await getPaste(ctx.db, params.id, { content: true, now: ctx.now });
    const body = editorPage({
      ...pageCtx(ctx),
      mode: 'edit',
      pasteId: params.id,
      values: {
        title: input.title || full?.title || '',
        content: cleanText(form.content ?? ''),
        language: input.languageChoice,
        font: input.font,
        font_size: input.fontSize,
        expiration: input.expiration.id,
        burn_after: input.burnMode,
        protected: Boolean(full?.password_hash),
        visibility: input.visibility,
        thumbnail_url: input.thumbnailRemove ? '' : input.thumbnailValue || safeThumbnailUrl(full?.thumbnail_url, ctx.env) || '',
        thumbnail_remove: input.thumbnailRemove,
        had_thumbnail: Boolean(safeThumbnailUrl(full?.thumbnail_url, ctx.env)),
      },
      errors: input.errors,
      maxBytes: maxBytesFor(ctx.user),
      uploads: uploadsEnabled(ctx.env),
    });
    return htmlResponse(body, 400, {}, { noindex: true });
  }

  const result = await updatePaste(
    ctx.db,
    params.id,
    ctx.user.id,
    {
      title: input.title,
      content: input.content,
      language: input.language,
      font: input.font,
      fontSize: input.fontSize,
      expiresAt: input.expiration.expiresAt,
      passwordHash: await resolvePassphraseHash(input.passphrase),
      burnMode: input.burnMode,
      visibility: input.visibility,
      thumbnailUrl: input.thumbnailUrl,
    },
    ctx.now,
  );
  if (!result.ok) throw new HttpError(result.reason === 'missing' ? 404 : 403);
  return redirect(`/p/${params.id}`);
}

/** POST /p/:id/delete */
export async function remove(ctx, params) {
  if (!ctx.user) throw new HttpError(401);
  if (!isValidPasteId(params.id)) throw new HttpError(404);
  const result = await deletePaste(ctx.db, params.id, ctx.user.id);
  if (!result.ok) {
    throw new HttpError(result.reason === 'missing' ? 404 : 403, result.reason === 'missing' ? undefined : 'Only the account that created a paste can delete it.');
  }
  return redirect('/me?deleted=1');
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/**
 * POST /p/thumbnail — upload one image and get a URL back.
 *
 * The editor calls this with `multipart/form-data` (field `image`) *before* the
 * paste is saved, then puts the returned URL in the hidden `thumbnail_url`
 * input; the paste form itself stays plain urlencoded and keeps working with
 * JavaScript disabled (paste a link instead). Bytes are forwarded to the
 * configured image host and never touch the database — the response is a URL.
 *
 * It is deliberately not tied to a paste id: nothing is created or modified
 * here, so an upload cannot burn, unlock or overwrite anything.
 */
export async function uploadThumbnailImage(ctx) {
  if (!uploadsEnabled(ctx.env)) {
    throw new HttpError(501, 'Image uploads are not configured on this instance. Paste an image URL instead.');
  }
  const verdict = await consume(
    ctx.db,
    ctx.user ? `thumb:user:${ctx.user.id}` : `thumb:ip:${ctx.ip}`,
    RATE_LIMITS.thumbnail,
  );
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many image uploads. Try again later.', {
      'Retry-After': String(verdict.retryAfter),
    });
  }

  const contentType = ctx.request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new HttpError(415, 'Send the image as multipart/form-data with an "image" field.');
  }
  // Cheap ceiling before the body is read at all: the client resizes to a
  // 1200×630 JPEG, so anything near this is not a resized card.
  const declared = Number(ctx.request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > THUMBNAIL.maxBytes + 64 * 1024) {
    throw new HttpError(413, 'That image is too large.');
  }

  let file;
  try {
    const body = await ctx.request.formData();
    file = body.get('image');
  } catch {
    throw new HttpError(400, 'That upload could not be read.');
  }
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    throw new HttpError(400, 'No image was uploaded.');
  }

  const check = validateUpload(/** @type {any} */ (file));
  if (!check.ok) throw new HttpError(415, check.error);

  const result = await uploadThumbnail(/** @type {any} */ (file), String(check.value), ctx.env);
  if (!result.ok) {
    // Most upstream failures are a 502, but a 429/413 the host names passes
    // through with its own status (and Retry-After) so the reader can act on it.
    const extra = result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : undefined;
    throw new HttpError(result.status || 502, result.error, extra);
  }
  return jsonResponse({ url: result.value }, 201, {}, { noindex: true });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** GET /login */
export async function loginForm(ctx) {
  if (ctx.user) return redirect('/me');
  return htmlResponse(loginPage({ ...pageCtx(ctx), values: { username: ctx.url.searchParams.get('username') || '' } }), 200, {}, { noindex: true });
}

/** POST /login */
export async function login(ctx) {
  const verdict = await consume(ctx.db, `auth:${ctx.ip}`, RATE_LIMITS.auth);
  if (!verdict.ok) throw new HttpError(429, 'Too many sign-in attempts. Wait a few minutes.', { 'Retry-After': String(verdict.retryAfter) });

  const form = parseForm(await readBody(ctx.request, 16 * 1024));
  const user = await authenticate(ctx.db, form.username, form.password);
  if (!user) {
    return htmlResponse(
      loginPage({ ...pageCtx(ctx), values: { username: form.username || '' }, errors: ['Wrong username or password.'] }),
      401,
      {},
      { noindex: true },
    );
  }
  const session = await createSession(ctx.db, user.id, null, ctx.now);
  return redirectWithCookie(
    safeRedirectTarget(ctx.url.searchParams.get('next'), '/me'),
    sessionCookie(session.token, { secure: ctx.secure }),
  );
}

/** GET /register */
export async function registerForm(ctx) {
  if (ctx.user) return redirect('/me');
  return htmlResponse(registerPage({ ...pageCtx(ctx) }), 200, {}, { noindex: true });
}

/** POST /register */
export async function register(ctx) {
  const verdict = await consume(ctx.db, `auth:${ctx.ip}`, RATE_LIMITS.auth);
  if (!verdict.ok) throw new HttpError(429, 'Too many attempts. Wait a few minutes.', { 'Retry-After': String(verdict.retryAfter) });

  const form = parseForm(await readBody(ctx.request, 16 * 1024));
  const result = await registerUser(ctx.db, form.username, form.password, ctx.now);
  if (!result.ok) {
    return htmlResponse(
      registerPage({ ...pageCtx(ctx), values: { username: form.username || '' }, errors: [result.error] }),
      400,
      {},
      { noindex: true },
    );
  }
  const session = await createSession(ctx.db, result.user.id, null, ctx.now);
  return redirectWithCookie('/me', sessionCookie(session.token, { secure: ctx.secure }));
}

/** POST /logout */
export async function logout(ctx) {
  const token = ctx.cookies[COOKIE.session];
  if (token) await destroySession(ctx.db, token);
  return redirectWithCookie('/', clearSessionCookie(ctx.secure));
}

/** POST /theme */
export async function setTheme(ctx) {
  const form = parseForm(await readBody(ctx.request, 4 * 1024));
  const requested = String(form.theme || '').toLowerCase();
  const theme = requested === 'light' || requested === 'dark' || requested === 'ocean' ? requested : 'auto';
  return redirectWithCookie(
    safeRedirectTarget(form.next, '/'),
    `${COOKIE.theme}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${ctx.secure ? '; Secure' : ''}`,
  );
}

// ---------------------------------------------------------------------------
// My pastes + API keys
// ---------------------------------------------------------------------------

/** GET /me */
export async function myPastes(ctx) {
  if (!ctx.user) return redirect(`/login?next=${encodeURIComponent('/me')}`);
  const [pastes, apiKeys, stats] = await Promise.all([
    listUserPastes(ctx.db, ctx.user.id, 200, ctx.now),
    listApiKeys(ctx.db, ctx.user.id),
    userStats(ctx.db, ctx.user.id, ctx.now),
  ]);
  const body = myPastesPage({
    ...pageCtx(ctx),
    pastes: withThumbnails(pastes, ctx.env),
    apiKeys,
    stats,
    newKey: null,
    notice: ctx.url.searchParams.get('deleted') ? 'Paste deleted.' : null,
  });
  return htmlResponse(body, 200, {}, { noindex: true });
}

/** POST /me/keys */
export async function createKey(ctx) {
  if (!ctx.user) throw new HttpError(401);
  const form = parseForm(await readBody(ctx.request, 4 * 1024));
  const created = await createApiKey(ctx.db, ctx.user.id, form.label, ctx.now);
  await enforceApiKeyLimit(ctx.db, ctx.user.id);
  const apiKeys = await listApiKeys(ctx.db, ctx.user.id);
  const pastes = await listUserPastes(ctx.db, ctx.user.id, 200, ctx.now);
  const stats = await userStats(ctx.db, ctx.user.id, ctx.now);
  const body = myPastesPage({ ...pageCtx(ctx), pastes: withThumbnails(pastes, ctx.env), apiKeys, stats, newKey: created.plain });
  return htmlResponse(body, 201, {}, { noindex: true });
}

/** POST /me/keys/revoke */
export async function revokeKey(ctx) {
  if (!ctx.user) throw new HttpError(401);
  const form = parseForm(await readBody(ctx.request, 4 * 1024));
  await revokeApiKey(ctx.db, ctx.user.id, form.id);
  return redirect('/me');
}

// ---------------------------------------------------------------------------
// Docs + brand assets
// ---------------------------------------------------------------------------

/** GET /docs */
export async function docs(ctx) {
  const body = docsPage({
    ...pageCtx(ctx),
    baseUrl: ctx.url.origin,
    thumbnailUploads: uploadsEnabled(ctx.env),
  });
  return htmlResponse(body, 200, {}, { cache: 'public, max-age=300' });
}

/** GET /favicon.svg */
export async function favicon() {
  return svgResponse(faviconSvg(), {}, { cache: 'public, max-age=86400, immutable' });
}

/** GET /logo.svg */
export async function logo() {
  return svgResponse(logoSvg(), {}, { cache: 'public, max-age=86400, immutable' });
}

/** GET /mark.svg */
export async function mark() {
  return svgResponse(markSvg(), {}, { cache: 'public, max-age=86400, immutable' });
}

/** 303 redirect that also sets a cookie, with the standard security headers. */
function redirectWithCookie(location, cookieString) {
  return new Response(null, {
    status: 303,
    headers: headers({ Location: location, 'Set-Cookie': cookieString }),
  });
}

/** Re-exported so existing callers keep one import site for the app secret. */
export { appSecret };
