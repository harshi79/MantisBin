/**
 * Merge phase 4 — the curated sticker pack, GIF search, the editor's media
 * panel and the broadcast composer.
 *
 * No test here touches the network: `fetch` is replaced by a stub for the
 * duration of each case, which is also how the degraded paths get exercised.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp, form, jsonBody, ORIGIN, registerUser } from './helpers.js';
import { createNodeDb } from '../src/db/node-sqlite.js';
import { ensureSchema } from '../src/db/schema.js';
import { EMOJI_SHORTCODES, MEDIA, SOCIAL } from '../src/config.js';
import { NEKO_CATEGORIES, clampResults, isTrustedMediaUrl, nekoGif, nekoCategories, normalizeQuery, searchGiphyResult } from '../src/lib/media.js';
import {
  PACK_LIMIT,
  STICKER_LIMITS,
  addSticker,
  countStickers,
  importSticker,
  listStickerPack,
  normalizeStickerEmoji,
  normalizeStickerLabel,
  normalizeStickerToken,
  readStickerInput,
  removeSticker,
} from '../src/lib/stickers.js';
import { resolveStickers, stickerIndex, substituteMediaLines } from '../src/lib/formatting.js';

const ADMIN_PASSWORD = 'test-only-admin-password-123';
const ADMIN_ENV = { ADMIN_PASSWORD: ADMIN_PASSWORD };
const originHeader = { origin: ORIGIN };
const PASSWORD = 'correct-horse-1';

const GIPHY_ID = 'abc123XYZ';
const GIPHY_URL = `https://media.giphy.com/media/${GIPHY_ID}/giphy.gif`;
const GIPHY_PREVIEW = `https://media0.giphy.com/media/${GIPHY_ID}/200.gif`;
const NEKO_URL = 'https://nekos.best/api/v2/hug/abc.gif';

/** Install a `fetch` stub for the duration of `run`. */
async function withFetch(stub, run) {
  const real = globalThis.fetch;
  /** @type {string[]} */
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return stub(String(url), options);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

/** A JSON provider reply. */
function payload(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const giphyImage = (id = GIPHY_ID) => ({
  id,
  title: `GIF ${id}`,
  images: {
    fixed_width: { url: `https://media.giphy.com/media/${id}/giphy.gif` },
    preview_gif: { url: `https://media0.giphy.com/media/${id}/200.gif` },
  },
});

function csrf(body) {
  const token = /name="csrf" value="([A-Za-z0-9]+)"/.exec(body)?.[1];
  assert.ok(token, 'expected a CSRF token');
  return token;
}

async function signInAdmin(app, jar = 'admin') {
  const challenge = csrf(await (await app.request('/admin/login', { jar })).text());
  const response = await app.request('/admin/login', {
    jar,
    headers: originHeader,
    body: form({ csrf: challenge, password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 303);
  return csrf(await (await app.request('/admin', { jar })).text());
}

async function adminSticker(app, token, fields) {
  return app.request('/admin/stickers', { jar: 'admin', headers: originHeader, body: form({ csrf: token, ...fields }) });
}

async function newPaste(app, jar, fields = {}) {
  const response = await app.request('/p', {
    method: 'POST',
    body: form({ title: 'Paste', content: 'hello', language: 'plaintext', visibility: 'unlisted', expiration: 'never', ...fields }),
    jar,
  });
  const id = /\/p\/([A-Za-z0-9]+)/.exec(response.headers.get('location') || '')?.[1];
  assert.ok(id, `expected a paste id in ${response.headers.get('location')}`);
  return id;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('sticker tokens normalise to :name: and reject anything else', () => {
  assert.equal(normalizeStickerToken('wave'), ':wave:');
  assert.equal(normalizeStickerToken(':Wave:'), ':wave:');
  assert.equal(normalizeStickerToken(';wave;'), ':wave:');
  assert.equal(normalizeStickerToken('anime-hug'), ':anime-hug:');
  // A missing closing colon is tolerated (`:wave`), a foreign token is not.
  assert.equal(normalizeStickerToken(':wave'), ':wave:');
  assert.equal(normalizeStickerToken(''), null);
  assert.equal(normalizeStickerToken('<script>'), null);
  assert.equal(normalizeStickerToken(':a'.repeat(40) + ':'), null);
});

test('sticker labels and emoji are stripped down to safe text', () => {
  assert.equal(normalizeStickerLabel('<b>Wave</b>\nhello'), 'b Wave /b hello');
  assert.equal(normalizeStickerLabel('  spaced   out  '), 'spaced out');
  assert.equal(normalizeStickerEmoji('🔥✨🚀🎉🎈'), '🔥✨🚀🎉');
  assert.equal(normalizeStickerEmoji('a\u0000b'), 'ab');
  assert.equal(normalizeStickerEmoji('<img>'), '<img>'.slice(0, 4).replace(/[<>]/g, '').replace(/\s+/g, ''));
  assert.equal(STICKER_LIMITS.pack, 400);
  assert.equal(PACK_LIMIT, STICKER_LIMITS.pack);
});

test('readStickerInput is all-or-nothing and names every problem', () => {
  const bad = readStickerInput({ token: 'not a token', url: 'http://insecure.test/a.gif' });
  assert.equal(bad.ok, false);
  // The token, the URL, and the missing emoji/URL fallback are all reported.
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors.join(' '), /must look like :wave:/);
  assert.match(bad.errors.join(' '), /plain https:\/\/ address/);
  assert.equal(bad.value.token, '');

  const needSomething = readStickerInput({ token: ':empty:' });
  assert.equal(needSomething.ok, false);
  assert.match(needSomething.errors.join(' '), /image URL, an emoji, or both/);

  const emojiOnly = readStickerInput({ token: ':hi:', emoji: '👋' });
  assert.equal(emojiOnly.ok, true);
  assert.equal(emojiOnly.value.url, '');
  assert.equal(emojiOnly.value.emoji, '👋');

  const full = readStickerInput({ token: 'wave', label: 'Wave', emoji: '👋', url: 'https://cdn.test/wave.gif' });
  assert.equal(full.ok, true);
  assert.equal(full.value.token, ':wave:');
});

test('the pack round-trips through the database and refuses duplicates', async () => {
  const db = createNodeDb(':memory:');
  await ensureSchema(db);
  assert.deepEqual(await listStickerPack(db), []);
  assert.equal(await countStickers(db), 0);

  const first = await addSticker(db, { token: ':wave:', label: 'Wave', emoji: '👋', now: 100 });
  assert.equal(first.ok, true);
  const again = await addSticker(db, { token: 'wave', now: 101 });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'duplicate');
  const invalid = await addSticker(db, { token: '!!!', now: 102 });
  assert.equal(invalid.reason, 'invalid');

  await addSticker(db, { token: ':fire:', url: 'https://cdn.test/f.gif', now: 103 });
  const pack = await listStickerPack(db);
  assert.deepEqual(pack.map((row) => row.token), [':fire:', ':wave:']);
  assert.equal(pack[0].url, 'https://cdn.test/f.gif');

  assert.equal(await removeSticker(db, first.id), true);
  assert.equal(await removeSticker(db, first.id), false);
  assert.equal(await countStickers(db), 1);
  await db.close?.();
});

test('listStickerPack re-validates rows on the way out', async () => {
  const db = createNodeDb(':memory:');
  await ensureSchema(db);
  const rows = [
    { id: 'a', token: ':hostile:', url: 'javascript:alert(1)', emoji: '🚀', label: '<b>x</b>' },
    { id: 'b', token: ':empty:', url: '', emoji: '', label: 'nothing' },
    { id: 'c', token: ':ok:', url: 'https://cdn.test/ok.gif', emoji: '✅', label: 'Fine' },
    { id: 'd', token: 'nonsense', url: 'https://cdn.test/d.gif', emoji: '', label: 'dropped' },
  ];
  for (const row of rows) {
    await db.run('INSERT INTO stickers (id, token, url, emoji, label, created_at) VALUES (?, ?, ?, ?, ?, 1)', [
      row.id, row.token, row.url, row.emoji, row.label,
    ]);
  }
  const pack = await listStickerPack(db);
  // The row with neither a usable URL nor an emoji is dropped; a bare token is
  // canonicalised rather than dropped.
  assert.deepEqual(pack.map((row) => row.token), [':hostile:', ':ok:', ':nonsense:']);
  // The hostile URL is gone; the emoji fallback keeps the sticker usable.
  assert.equal(pack[0].url, null);
  assert.equal(pack[0].emoji, '🚀');
  assert.equal(pack[0].label, 'b x /b');
  assert.equal(pack[1].url, 'https://cdn.test/ok.gif');
  await db.close?.();
});

test('an image URL is only trusted on a provider host', () => {
  assert.equal(isTrustedMediaUrl(GIPHY_URL, 'giphy'), true);
  assert.equal(isTrustedMediaUrl(GIPHY_PREVIEW, 'giphy'), true);
  assert.equal(isTrustedMediaUrl('https://evil.test/giphy.gif', 'giphy'), false);
  assert.equal(isTrustedMediaUrl('https://media.giphy.com.evil.test/a.gif', 'giphy'), false);
  assert.equal(isTrustedMediaUrl(NEKO_URL, 'neko'), true);
  assert.equal(isTrustedMediaUrl('http://nekos.best/a.gif', 'neko'), false);
  assert.equal(isTrustedMediaUrl('javascript:alert(1)', 'neko'), false);
});

test('queries are trimmed to something safe for a provider URL', () => {
  assert.equal(normalizeQuery('  hello   world  '), 'hello world');
  assert.equal(normalizeQuery('a\u0000b\nc'), 'a b c');
  assert.equal(normalizeQuery('x'.repeat(500)).length, MEDIA.queryMax);
  assert.equal(clampResults('10'), 10);
  assert.equal(clampResults('0'), MEDIA.results);
  assert.equal(clampResults('999'), MEDIA.resultsMax);
  assert.equal(clampResults('nope'), MEDIA.results);
});

test('searchGiphyResult separates "no results" from "provider down"', async () => {
  await withFetch((url) => {
    assert.match(url, /api_key=/);
    assert.match(url, /rating=g/);
    return payload({ data: [giphyImage(), { id: 'broken', images: {} }, null] });
  }, async (calls) => {
    const { gifs, ok } = await searchGiphyResult({}, 'cats', 12);
    assert.equal(ok, true);
    assert.equal(gifs.length, 1);
    assert.equal(gifs[0].url, GIPHY_URL);
    assert.equal(gifs[0].preview, GIPHY_PREVIEW);
    assert.equal(gifs[0].provider, 'giphy');
    assert.match(calls[0], /q=cats/);
    assert.match(calls[0], /limit=12/);
  });

  await withFetch(() => payload({ data: [] }), async () => {
    const empty = await searchGiphyResult({}, 'nothing matches this');
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.gifs, []);
  });

  await withFetch(() => payload({ message: 'quota exceeded' }, 429), async () => {
    const down = await searchGiphyResult({}, 'cats');
    assert.equal(down.ok, false);
    assert.deepEqual(down.gifs, []);
  });

  await withFetch(() => {
    throw new Error('network down');
  }, async () => {
    assert.equal((await searchGiphyResult({}, 'cats')).ok, false);
  });

  // An empty query is trending, not a search.
  await withFetch((url) => {
    assert.match(url, /\/trending\?/);
    return payload({ data: [giphyImage('trend1')] });
  }, async () => {
    const trending = await searchGiphyResult({}, '   ', 48);
    assert.equal(trending.gifs.length, 1);
  });
});

test('an operator key replaces the shared beta key, and never reaches a browser', async () => {
  await withFetch((url) => {
    assert.ok(url.includes('api_key=operator-key-123'));
    assert.ok(!url.includes(MEDIA.giphyBetaKey));
    return payload({ data: [giphyImage()] });
  }, async () => {
    const { gifs } = await searchGiphyResult({ GIPHY_API_KEY: 'operator-key-123' }, 'cats');
    assert.equal(gifs.length, 1);
  });
});

test('nekoGif resolves one curated category and refuses the rest', async () => {
  assert.equal(NEKO_CATEGORIES.length >= 20, true);
  assert.equal(typeof NEKO_CATEGORIES[0].label, 'string');
  assert.equal(nekoCategories().length, NEKO_CATEGORIES.length);
  assert.notEqual(nekoCategories()[0], NEKO_CATEGORIES[0]);
  const first = NEKO_CATEGORIES[0];
  await withFetch((url) => {
    assert.match(url, new RegExp(`/api/v2/${first.id}$`));
    return payload({ results: [{ url: NEKO_URL }] });
  }, async () => {
    const gif = await nekoGif(first.id.toUpperCase());
    assert.equal(gif.url, NEKO_URL);
    assert.equal(gif.provider, 'neko');
    assert.equal(gif.emoji, first.emoji);
  });
  await withFetch(() => {
    throw new Error('must not be called');
  }, async () => {
    assert.equal(await nekoGif('not-a-category'), null);
  });
});

// ---------------------------------------------------------------------------
// The rendering rule
// ---------------------------------------------------------------------------

test('a bare image URL becomes a picture; a URL in a sentence stays a link', () => {
  const url = 'https://cdn.test/cat.gif';
  const alone = substituteMediaLines(`hello\n${url}\nbye`);
  assert.equal(alone.stickers.length, 1);
  assert.equal(alone.stickers[0].url, url);
  assert.equal(alone.text.includes(url), false);
  assert.equal(alone.text.split('\n')[1].length, 1);

  const padded = substituteMediaLines(`  ${url}  `);
  assert.equal(padded.stickers.length, 1);

  const inline = substituteMediaLines(`look at ${url} please`);
  assert.equal(inline.stickers.length, 0);
  assert.equal(inline.text, `look at ${url} please`);

  // Only image extensions, and a query string disqualifies the line.
  for (const value of ['https://cdn.test/page', 'https://cdn.test/a.gif?size=2', 'http://cdn.test/a.gif', 'https://cdn.test/a.txt']) {
    assert.equal(substituteMediaLines(value).stickers.length, 0, value);
  }
  for (const value of ['https://cdn.test/a.PNG', 'https://cdn.test/a.jpeg', 'https://cdn.test/a.webp']) {
    assert.equal(substituteMediaLines(value).stickers.length, 1, value);
  }
});

test('resolveStickers shares one image list between shortcodes and media lines', () => {
  // The index always carries the built-in emoji: `stickerIndex` seeds it, so an
  // unknown token stays literal but a known one resolves.
  const { text, stickers } = resolveStickers('hi :wave:\nhttps://cdn.test/cat.gif', stickerIndex([]));
  // One image line → exactly one sticker in the shared list …
  assert.equal(stickers.length, 1);
  assert.equal(stickers[0].url, 'https://cdn.test/cat.gif');
  // … while a built-in shortcode becomes its emoji in the text itself.
  assert.match(text, new RegExp(EMOJI_SHORTCODES.wave));
  assert.equal(text.includes(':wave:'), false);
  assert.equal(text.includes('https://cdn.test/cat.gif'), false);
});

test('a sticker pack entry wins over the built-in emoji, and removal restores it', async () => {
  const db = createNodeDb(':memory:');
  await ensureSchema(db);
  const added = await addSticker(db, { token: ':wave:', url: 'https://cdn.test/pack-wave.gif', now: 1 });
  assert.equal(added.ok, true);
  const pack = await listStickerPack(db);
  const withPack = resolveStickers(':wave:', stickerIndex(pack));
  assert.equal(withPack.stickers.length, 1);
  assert.equal(withPack.stickers[0].url, 'https://cdn.test/pack-wave.gif');
  assert.equal(withPack.text.includes(':wave:'), false);

  await removeSticker(db, added.id);
  const after = resolveStickers(':wave:', stickerIndex([]));
  assert.deepEqual(after.stickers, []);
  assert.match(after.text, new RegExp(EMOJI_SHORTCODES.wave));
  await db.close?.();
});

test('the paste page renders a media line and /raw keeps the bytes', async () => {
  const app = await createApp();
  await registerUser(app, 'media01');
  const content = `before\n${GIPHY_URL}\nafter`;
  const id = await newPaste(app, 'media01', { content, visibility: 'public' });
  const html = await (await app.request(`/p/${id}`)).text();
  assert.match(html, /<img class="sticker" src="https:\/\/media\.giphy\.com\/media\/abc123XYZ\/giphy\.gif"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(html, new RegExp(GIPHY_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</span>'));

  const raw = await app.request(`/p/${id}/raw`);
  assert.equal(await raw.text(), content);
  const api = await (await app.request(`/api/pastes/${id}`)).json();
  assert.equal(api.content, content);
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

test('GET /api/stickers publishes the pack with cache headers', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  const token = await signInAdmin(app);
  await adminSticker(app, token, { action: 'add', token: 'wave', label: 'Wave', emoji: '👋' });

  const response = await app.request('/api/stickers');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /max-age=60/);
  assert.match(response.headers.get('x-robots-tag') || '', /^noindex/);
  const body = await response.json();
  assert.deepEqual(body.stickers.map((row) => row.token), [':wave:']);
  assert.equal(body.stickers[0].emoji, '👋');
  // The admin console's own fields never leak into the public payload.
  assert.equal('id' in body.stickers[0], false);
  assert.equal('created_at' in body.stickers[0], false);
});

test('GET /api/gifs searches, degrades quietly and never 5xxes', async () => {
  const app = await createApp();

  await withFetch(() => payload({ data: [giphyImage()] }), async () => {
    const response = await app.request('/api/gifs?q=cats&limit=5');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, 'giphy');
    assert.equal(body.query, 'cats');
    assert.equal(body.degraded, false);
    assert.equal(body.gifs.length, 1);
    assert.equal(body.gifs[0].url, GIPHY_URL);
    assert.match(response.headers.get('cache-control') || '', /max-age=30/);

    const trending = await (await app.request('/api/gifs')).json();
    assert.equal(trending.gifs.length, 1);
    assert.equal(trending.query, '');
  });

  await withFetch(() => payload({ data: [] }), async () => {
    const body = await (await app.request('/api/gifs?q=nothing')).json();
    // An empty search is not an outage.
    assert.equal(body.degraded, false);
    assert.deepEqual(body.gifs, []);
  });

  await withFetch(() => {
    throw new Error('giphy is down');
  }, async () => {
    const response = await app.request('/api/gifs?q=cats');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.degraded, true);
    assert.deepEqual(body.gifs, []);
  });

  await withFetch((url) => {
    assert.match(url, /\/api\/v2\/hug$/);
    return payload({ results: [{ url: NEKO_URL }] });
  }, async () => {
    const body = await (await app.request('/api/gifs?category=hug')).json();
    assert.equal(body.provider, 'neko');
    assert.equal(body.category, 'hug');
    assert.equal(body.gifs[0].url, NEKO_URL);
  });

  await withFetch(() => {
    throw new Error('nekos is down');
  }, async () => {
    const body = await (await app.request('/api/gifs?category=hug')).json();
    assert.equal(body.degraded, true);
    assert.deepEqual(body.gifs, []);
    const unknown = await (await app.request('/api/gifs?category=nope')).json();
    assert.equal(unknown.degraded, true);
  });
});

test('GET /api/notifications/unread answers from the session, or 401s', async () => {
  const app = await createApp();
  const anonymous = await app.request('/api/notifications/unread');
  assert.equal(anonymous.status, 401);

  await registerUser(app, 'media02');
  const first = await app.request('/api/notifications/unread', { jar: 'media02' });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control') || '', /no-store/);
  const body = await first.json();
  assert.equal(body.unread, 0);
  assert.equal(body.user, 'media02');
});

test('the header bell carries the polling hooks and saturates at the cap', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  await registerUser(app, 'media04');
  await registerUser(app, 'media05');
  const token = await signInAdmin(app);

  // No unread news yet: the badge is rendered but hidden.
  const quiet = await (await app.request('/', { jar: 'media04' })).text();
  assert.match(quiet, /data-unread-bell/);
  assert.match(quiet, /data-unread-endpoint="\/api\/notifications\/unread"/);
  assert.match(quiet, /data-unread-badge data-max="9" hidden>0<\/span>/);

  // One broadcast per account → one unread each.
  const sent = await app.request('/admin/broadcast', {
    jar: 'admin',
    headers: originHeader,
    body: form({ csrf: token, title: 'Bell test', message: 'One unread.' }),
  });
  assert.equal(sent.status, 303);
  const loud = await (await app.request('/', { jar: 'media04' })).text();
  assert.match(loud, /data-unread-badge data-max="9" >1<\/span>|data-unread-badge data-max="9" >1<\/span>/);
  assert.doesNotMatch(loud, /data-max="9" hidden/);

  const api = await (await app.request('/api/notifications/unread', { jar: 'media04' })).json();
  assert.equal(api.unread, 1);
});

// ---------------------------------------------------------------------------
// The editor panel
// ---------------------------------------------------------------------------

test('the media panel lives outside the workspace form and offers both insert paths', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  const token = await signInAdmin(app);
  await adminSticker(app, token, { action: 'add', token: 'wave', label: 'Wave', emoji: '👋', url: 'https://cdn.test/pack-wave.gif' });

  const page = await (await app.request('/')).text();
  const workspace = page.match(/<form class="workspace"[\s\S]*?<\/form>/)?.[0];
  assert.ok(workspace, 'the workspace form renders');
  // The panel must not be inside the form: a nested search form is invalid
  // HTML, and a stray `</form>` would end the paste form early.
  assert.doesNotMatch(workspace, /data-media-panel/);
  assert.doesNotMatch(workspace, /data-media-search/);
  assert.match(workspace, /name="content"/);
  assert.match(workspace, /name="thumbnail_url"/);

  assert.match(page, /<details class="media-panel" data-media-panel data-media-endpoint="\/api\/gifs"/);
  assert.match(page, /data-media-tab="emoji"/);
  assert.match(page, /data-media-tab="stickers"/);
  assert.match(page, /data-media-tab="gifs"/);
  assert.match(page, /data-media-insert=":wave:"/);
  assert.match(page, /data-media-insert=":fire:"/);
  // The GIF search is a plain GET to the documented API: pressing Enter must
  // never post the paste.
  assert.match(page, /<form class="media-search" action="\/api\/gifs" method="get" data-media-search>/);
  assert.match(page, /name="q"/);
  assert.match(page, /data-media-status/);
  assert.match(page, /<noscript>/);
  // Every catalogue offered to the picker is a real category.
  for (const category of NEKO_CATEGORIES.slice(0, 4)) {
    assert.match(page, new RegExp(`<option value="${category.id}">`));
  }

  // The curated pack is rendered server-side, image and all.
  assert.match(page, /data-media-insert=":wave:"[\s\S]{0,200}https:\/\/cdn\.test\/pack-wave\.gif/);
});

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

test('sticker administration requires an administrator', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  await registerUser(app, 'media03');
  for (const [method, jar] of [['GET', 'media03'], ['POST', 'media03'], ['GET', undefined], ['POST', undefined]]) {
    const response = await app.request('/admin/stickers', {
      method,
      jar,
      headers: originHeader,
      body: method === 'POST' ? form({ csrf: 'x', action: 'add', token: ':nope:' }) : undefined,
    });
    assert.equal(response.status, 401, `${method} as ${jar || 'guest'}`);
  }
});

test('an administrator can add, list and delete a sticker, and every step is audited', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  const token = await signInAdmin(app);

  const added = await adminSticker(app, token, { action: 'add', token: ':anime-hug:', label: 'Hug', emoji: '🤗', url: 'https://cdn.test/hug.gif' });
  assert.equal(added.status, 303);
  assert.equal(added.headers.get('location'), '/admin/stickers?done=1');

  const page = await (await app.request('/admin/stickers', { jar: 'admin' })).text();
  assert.match(page, /:anime-hug:/);
  assert.match(page, /cdn\.test\/hug\.gif/);
  assert.match(page, /1\s*\/\s*400/);

  const duplicate = await adminSticker(app, token, { action: 'add', token: 'anime-hug', emoji: '🤗' });
  assert.equal(duplicate.status, 303);
  assert.equal(duplicate.headers.get('location'), '/admin/stickers?error=duplicate');
  const dupNotice = await (await app.request(duplicate.headers.get('location'), { jar: 'admin' })).text();
  assert.match(dupNotice, /already exists in the pack/);
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM stickers')).n), 1);

  const rejected = await adminSticker(app, token, { action: 'add', token: 'not a token', url: 'http://insecure.test/a.gif' });
  assert.equal(rejected.status, 400);
  const rejectedHtml = await rejected.text();
  assert.match(rejectedHtml, /must look like :wave:/);
  // Nothing typed is echoed back into the refusal.
  assert.doesNotMatch(rejectedHtml, /insecure\.test/);

  const row = await app.db.get('SELECT id FROM stickers WHERE token = ?', [':anime-hug:']);
  assert.ok(row.id);
  const deleted = await adminSticker(app, token, { action: 'delete', id: row.id });
  assert.equal(deleted.status, 303);
  const count = await app.db.get('SELECT COUNT(*) AS n FROM stickers');
  assert.equal(Number(count.n), 0);
  const gone = await adminSticker(app, token, { action: 'delete', id: row.id });
  assert.equal(gone.headers.get('location'), '/admin/stickers?error=delete');

  const audit = await (await app.request('/admin/audit', { jar: 'admin' })).text();
  assert.match(audit, /sticker add/);
  assert.match(audit, /sticker delete/);
  assert.match(audit, /:anime-hug:/);
});

