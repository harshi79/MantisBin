/**
 * Media + pack JSON (merge phase 4).
 *
 *   GET /api/stickers   the curated sticker pack (public, cacheable)
 *   GET /api/gifs       GIF search: Giphy (`?q=`) or one anime category
 *
 * Both are read-only, rate-limited per IP, and never expose a key. The GIF
 * endpoint is the only place in the app that talks to a third party on behalf
 * of a *browser*, so it is also the one that must fail quietly: a provider
 * outage returns `{ gifs: [], degraded: true }` with a 200, and the picker
 * says "nothing found" — the editor never breaks because Giphy is down.
 */

import { RATE_LIMITS } from '../config.js';
import { HttpError, jsonResponse } from '../lib/http.js';
import { clampResults, nekoGif, normalizeQuery, searchGiphyResult } from '../lib/media.js';
import { consume } from '../lib/ratelimit.js';
import { listStickerPack } from '../lib/stickers.js';

/** One shared per-IP bucket for provider-backed reads. */
async function mediaLimit(ctx) {
  const verdict = await consume(ctx.db, `media:${ctx.ip}`, RATE_LIMITS.media, ctx.now);
  if (!verdict.ok) {
    throw new HttpError(429, 'Too many media searches. Try again later.', {
      'Retry-After': String(verdict.retryAfter),
    });
  }
}

/**
 * GET /api/stickers
 *
 * The pack is the same for everybody and only changes when an administrator
 * edits it, so it is cacheable at the edge (`stale-while-revalidate` keeps a
 * brief outage invisible to readers).
 */
export async function stickers(ctx) {
  await mediaLimit(ctx);
  const pack = await listStickerPack(ctx.db);
  return jsonResponse({ stickers: pack }, 200, {}, { noindex: true, cache: 'public, max-age=60, stale-while-revalidate=300' });
}

/**
 * GET /api/gifs?q=cat&limit=24   → Giphy search (trending when `q` is empty)
 * GET /api/gifs?category=hug     → one Nekos.best anime GIF
 *
 * `degraded` tells a client the provider was unreachable *without* turning a
 * provider problem into an error the paste editor has to handle.
 */
export async function gifs(ctx) {
  await mediaLimit(ctx);
  const query = normalizeQuery(ctx.url.searchParams.get('q'));
  const category = String(ctx.url.searchParams.get('category') || '').trim().toLowerCase();
  const limit = clampResults(ctx.url.searchParams.get('limit'));

  if (category) {
    const gif = await nekoGif(category);
    return jsonResponse(
      { gifs: gif ? [gif] : [], provider: 'neko', category, query: '', degraded: !gif },
      200,
      {},
      { noindex: true, cache: 'public, max-age=60, stale-while-revalidate=600' },
    );
  }

  const { gifs: results, ok } = await searchGiphyResult(ctx.env, query, limit, Date.now());
  return jsonResponse(
    // An empty result set is not an outage: `degraded` is only set when the
    // provider never answered, so the picker can say which happened.
    { gifs: results, provider: 'giphy', query, category: '', degraded: !ok },
    200,
    {},
    // Short: a search is per-visitor, and the provider's own quota is the thing
    // being protected. Trending (`q` empty) is the same for everyone.
    { noindex: true, cache: query ? 'public, max-age=30, stale-while-revalidate=120' : 'public, max-age=300, stale-while-revalidate=1800' },
  );
}
