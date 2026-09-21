/**
 * Optional paste thumbnails (2.4).
 *
 * MantisBin never stores image bytes. One small picture is uploaded to a
 * third-party image host, and the paste row keeps only the returned URL. This
 * module owns the three rules that make that safe:
 *
 *   1. **Host allowlist.** A stored thumbnail must be an `https:` URL on a host
 *      the operator allows (config `THUMBNAIL_DEFAULT_HOSTS`, plus anything in
 *      the `THUMBNAIL_HOSTS` variable and the configured imgtree origin). An
 *      arbitrary remote `<img>` is an IP logger for every reader of a paste, so
 *      the same list is also the page's `img-src` CSP directive — a URL that
 *      slipped past validation still cannot load.
 *   2. **Public by construction.** The image lives on a public host under a
 *      guessable-to-nobody but unauthenticated URL. It is therefore readable by
 *      anyone who has the link, *including for a password-protected or
 *      burn-after-reading paste*. Every surface that shows one says so, and the
 *      unlock screen treats it as metadata (like the view count), never content.
 *
 *      This extends past the paste's own lifetime: deleting, expiring or burning
 *      a paste removes the row (and therefore the link), but MantisBin cannot
 *      delete the file from a host it does not own — a one-time paste's picture
 *      is not one-time. The editor's warning is worded to cover that, which is
 *      the only honest thing to do about somebody else's storage.
 *   3. **One outbound request, bounded.** Uploads are forwarded once, with a
 *      byte ceiling checked before the request is built, a timeout, and no
 *      redirects followed. Nothing is retried and nothing is cached.
 *
 * Runtime-agnostic: `fetch`, `FormData` and `AbortSignal` only — the same code
 * runs in the Worker, the Node dev server and the tests.
 */

import {
  IMGTREE_DEFAULT_BASE_URL,
  THUMBNAIL,
  THUMBNAIL_DEFAULT_HOSTS,
} from '../config.js';

/** @typedef {{ ok: boolean, value?: string, error?: string, status?: number, retryAfter?: number }} Result */

/** Milliseconds before an upload to an image host is abandoned. */
const UPLOAD_TIMEOUT_MS = 20_000;

/**
 * Identifies outbound uploads to the image hosts. Some hosts filter anonymous
 * traffic from datacenter IPs (which is what Cloudflare Workers egress from),
 * so an honest UA is the difference between "filtered as bulk slop" and a
 * diagnosable response — and it tells the host's operator who to contact.
 */
const UPLOAD_USER_AGENT = 'MantisBin/thumbnail-upload (+https://github.com/harshi79/MantisBin)';

/** `https://imgtree.co` (or the operator's own deployment), without a trailing slash. */
export function imgtreeBaseUrl(env) {
  const raw = String(env?.IMGTREE_BASE_URL || IMGTREE_DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/, '');
}

/**
 * Hosts whose images may be stored and rendered, lowercased and de-duplicated.
 *
 * Built from the defaults, the operator's `THUMBNAIL_HOSTS` (comma or
 * space-separated) and the host of `IMGTREE_BASE_URL`, so pointing the app at a
 * self-hosted imgtree never needs a second variable.
 * @param {any} env
 * @returns {string[]}
 */
export function allowedThumbnailHosts(env) {
  const hosts = new Set(THUMBNAIL_DEFAULT_HOSTS.map((host) => host.toLowerCase()));
  for (const entry of String(env?.THUMBNAIL_HOSTS || '').split(/[\s,]+/)) {
    const host = normalizeHost(entry);
    if (host) hosts.add(host);
  }
  try {
    const host = normalizeHost(new URL(imgtreeBaseUrl(env)).hostname);
    if (host) hosts.add(host);
  } catch {
    /* a malformed IMGTREE_BASE_URL simply contributes no host */
  }
  return [...hosts];
}

/** Lowercase a host and strip anything that is not a plain hostname. */
function normalizeHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) return '';
  return host;
}

/** True when `host` is the allowed host itself or a subdomain of it. */
function hostMatches(host, allowed) {
  return host === allowed || host.endsWith(`.${allowed}`);
}

/**
 * Validate a thumbnail URL for storage.
 *
 * `''`/absent is a valid "no thumbnail" (the caller decides whether that means
 * keep or clear). Anything else must be an absolute `https:` URL, on an allowed
 * host, with no credentials, and within the length cap.
 * @param {unknown} value
 * @param {any} env
 * @returns {Result}
 */