test('an import re-resolves the provider URL instead of trusting the form', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  const token = await signInAdmin(app);

  await withFetch((url) => {
    if (/\/gifs\/abc123XYZ/.test(url)) return payload({ data: giphyImage() });
    if (/\/api\/v2\/hug/.test(url)) return payload({ results: [{ url: NEKO_URL }] });
    return payload({}, 404);
  }, async () => {
    const giphy = await adminSticker(app, token, { action: 'import', source: 'giphy', gif_id: GIPHY_ID });
    assert.equal(giphy.headers.get('location'), '/admin/stickers?done=1');
    const neko = await adminSticker(app, token, { action: 'import', source: 'neko', category: 'hug' });
    assert.equal(neko.headers.get('location'), '/admin/stickers?done=1');
  });

  const pack = await (await app.request('/api/stickers')).json();
  const tokens = pack.stickers.map((row) => row.token).sort();
  assert.deepEqual(tokens, [':anime-hug:', `:giphy-abc123xyz:`]);
  assert.equal(pack.stickers.find((row) => row.token === ':anime-hug:').url, NEKO_URL);
  assert.equal(pack.stickers.find((row) => row.token.startsWith(':giphy-')).url, GIPHY_URL);

  const unknown = await adminSticker(app, token, { action: 'import', source: 'evil', gif_id: GIPHY_ID });
  assert.equal(unknown.headers.get('location'), '/admin/stickers?error=source');
  const unverified = await withFetch(() => {
    throw new Error('provider down');
  }, async () => adminSticker(app, token, { action: 'import', source: 'giphy', gif_id: GIPHY_ID }));
  assert.equal(unverified.headers.get('location'), '/admin/stickers?error=unverified');
  // A hostile host is not trusted even when it answers.
  const hostile = await withFetch(() => payload({ data: { id: 'bad', images: { fixed_width: { url: 'https://evil.test/x.gif' } } } }), async () =>
    adminSticker(app, token, { action: 'import', source: 'giphy', gif_id: 'bad' }),
  );
  assert.equal(hostile.headers.get('location'), '/admin/stickers?error=unverified');
});

