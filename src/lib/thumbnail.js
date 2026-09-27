/**
 * Optional paste thumbnails (2.4).
 *
 * MantisBin never stores image bytes. One small picture is uploaded to a public
 * image host, and the paste row keeps only the returned URL. This module owns
 * the rules that make that safe:
 *
 *   1. **Any https host, but https only.** A stored thumbnail must be an
 *      `https:` URL (never `data:` bytes or plaintext `http:`), but it may point
 *      at any image host — uploads land on catbox.moe or 0x0.st, and authors can
 *      paste a link to an image anywhere else. Because arbitrary remote images
 *      are allowed, the page's `img-src` CSP is `https:` (see lib/http.js); the
 *      trade-off is deliberate and documented.
 *   2. **Public by construction.** The image lives on a public host under a
 *      guessable-to-nobody but unauthenticated URL. It is therefore readable by
 *      anyone who has the link, *including for a password-protected or
 *      burn-after-reading paste*. Every surface that shows one says so, and the
 *      unlock screen treats it as metadata (like the view count), never content.
 *
 *      This extends past the paste's own lifetime: deleting, expiring or burning
 *      a paste removes the row (and therefore the link), but MantisBin cannot
 *      delete the file from a host it does not own — a one-time paste's picture
 *      is not one-time. The editor's warning is worded to cover that.
 *   3. **One outbound request per provider, bounded.** Each provider in the
 *      chain gets a single request with a byte ceiling checked before it is
 *      built, a timeout, and no redirects followed. Nothing is retried and
 *      nothing is cached.
 *
 * Runtime-agnostic: `fetch`, `FormData` and `AbortSignal` only — the same code
 * runs in the Worker, the Node dev server and the tests.
 */

import { THUMBNAIL, THUMBNAIL_DEFAULT_HOSTS, THUMBNAIL_PROVIDERS } from '../config.js';

/** @typedef {{ ok: boolean, value?: string, error?: string, status?: number, retryAfter?: number }} Result */

/** Milliseconds before an upload to catbox is abandoned. */
const UPLOAD_TIMEOUT_MS = 20_000;

/**
 * Identifies outbound uploads to the image hosts. Some hosts filter anonymous
 * traffic from datacenter IPs (which is what Cloudflare Workers egress from),
 * so an honest UA is the difference between "filtered as bulk slop" and a
 * diagnosable response — and it tells the host's operator who to contact.
 * 0x0.st asks client authors for exactly this, and to never masquerade as a
 * browser, so the string names the program and its source.
 */
const UPLOAD_USER_AGENT = 'MantisBin/thumbnail-upload (+https://github.com/harshi79/MantisBin)';

/**
 * Hosts listed by default in the page `img-src`, lowercased and de-duplicated.
 *
 * Arbitrary `https:` thumbnail URLs are allowed (see `validateThumbnailUrl`), so
 * this list is only the default set surfaced in the CSP and shown as examples;
 * `img-src` itself is widened to `https:` in lib/http.js. Operators can still
 * add named hosts with `THUMBNAIL_HOSTS` (comma or space-separated).
 * @param {any} env
 * @returns {string[]}
 */
export function allowedThumbnailHosts(env) {
  const hosts = new Set(THUMBNAIL_DEFAULT_HOSTS.map((host) => host.toLowerCase()));
  for (const entry of String(env?.THUMBNAIL_HOSTS || '').split(/[\s,]+/)) {
    const host = normalizeHost(entry);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/** Lowercase a host and strip anything that is not a plain hostname. */
function normalizeHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) return '';
  return host;
}

/**
 * Validate a thumbnail URL for storage.
 *
 * `''`/absent is a valid "no thumbnail" (the caller decides whether that means
 * keep or clear). Anything else must be an absolute `https:` URL, on any host,
 * with no credentials, and within the length cap. The host is intentionally not
 * restricted: authors may link an image anywhere, and uploads land on catbox.
 * @param {unknown} value
 * @param {any} _env unused; kept for a stable signature across call sites
 * @returns {Result}
 */