export function validateThumbnailUrl(value, env) {
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

  const host = url.hostname.toLowerCase();
  const allowed = allowedThumbnailHosts(env);
  if (!allowed.some((entry) => hostMatches(host, entry))) {
    return {
      ok: false,
      error: `Thumbnails may only be hosted on: ${allowed.join(', ')}. Upload the image instead and the link is filled in for you.`,
    };
  }
  return { ok: true, value: url.toString() };
}

/**
 * Whitelist a URL that is already in the database before it reaches a page.
 * Defence in depth: an allowlist edited *down* by an operator must hide images
 * that were legal when they were stored, without a migration.
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
 * Which upload back end is configured, if any.
 * @param {any} env
 * @returns {'imgtree' | 'catbox' | null}
 */
export function uploadProvider(env) {
  if (env?.IMGTREE_API_KEY) return 'imgtree';
  if (env?.THUMBNAIL_UPLOADS === 'off') return null;
  return 'catbox';
}

/** Can this deployment accept image uploads at all? */
export function uploadsEnabled(env) {
  return uploadProvider(env) !== null;
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
 * An image-host failure that already knows how it should surface: a safe,
 * user-facing message plus the HTTP status the route should answer with.
 * `detail` is the operator-oriented half — provider, status and a sanitized
 * fragment — and goes to `wrangler tail`, never to the reader.
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
 * Pull a human sentence out of an upstream error body. Plain-text APIs (catbox)
 * are used as-is; a JSON error document contributes its `error`/`message`
 * field instead of raw braces.
 * @param {unknown} text
 */
function messageFromUpstreamBody(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const data = JSON.parse(raw);
      const candidate = data?.error || data?.message || data?.images?.[0]?.error;
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
 * @param {'catbox' | 'imgtree'} provider
 * @param {Response} response
 * @param {unknown} snippet raw upstream body, for context only
 */
function httpFailure(provider, response, snippet) {
  const status = response?.status || 502;
  const detail = messageFromUpstreamBody(snippet);
  const quoted = detail ? ` ("${detail}")` : '';
  const logDetail = `${provider} responded ${status}${cleanSnippet(snippet, 200) ? `: ${cleanSnippet(snippet, 200)}` : ''}`;
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
 * Forward one image to the configured host and return the URL it hands back.
 *
 * Never throws for a remote failure: the caller turns `{ ok: false }` into an
 * HTTP error with a readable message, because "catbox is down" is not a bug in
 * this paste. Most upstream failures are a 502; a 429 or 413 the host names
 * passes through with its own status (and `Retry-After`) so the reader can act
 * on it. The response URL is validated against the same allowlist as a
 * hand-typed one, so a compromised or misconfigured host cannot inject an
 * arbitrary origin into a page.
 *
 * @param {Blob} blob raw image bytes (already validated)
 * @param {string} type validated MIME type
 * @param {any} env
 * @returns {Promise<Result>}
 */
export async function uploadThumbnail(blob, type, env) {
  const provider = uploadProvider(env);
  if (!provider) return { ok: false, error: 'Image uploads are not configured on this instance.' };

  try {
    const url =
      provider === 'imgtree'
        ? await uploadToImgtree(blob, type, env)
        : await uploadToCatbox(blob, type, env);
    if (!url) return { ok: false, error: 'The image host did not return a link. Try again.' };
    const check = validateThumbnailUrl(url, env);
    if (!check.ok) {
      return { ok: false, error: 'The image host returned a link from an unexpected domain, so it was discarded.' };
    }
    return check;
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, error: 'The image host timed out. Try again, or paste an image URL instead.' };
    }
    if (error instanceof UpstreamError) {
      console.warn('[mantisbin] thumbnail upload failed', {
        provider,
        status: error.status,
        detail: error.detail || error.message,
      });
      const result = { ok: false, error: error.message, status: error.status };
      if (error.retryAfter) result.retryAfter = error.retryAfter;
      return result;
    }
    // With `redirect: 'error'` a redirect surfaces as a TypeError, not a
    // response — name it, so a smuggled redirect and a dead host look different.
    const message = String(error?.message || '');
    const cause = String(error?.cause?.message || error?.cause || '');
    if (/redirect/i.test(`${message} ${cause}`)) {
      console.warn('[mantisbin] thumbnail upload failed', {
        provider,
        status: 502,
        detail: cleanSnippet(message, 200) || 'upload redirect blocked',
      });
      return { ok: false, error: 'The image host redirected the upload unexpectedly. Try again, or paste an image URL instead.' };
    }
    console.warn('[mantisbin] thumbnail upload failed', {
      provider,
      status: 502,
      detail: cleanSnippet(`${message} ${cause}`, 200) || 'unreachable',
    });
    return { ok: false, error: 'The image host could not be reached. Try again, or paste an image URL instead.' };
  }
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
 * imgtree — `POST /api/v1/upload`, multipart `file`, Bearer key.
 * Documented response: `{ success, images: [{ url, direct_url, thumb_url, … }] }`.
 * The mid-size `thumb_url` is preferred; `direct_url` is the full-size fallback.
 */
async function uploadToImgtree(blob, type, env) {
  const body = new FormData();
  body.append('file', blob, uploadFilename(type));
  if (env.IMGTREE_ALBUM_ID) body.append('albumId', String(env.IMGTREE_ALBUM_ID));

  const response = await fetch(`${imgtreeBaseUrl(env)}/api/v1/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.IMGTREE_API_KEY}`,
      Accept: 'application/json',
      'User-Agent': UPLOAD_USER_AGENT,
    },
    body,
    redirect: 'error',
    signal: timeoutSignal(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    const snippet = await response.text().catch(() => '');
    // A 401/403 is operator misconfiguration (missing, revoked or suspended
    // key), not a reader error — the reader gets a plain apology while the
    // log tells the operator exactly which secret to check.
    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError(
        'Image uploads are temporarily unavailable. Try again later, or paste an image URL instead.',
        { status: 502, detail: `imgtree responded ${response.status} — the IMGTREE_API_KEY is missing, revoked or suspended` },
      );
    }
    throw httpFailure('imgtree', response, snippet);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new UpstreamError(
      'The image host returned an unexpected response. Try again, or paste an image URL instead.',
      { status: 502, detail: 'imgtree returned invalid JSON' },
    );
  }
  const image = Array.isArray(data?.images) ? data.images[0] : null;
  if (!image || image.error) {
    const detail = messageFromUpstreamBody(image?.error);
    throw new UpstreamError(
      detail
        ? `The image host refused the upload ("${detail}"). Try again, or paste an image URL instead.`
        : 'The image host refused the upload. Try again, or paste an image URL instead.',
      { status: 502, detail: `imgtree reported a per-file error: ${cleanSnippet(image?.error, 200) || '(no image in response)'}` },
    );
  }
  // A paste page renders a card-sized picture, so the resized rendition is the
  // right one; `direct_url` (the untouched original) is the fallback.
  return String(image.thumb_url || image.direct_url || image.url || '').trim();
}

/**
 * catbox.moe — `POST /user/api.php`, multipart, plain-text response that is the
 * URL itself. Anonymous unless the operator supplies `CATBOX_USERHASH` (which
 * makes uploads deletable from that account).
 */
async function uploadToCatbox(blob, type, env) {
  const body = new FormData();
  body.append('reqtype', 'fileupload');
  if (env.CATBOX_USERHASH) body.append('userhash', String(env.CATBOX_USERHASH));
  body.append('fileToUpload', blob, uploadFilename(type));

  const response = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    headers: { 'User-Agent': UPLOAD_USER_AGENT, Accept: 'text/plain,*/*' },
    body,
    redirect: 'error',
    signal: timeoutSignal(UPLOAD_TIMEOUT_MS),
  });
  const text = (await response.text()).trim();
  if (!response.ok) throw httpFailure('catbox', response, text);
  // Catbox answers `200 OK` with an error sentence when it refuses an upload —
  // for example when it filters traffic from datacenter IPs, which is what
  // Workers egress from. Surface the sentence when it is plain text; a block
  // page stays in the log only.
  if (!/^https:\/\//i.test(text)) {
    const detail = messageFromUpstreamBody(text);
    throw new UpstreamError(
      detail
        ? `The image host refused the upload ("${detail}"). Try again, or paste an image URL instead.`
        : 'The image host refused the upload. Try again, or paste an image URL instead.',
      { status: 502, detail: `catbox refused the upload: ${cleanSnippet(text, 200) || '(empty response)'}` },
    );
  }
  return text;
}