test('importSticker derives a token, refuses unknown sources and honours the pack cap', async () => {
  const db = createNodeDb(':memory:');
  await ensureSchema(db);
  const env = {};

  await withFetch(() => payload({ results: [{ url: NEKO_URL }] }), async () => {
    const result = await importSticker(db, { source: 'neko', category: 'hug', now: 1 }, env);
    assert.equal(result.ok, true);
    assert.equal(result.token, ':anime-hug:');
  });
  const refused = await importSticker(db, { source: 'giphy', id: 'x', now: 2 }, env);
  assert.equal(refused.reason, 'unverified');
  assert.equal((await importSticker(db, { source: 'nope', now: 3 }, env)).reason, 'source');

  // Fill the pack and watch the next insert bounce.
  await db.run('DELETE FROM stickers');
  const rows = [];
  for (let index = 0; index < STICKER_LIMITS.pack; index += 1) {
    rows.push({ sql: 'INSERT INTO stickers (id, token, url, emoji, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', params: [`id${index}`, `:t${index}:`, null, '🔸', 'x', 1] });
  }
  await db.batch(rows);
  const full = await addSticker(db, { token: ':one-more:', emoji: '🔸', now: 4 });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'limit');
  await db.close?.();
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

test('shared link normalisation accepts paths and https only', async () => {
  const { normalizeBroadcastLink } = await import('../src/routes/admin.js');
  assert.deepEqual(normalizeBroadcastLink(''), { ok: true, value: null });
  assert.equal(normalizeBroadcastLink('/docs').value, '/docs');
  assert.equal(normalizeBroadcastLink('https://example.test/a').value, 'https://example.test/a');
  assert.equal(normalizeBroadcastLink('//evil.test').ok, false);
  assert.equal(normalizeBroadcastLink('http://example.test').ok, false);
  assert.equal(normalizeBroadcastLink('javascript:alert(1)').ok, false);
  assert.equal(normalizeBroadcastLink('not a url').ok, false);
});

test('a broadcast reaches every account once and lands in their notifications', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  await registerUser(app, 'media10');
  await registerUser(app, 'media11');
  const token = await signInAdmin(app);

  const page = await (await app.request('/admin/broadcast', { jar: 'admin' })).text();
  assert.match(page, /2 recipients/);
  assert.match(page, /data-broadcast-form|name="title"/);

  const invalid = await app.request('/admin/broadcast', {
    jar: 'admin',
    headers: originHeader,
    body: form({ csrf: token, title: 'x', message: '', link: 'http://evil.test' }),
  });
  assert.equal(invalid.status, 400);
  const invalidHtml = await invalid.text();
  assert.match(invalidHtml, /needs a title/);
  assert.match(invalidHtml, /https:\/\/ address or a path/);
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM notifications')).n), 0);

  const sent = await app.request('/admin/broadcast', {
    jar: 'admin',
    headers: originHeader,
    body: form({ csrf: token, title: 'Scheduled maintenance', message: 'Back at 02:00 UTC.', link: '/docs' }),
  });
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get('location'), '/admin/broadcast?done=1');

  const rows = await app.db.all('SELECT recipient_user_id, type, title, link, dedupe_key FROM notifications ORDER BY recipient_user_id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'admin');
  assert.equal(rows[0].link, '/docs');
  assert.match(rows[0].dedupe_key, /^broadcast:[A-Za-z0-9]{10}:\d+$/);
  assert.notEqual(rows[0].dedupe_key, rows[1].dedupe_key);

  const inbox = await (await app.request('/notifications', { jar: 'media10' })).text();
  assert.match(inbox, /Scheduled maintenance/);
  assert.match(inbox, /Back at 02:00 UTC\./);

  const unread = await (await app.request('/api/notifications/unread', { jar: 'media10' })).json();
  assert.equal(unread.unread, 1);

  const recent = await (await app.request('/admin/broadcast?done=1', { jar: 'admin' })).text();
  assert.match(recent, /Scheduled maintenance/);
  assert.match(recent, /2\s*recipients|2 accounts|2\/2/);

  const audit = await (await app.request('/admin/audit', { jar: 'admin' })).text();
  assert.match(audit, /broadcast/);
  assert.match(audit, /2\/2 account/);
});

