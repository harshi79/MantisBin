/**
 * HTML routes. Forms post urlencoded and work without JavaScript; every
 * validation here is also enforced for the JSON API in routes/api.js.
 */

import {
  BURN_MODES,
  CLEANUP_BATCH,
  COOKIE,
  DEFAULT_BURN_MODE,
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
import { HttpError, headers, htmlResponse, parseForm, readBody, redirect, safeRedirectTarget, svgResponse, textResponse } from '../lib/http.js';
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
import { canonicalPasteUrl, normalizeLineAnchor, qrSvg } from '../lib/qr.js';
import { faviconSvg, logoSvg, markSvg } from '../assets/mark.js';
import {
  cleanText,
  expirationPresetFor,
  isValidPasteId,
  normalizeExpiration,
  normalizeFont,
  normalizeFontSize,
  normalizeLanguageChoice,
  safeFilename,
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
  visitorHash,
} from '../lib/pastes.js';
import { consume } from '../lib/ratelimit.js';
import { detectLanguage } from '../lib/detect.js';
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
 * Read + validate a paste form (create and edit share the rules).
 * @param {Record<string, string>} form
 * @param {{ id: number } | null} user
 * @param {'create' | 'edit'} [mode]
 */
function readPasteInput(form, user, mode = 'create') {
  const errors = [];
  const title = validateTitle(form.title);
  if (!title.ok) errors.push(title.error);
  const content = validateContent(form.content, maxBytesFor(user));
  if (!content.ok) errors.push(content.error);
  const languageChoice = normalizeLanguageChoice(form.language);
  const language = languageChoice === 'auto' && content.ok ? detectLanguage(content.value, content.bytes) : languageChoice;
  const font = normalizeFont(form.font);
  const fontSize = normalizeFontSize(form.font_size ?? form.fontSize);
  const expiration = normalizeExpiration(form.expiration ?? form.expiresIn);
  const passphrase = readPassphrase(form, mode);
  if (passphrase.error) errors.push(passphrase.error);
  const burnMode = validateBurnMode(form.burn_after);
  if (!burnMode.ok) errors.push(burnMode.error);
  return {
    errors,
    title: title.ok ? title.value : String(form.title ?? '').slice(0, 200),
    content: content.ok ? content.value : String(form.content ?? ''),
    language,
    languageChoice,
    font,
    fontSize,
    expiration,
    passphrase: passphrase.state,
    burnMode: burnMode.ok ? burnMode.value : DEFAULT_BURN_MODE,
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
      title: '',
      content: '',
      language: 'plaintext',
      font: 'mono',
      font_size: 14,
      expiration: '1w',
      burn_after: DEFAULT_BURN_MODE,
      protected: false,
    },
    maxBytes: maxBytesFor(ctx.user),
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
  const input = readPasteInput(form, ctx.user);
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
      },
      errors: input.errors,
      maxBytes: maxBytesFor(ctx.user),
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
      unlockPage({ ...pageCtx(ctx), paste, burnLabel: burnLabel(paste) }),
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
  const filename = `${safeFilename(paste.title)}.txt`;
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
    },
    okMessage: oneTime
      ? `This was a one-time paste (${oneTime}) and has now been consumed — the copy you save is the only copy left.`
      : null,
    maxBytes: maxBytesFor(ctx.user),
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
    },
    maxBytes: maxBytesFor(ctx.user),
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
  const input = readPasteInput(form, ctx.user, 'edit');
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
      },
      errors: input.errors,
      maxBytes: maxBytesFor(ctx.user),
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
  const theme = form.theme === 'light' ? 'light' : 'dark';
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
  const [pastes, apiKeys] = await Promise.all([
    listUserPastes(ctx.db, ctx.user.id, 200, ctx.now),
    listApiKeys(ctx.db, ctx.user.id),
  ]);
  const body = myPastesPage({
    ...pageCtx(ctx),
    pastes,
    apiKeys,
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
  const body = myPastesPage({ ...pageCtx(ctx), pastes, apiKeys, newKey: created.plain });
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
  const body = docsPage({ ...pageCtx(ctx), baseUrl: ctx.url.origin });
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