export function validateThumbnailUrl(value, _env) {
  if (value === null || value === undefined || value === '') return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false, error: 'Thumbnail must be a URL.' };
  const raw = value.trim();
  if (raw === '') return { ok: true, value: '' };
  if (raw.length > THUMBNAIL.maxUrlLength) {
    return { ok: false, error: `Thumbnail URL must be ${THUMBNAIL.maxUrlLength} characters or fewer.` };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'Thumbnail must be a complete URL, for example https://files.catbox.moe/abc123.jpg.' };
  }
  // `data:` and `http:` are both refused: one embeds bytes we promised not to
  // store, the other is a mixed-content request that leaks the reader's IP.
  if (url.protocol !== 'https:') return { ok: false, error: 'Thumbnail URL must start with https://.' };
  if (url.username || url.password) return { ok: false, error: 'Thumbnail URL must not contain credentials.' };

  return { ok: true, value: url.toString() };
}

/**
 * Whitelist a URL that is already in the database before it reaches a page.
 * Defence in depth: still re-validates the protocol/shape of a stored value.
 * @returns {string | null}
 */
export function safeThumbnailUrl(value, env) {
  const check = validateThumbnailUrl(value, env);
  return check.ok && check.value ? check.value : null;
}

/** Is a thumbnail attached to this row? */
export function hasThumbnail(paste) {
  return typeof paste?.thumbnail_url === 'string' && paste.thumbnail_url.trim() !== '';
}

/**
 * Which upload back ends are configured, in the order they are tried.
 *
 * The default chain is catbox.moe first and 0x0.st second. That order matters:
 * catbox keeps a file indefinitely, while 0x0.st expires it, so the permanent
 * host is always preferred and the fallback only ever sees the uploads catbox
 * refused — which, from a Cloudflare Worker, is exactly the datacenter-IP
 * filtering that answers `200 OK` with the sentence `Invalid Uploader`.
 *
 * `THUMBNAIL_PROVIDERS` (comma or space separated) narrows or reorders the
 * chain — `"catbox"` restores single-host behaviour, `"nullpointer,catbox"`
 * inverts it. An unknown id is ignored, and if none of the names are known the
 * default chain is used, so a typo degrades to the documented default instead
 * of quietly switching uploading off. `THUMBNAIL_UPLOADS="off"` is the switch
 * that does that.
 * @param {any} env
 * @returns {typeof THUMBNAIL_PROVIDERS}
 */
export function uploadProviders(env) {
  if (env?.THUMBNAIL_UPLOADS === 'off') return [];
  const known = new Map(THUMBNAIL_PROVIDERS.map((provider) => [provider.id, provider]));
  const wanted = String(env?.THUMBNAIL_PROVIDERS || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const order = wanted.length ? wanted : THUMBNAIL_PROVIDERS.map((provider) => provider.id);
  /** @type {typeof THUMBNAIL_PROVIDERS} */
  const chain = [];
  for (const id of order) {
    const provider = known.get(id);
    // De-duplicated: repeating an id must not send the same bytes twice.
    if (provider && !chain.includes(provider)) chain.push(provider);
  }
  return chain.length ? chain : THUMBNAIL_PROVIDERS;
}

/**
 * The provider an upload is attempted on first, or `null` when uploading is
 * off. Reported by `/api/meta` so a client can see the intended host.
 * @param {any} env
 * @returns {string | null}
 */
export function uploadProvider(env) {
  return uploadProviders(env)[0]?.id ?? null;
}

/** Can this deployment accept image uploads at all? */
export function uploadsEnabled(env) {
  return uploadProviders(env).length > 0;
}

/** Display names of the configured chain, in order (for the editor's help text). */
export function uploadHostLabels(env) {
  return uploadProviders(env).map((provider) => provider.label);
}

/**
 * Check an uploaded image before a single byte leaves the Worker.
 * @param {{ type?: string, size?: number }} file
 * @returns {Result}
 */
export function validateUpload(file) {
  if (!file || typeof file.size !== 'number') return { ok: false, error: 'No image was uploaded.' };
  if (file.size === 0) return { ok: false, error: 'That image is empty.' };
  if (file.size > THUMBNAIL.maxBytes) {
    return {
      ok: false,
      error: `Image is too large after resizing (limit ${Math.round(THUMBNAIL.maxBytes / (1024 * 1024))} MB).`,
    };
  }
  const type = String(file.type || '').toLowerCase().split(';')[0].trim();
  if (!THUMBNAIL.types.includes(type)) {
    return { ok: false, error: `Unsupported image type. Use ${THUMBNAIL.types.map((t) => t.replace('image/', '')).join(', ')}.` };
  }
  return { ok: true, value: type };
}

/** A boring, extension-correct filename for the upload host. */
export function uploadFilename(type) {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type] || 'jpg';
  return `thumbnail.${extension}`;
}