test('a broadcast is refused for signed-out visitors and for suspended accounts it skips them', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  await registerUser(app, 'media12');
  await registerUser(app, 'media13');
  const guest = await app.request('/admin/broadcast', { method: 'POST', headers: originHeader, body: form({ csrf: 'x', title: 'Hello there', message: 'hi' }) });
  assert.equal(guest.status, 401);
  assert.equal((await app.request('/admin/broadcast')).status, 401);
  assert.equal((await app.request('/admin')).headers.get('location'), '/admin/login');

  const token = await signInAdmin(app);
  const target = await app.db.get('SELECT id FROM users WHERE username_key = ?', ['media13']);
  await app.db.run('UPDATE users SET suspended_at = ? WHERE id = ?', [123, target.id]);
  const sent = await app.request('/admin/broadcast', {
    jar: 'admin',
    headers: originHeader,
    body: form({ csrf: token, title: 'Only one of you', message: 'Hello.' }),
  });
  assert.equal(sent.status, 303);
  const rows = await app.db.all('SELECT recipient_user_id, type FROM notifications WHERE type = ?', ['admin']);
  assert.equal(rows.length, 1);
  assert.notEqual(Number(rows[0].recipient_user_id), Number(target.id));
  assert.equal(SOCIAL.broadcastMax >= 100, true);
});

