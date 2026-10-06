/**
 * Outbound GIF search for the editor (merge phase 4).
 *
 * Two providers, both called **by the Worker, never by the browser**:
 *
 *  - **Nekos.best** — keyless, one random anime GIF per category. Used by the
 *    editor's "Anime" tab, with a curated category list (~24, not the ~70 the
 *    reference implementation resolved in a single request: one category per
 *    request is cheaper, cacheable and always degrades).
 *  - **Giphy** — `GIPHY_API_KEY` when the operator sets one, otherwise Giphy's
 *    published public beta key, exactly like VibeBin. A beta key is a shared
 *    quota that can be withdrawn at any time, which is why **every function
 *    here returns an empty result instead of throwing**: the picker shows
 *    "nothing found" and the editor keeps working. No key is ever required to
 *    deploy, and none is ever sent to a browser.
 *
 * Results are normalised to one shape:
 *
 *   { id, url, preview, label, provider: 'giphy' | 'neko', emoji }
 *
 * `url` is the image the paste will show; `preview` is the small grid image.
 * Both are `https:` and are re-validated on the way out (`safeStickerUrl`), so
 * a rogue provider response cannot smuggle a `javascript:`/`data:` URL into a
 * paste or into the curated pack.
 */

import { MEDIA } from '../config.js';
import { safeStickerUrl } from './formatting.js';

/** Every outbound call is bounded: a slow provider must never hold a request. */
const TIMEOUT_MS = 8000;
const NEKO_BASE = 'https://nekos.best/api/v2/';
const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';

/**
 * The anime reaction categories offered by the editor. Deliberately a short,
 * hand-picked list: it is a picker, not a catalogue, and each entry is one
 * outbound request.
 */
export const NEKO_CATEGORIES = [
  { id: 'hug', label: 'Hug', emoji: '🤗' },
  { id: 'cuddle', label: 'Cuddle', emoji: '🥰' },
  { id: 'pat', label: 'Pat', emoji: '🖐️' },
  { id: 'kiss', label: 'Kiss', emoji: '😘' },
  { id: 'blush', label: 'Blush', emoji: '😊' },
  { id: 'smile', label: 'Smile', emoji: '😄' },
  { id: 'wink', label: 'Wink', emoji: '😉' },
  { id: 'laugh', label: 'Laugh', emoji: '😆' },
  { id: 'cry', label: 'Cry', emoji: '😢' },
  { id: 'dance', label: 'Dance', emoji: '💃' },
  { id: 'wave', label: 'Wave', emoji: '👋' },
  { id: 'thumbsup', label: 'Thumbs up', emoji: '👍' },
  { id: 'clap', label: 'Clap', emoji: '👏' },
  { id: 'highfive', label: 'High five', emoji: '🙌' },
  { id: 'poke', label: 'Poke', emoji: '👉' },
  { id: 'think', label: 'Think', emoji: '🤔' },
  { id: 'shy', label: 'Shy', emoji: '😳' },
  { id: 'baka', label: 'Baka', emoji: '🤪' },
  { id: 'bite', label: 'Bite', emoji: '😬' },
  { id: 'bonk', label: 'Bonk', emoji: '🔨' },
  { id: 'sleep', label: 'Sleep', emoji: '😴' },
  { id: 'happy', label: 'Happy', emoji: '😊' },
  { id: 'yes', label: 'Yes', emoji: '✅' },
  { id: 'nope', label: 'Nope', emoji: '🚫' },
];

/** Giphy key: the operator's own, or the published beta key. Never a secret leak. */
export function giphyKey(env) {
  return String(env?.GIPHY_API_KEY || '').trim() || MEDIA.giphyBetaKey;
}