/**
 * A catbox failure that already knows how it should surface: a safe,
 * user-facing message plus the HTTP status the route should answer with.
 * `detail` is the operator-oriented half — status and a sanitized fragment —
 * and goes to `wrangler tail`, never to the reader.
 */
class UpstreamError extends Error {
  /**
   * @param {string} message user-safe message
   * @param {{ status?: number, retryAfter?: number | null, detail?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = options.status || 502;
    this.retryAfter = options.retryAfter ?? null;
    this.detail = options.detail || '';
  }
}

/**
 * Keep a one-line, plain-text fragment of an upstream reply for user messages
 * and logs. Anything that looks like markup — a block page, an HTML error
 * document — is dropped, so host HTML can never leak into a response.
 * @param {unknown} text
 * @param {number} [max]
 */
function cleanSnippet(text, max = 120) {
  // Collapse whitespace, strip control characters, drop anything with markup.
  const oneLine = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();
  if (!oneLine || /[<>]/.test(oneLine)) return '';
  return oneLine.slice(0, max);
}

/**
 * Pull a human sentence out of an upstream error body. Catbox replies in plain
 * text, so it is used as-is; a JSON error document contributes its
 * `error`/`message` field instead of raw braces.
 * @param {unknown} text
 */
function messageFromUpstreamBody(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const data = JSON.parse(raw);
      const candidate = data?.error || data?.message;
      return cleanSnippet(candidate);
    } catch {
      return '';
    }
  }
  return cleanSnippet(raw);
}

/** @param {Response} response */
function retryAfterOf(response) {
  const raw = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.ceil(raw), 3600) : null;
}

/**
 * Map an upstream HTTP error status to an `UpstreamError`. Rate limiting and
 * "too large" pass through with their own status so the caller — and the
 * reader — can act on them; anything else is a 502 with the status and a
 * sanitized fragment attached for the operator.
 * @param {Response} response
 * @param {unknown} snippet raw upstream body, for context only
 * @param {string} [providerId] which host answered, for the operator log
 */
function httpFailure(response, snippet, providerId = 'catbox') {
  const status = response?.status || 502;
  const detail = messageFromUpstreamBody(snippet);
  const quoted = detail ? ` ("${detail}")` : '';
  const logDetail = `${providerId} responded ${status}${cleanSnippet(snippet, 200) ? `: ${cleanSnippet(snippet, 200)}` : ''}`;
  if (status === 429) {
    return new UpstreamError(
      'The image host is rate-limiting uploads. Wait a minute and try again, or paste an image URL instead.',
      { status: 429, retryAfter: retryAfterOf(response) || 60, detail: logDetail },
    );
  }
  if (status === 413) {
    return new UpstreamError(
      'The image host rejected the image as too large. Try a smaller image, or paste an image URL instead.',
      { status: 413, detail: logDetail },
    );
  }
  return new UpstreamError(
    detail
      ? `The image host refused the upload${quoted}. Try again, or paste an image URL instead.`
      : `The image host refused the upload (HTTP ${status}). Try again, or paste an image URL instead.`,
    { status: 502, detail: logDetail },
  );
}

/**
 * Forward one image through the configured provider chain and return the URL
 * the first host that accepts it hands back.
 *
 * Never throws for a remote failure: the caller turns `{ ok: false }` into an
 * HTTP error with a readable message, because "the image host is down" is not a
 * bug in this paste. Most upstream failures are a 502; a 429 or 413 the host
 * names passes through with its own status (and `Retry-After`) so the reader
 * can act on it. The response URL is validated (https, no credentials) before
 * it can reach a page.
 *
 * A refusal is not the end of the story: catbox answers `200 OK` with a
 * sentence such as `Invalid Uploader` when it filters the Worker's datacenter
 * IP, so the chain continues and the fallback host gets the same image. Only
 * when *every* provider refuses does the upload fail — and then the reader sees
 * the first provider's message, because that is the host this instance is
 * configured around, while `wrangler tail` shows the whole chain.
 *
 * @param {Blob} blob raw image bytes (already validated)
 * @param {string} type validated MIME type
 * @param {any} env
 * @returns {Promise<Result>}
 */