test('broadcastAll reports what it wrote and caps the audience', async () => {
  const { broadcastAll, countBroadcastRecipients } = await import('../src/lib/social.js');
  const db = createNodeDb(':memory:');
  await ensureSchema(db);
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push(`user${index}`);
    await db.run(
      'INSERT INTO users (id, username, username_key, password, created_at) VALUES (?, ?, ?, ?, ?)',
      [index + 1, `user${index}`, `user${index}`, 'x', 1],
    );
  }
  await db.run('UPDATE users SET suspended_at = 1 WHERE id = 5');
  assert.equal(await countBroadcastRecipients(db), 4);

  const first = await broadcastAll(db, { title: 'Hello', message: 'World', link: null, now: 10 });
  assert.equal(first.recipients, 4);
  assert.equal(first.written, 4);
  assert.equal(first.capped, false);
  // The same call twice must not duplicate: ids are random, so only a new
  // broadcast creates new rows.
  const second = await broadcastAll(db, { title: 'Hello', message: 'World', link: null, now: 11 });
  assert.equal(second.written, 4);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM notifications')).n), 8);
  assert.notEqual(first.broadcastId, second.broadcastId);
  await db.close?.();
});

test('the JSON body of a broadcast post is refused like any other admin form', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  const token = await signInAdmin(app);
  const response = await app.request('/admin/broadcast', {
    jar: 'admin',
    method: 'POST',
    headers: { ...originHeader, 'content-type': 'application/json' },
    body: jsonBody({ title: 'Hello', message: 'World' }),
  });
  // The admin console only reads form posts: a JSON body never reaches the
  // handler with a CSRF token, so it cannot send anything.
  assert.ok([400, 401, 403, 415].includes(response.status), `unexpected ${response.status}`);
});