/** Is that host on the provider's trusted list? Used to gate pack imports. */
export function isTrustedMediaUrl(value, provider) {
  const url = safeStickerUrl(value);
  if (!url) return false;
  const hosts = provider === 'neko' ? MEDIA.nekoHosts : MEDIA.giphyHosts;
  const host = new URL(url).hostname.toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * One bounded JSON GET. Returns `null` for every failure mode — non-2xx,
 * timeout, network error, unparseable body — because a provider outage is not
 * an error in the pastebin.
 */
async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      // No credentials, no referrer: this is a public search, not a session.
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Clamp a requested result count into the configured window. */
export function clampResults(value) {
  const wanted = Number(value);
  if (!Number.isFinite(wanted) || wanted <= 0) return MEDIA.results;
  return Math.min(Math.floor(wanted), MEDIA.resultsMax);
}

/** Trim and cap a search query so nothing user-shaped reaches a provider URL. */
export function normalizeQuery(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MEDIA.queryMax);
}

/** One Giphy image object → our shape, or null when it is unusable. */
function giphyEntry(gif) {
  if (!gif || typeof gif !== 'object') return null;
  const images = gif.images || {};
  const pick = (key) => (images[key] && typeof images[key].url === 'string' ? images[key].url : null);
  const url = safeStickerUrl(pick('fixed_width') || pick('original') || pick('downsized'));
  if (!url || !gif.id) return null;
  const preview = safeStickerUrl(pick('preview_gif') || pick('fixed_width_small') || pick('downsized_still'));
  const label = String(gif.title || '')
    .replace(/^gif\s*/i, '')
    .trim()
    .slice(0, 80);
  return {
    id: String(gif.id),
    url,
    preview: preview || url,
    label: label || 'GIF',
    provider: 'giphy',
    emoji: '',
  };
}

/** The provider URL for a search (or trending when the query is empty). */
function giphySearchUrl(env, query, limit) {
  const trimmed = normalizeQuery(query);
  const count = clampResults(limit);
  const key = encodeURIComponent(giphyKey(env));
  return trimmed
    ? `${GIPHY_BASE}/search?api_key=${key}&q=${encodeURIComponent(trimmed)}&limit=${count}&rating=g&lang=en`
    : `${GIPHY_BASE}/trending?api_key=${key}&limit=${count}&rating=g`;
}

/**
 * Giphy search, or trending when the query is empty.
 *
 * `ok` distinguishes "the provider answered and had nothing" from "the provider
 * did not answer" — the picker shows a different message for each, and only the
 * second one is an outage.
 * @returns {Promise<{ gifs: any[], ok: boolean }>}
 */
export async function searchGiphyResult(env, query, limit = MEDIA.results, now = Date.now()) {
  const payload = await fetchJson(giphySearchUrl(env, query, limit));
  if (payload === null) return { gifs: [], ok: false };
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return { gifs: list.map(giphyEntry).filter(Boolean), ok: true };
}

/** Giphy search, results only (an outage and an empty search look alike). */
export async function searchGiphy(env, query, limit = MEDIA.results, now = Date.now()) {
  return (await searchGiphyResult(env, query, limit, now)).gifs;
}

/** Resolve one Giphy GIF by its stable id (used when importing into the pack). */
export async function giphyById(env, id) {
  const clean = String(id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(clean)) return null;
  const payload = await fetchJson(`${GIPHY_BASE}/${encodeURIComponent(clean)}?api_key=${encodeURIComponent(giphyKey(env))}`);
  return giphyEntry(payload?.data);
}

/** One random anime GIF for a curated category, with its emoji fallback. */
export async function nekoGif(category) {
  const id = String(category ?? '').trim().toLowerCase();
  const known = NEKO_CATEGORIES.find((entry) => entry.id === id);
  if (!known) return null;
  const payload = await fetchJson(`${NEKO_BASE}${encodeURIComponent(known.id)}`);
  const first = Array.isArray(payload?.results) ? payload.results[0] : null;
  const url = safeStickerUrl(first?.url);
  if (!url) return null;
  return {
    id: `neko-${known.id}`,
    url,
    preview: url,
    label: known.label,
    provider: 'neko',
    emoji: known.emoji,
  };
}

/** The anime category list, for the editor's picker. */
export function nekoCategories() {
  return NEKO_CATEGORIES.map((entry) => ({ ...entry }));
}