export async function uploadThumbnail(blob, type, env) {
  const chain = uploadProviders(env);
  if (!chain.length) return { ok: false, error: 'Image uploads are not configured on this instance.' };

  /** @type {Result | null} */
  let firstFailure = null;
  for (const [index, provider] of chain.entries()) {
    try {
      return { ok: true, value: await uploadToProvider(provider, blob, type, env) };
    } catch (error) {
      const failure = uploadFailure(error);
      firstFailure ||= failure;
      console.warn('[mantisbin] thumbnail upload failed', {
        provider: provider.id,
        status: failure.status,
        detail: failure.log,
        // Naming the next hop turns a one-line failure into the whole story.
        ...(index + 1 < chain.length ? { fellBackTo: chain[index + 1].id } : {}),
      });
    }
  }
  return firstFailure || { ok: false, error: 'The image host could not be reached. Try again, or paste an image URL instead.' };
}

/**
 * Normalise anything a single upload attempt threw into the `{ ok: false }`
 * the route answers with, plus the operator-facing half for the log.
 * @param {any} error
 * @returns {Result & { log: string }}
 */
function uploadFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { ok: false, error: 'The image host timed out. Try again, or paste an image URL instead.', status: 502, log: 'timed out' };
  }
  if (error instanceof UpstreamError) {
    const result = { ok: false, error: error.message, status: error.status, log: error.detail || error.message };
    if (error.retryAfter) result.retryAfter = error.retryAfter;
    return result;
  }
  const message = String(error?.message || '');
  const cause = String(error?.cause?.message || error?.cause || '');
  return {
    ok: false,
    error: 'The image host could not be reached. Try again, or paste an image URL instead.',
    status: 502,
    log: cleanSnippet(`${message} ${cause}`, 200) || 'unreachable',
  };
}

/** `AbortSignal.timeout` exists on Workers and Node 22; fall back just in case. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Upload to one provider and return the URL it handed back, already validated.
 *
 * Each host has its own dialect — catbox wants `reqtype` (and a `userhash` when
 * the operator configured one) with the bytes in `fileToUpload`, 0x0.st wants
 * them in `file` — so `config.js` carries the field names and this stays
 * generic. Both answer with the URL as plain text, and both answer `200 OK`
 * with a sentence when they refuse, so a non-URL body is a refusal.
 * @param {typeof THUMBNAIL_PROVIDERS[number]} provider
 * @param {Blob} blob
 * @param {string} type
 * @param {any} env
 * @returns {Promise<string>}
 */
async function uploadToProvider(provider, blob, type, env) {
  const body = new FormData();
  for (const [field, value] of Object.entries(provider.fields || {})) {
    body.append(field, value);
  }
  if (provider.userhashField && env?.CATBOX_USERHASH) {
    body.append(provider.userhashField, String(env.CATBOX_USERHASH));
  }
  body.append(provider.fileField, blob, uploadFilename(type));

  const response = await fetch(provider.endpoint, {
    method: 'POST',
    headers: { 'User-Agent': UPLOAD_USER_AGENT, Accept: 'text/plain,*/*' },
    body,
    // Workers reject `redirect: 'error'` with a TypeError before any request
    // is sent, so use 'manual' and refuse 3xx responses ourselves.
    redirect: 'manual',
    signal: timeoutSignal(UPLOAD_TIMEOUT_MS),
  });
  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    throw new UpstreamError(
      'The image host redirected the upload unexpectedly. Try again, or paste an image URL instead.',
      { status: 502, detail: `${provider.id} responded ${response.status} redirect to ${cleanSnippet(response.headers.get('location') || '', 200)}` },
    );
  }
  const text = (await response.text()).trim();
  if (!response.ok) throw httpFailure(response, text, provider.id);
  // Both hosts answer `200 OK` with an error sentence when they refuse an
  // upload — catbox does it when it filters traffic from datacenter IPs, which
  // is what Workers egress from. Surface the sentence when it is plain text; a
  // block page stays in the log only.
  if (!/^https:\/\//i.test(text)) {
    const detail = messageFromUpstreamBody(text);
    throw new UpstreamError(
      detail
        ? `The image host refused the upload ("${detail}"). Try again, or paste an image URL instead.`
        : 'The image host refused the upload. Try again, or paste an image URL instead.',
      { status: 502, detail: `${provider.id} refused the upload: ${cleanSnippet(text, 200) || '(empty response)'}` },
    );
  }
  return text;
}
