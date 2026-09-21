/**
 * Optional paste thumbnails (2.4).
 *
 * The properties that matter, in order of how much damage getting them wrong
 * would do:
 *
 *   1. Any https image URL may be stored and embedded (uploads land on catbox,
 *      links may point anywhere), but only https — never data: bytes or
 *      plaintext http. A thumbnail is an off-site image, so the editor warns
 *      that it can log the IP of everyone who opens a paste.
 *   2. A thumbnail is *public*: it survives on a password-protected paste's lock
 *      screen on purpose, and every surface says so — but the content, title and
 *      passphrase still never leak.
 *   3. The database stores a URL, never bytes.
 *   4. Everything is optional and additive: pastes without one are unchanged.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, createApiKeyFor, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';
import {
  allowedThumbnailHosts,
  hasThumbnail,
  safeThumbnailUrl,
  uploadFilename,
  uploadProvider,
  uploadsEnabled,
  validateThumbnailUrl,
  validateUpload,
} from '../src/lib/thumbnail.js';
import { contentSecurityPolicy } from '../src/lib/http.js';
import { THUMBNAIL } from '../src/config.js';

const CATBOX = 'https://files.catbox.moe/ab12cd.jpg';
// An image on some other host: hand-typed links may point anywhere on https.
const OTHER_HOST = 'https://cdn.example.com/thumbnail/xyz789.webp';

/**
 * POST one small JPEG to the upload endpoint through the app's real router.
 * @param {any} app
 */
async function uploadImage(app) {
  const body = new FormData();
  body.append('image', new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), 'a.jpg');
  const request = new Request('https://mantisbin.test/p/thumbnail', { method: 'POST', body });
  return app.request('/p/thumbnail', {
    method: 'POST',
    body: new Uint8Array(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type') },
  });
}

// ---------------------------------------------------------------------------
// URL validation (any https host)
// ---------------------------------------------------------------------------

test('any https URL is accepted, but only https', () => {
  for (const url of [
    CATBOX,
    OTHER_HOST,
    'https://i.imgur.com/a.png',
    'https://cdn.files.catbox.moe/a.png',
    'https://anything.example.org/pic.jpg',
  ]) {
    assert.equal(validateThumbnailUrl(url, {}).ok, true, url);
  }
  for (const url of [
    'http://files.catbox.moe/a.jpg', // plaintext: mixed content + IP leak
    'https://user:pw@files.catbox.moe/a.jpg', // credentials
    'data:image/png;base64,iVBORw0KGgo=', // bytes, which we promised not to store
    'javascript:alert(1)',
    '/relative.jpg',
    'files.catbox.moe/a.jpg',
  ]) {
    assert.equal(validateThumbnailUrl(url, {}).ok, false, url);
  }
});

test('an empty value is a valid "no thumbnail", and over-long URLs are refused', () => {
  for (const value of ['', '   ', null, undefined]) {
    const result = validateThumbnailUrl(value, {});
    assert.equal(result.ok, true);
    assert.equal(result.value, '');
  }
  const long = `https://files.catbox.moe/${'a'.repeat(THUMBNAIL.maxUrlLength)}.jpg`;
  assert.equal(validateThumbnailUrl(long, {}).ok, false);
});

test('operators can name extra default img-src hosts without code changes', () => {
  const env = { THUMBNAIL_HOSTS: 'img.example.com, cdn.example.org' };
  assert.ok(allowedThumbnailHosts(env).includes('img.example.com'));
  assert.ok(allowedThumbnailHosts(env).includes('cdn.example.org'));
  // catbox is always listed by default.
  assert.ok(allowedThumbnailHosts({}).includes('files.catbox.moe'));
});

test('safeThumbnailUrl re-validates stored rows, keeping any https URL', () => {
  assert.equal(safeThumbnailUrl('https://img.example.com/a.jpg', {}), 'https://img.example.com/a.jpg');
  assert.equal(safeThumbnailUrl(CATBOX, {}), CATBOX);
  // A stored http/data value is still rejected on read (defence in depth).
  assert.equal(safeThumbnailUrl('http://img.example.com/a.jpg', {}), null);
  assert.equal(safeThumbnailUrl(null, {}), null);
  assert.equal(hasThumbnail({ thumbnail_url: CATBOX }), true);
  assert.equal(hasThumbnail({ thumbnail_url: null }), false);
});

// ---------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------

test('img-src allows https images (any host) while everything else stays locked down', () => {
  const policy = contentSecurityPolicy({ THUMBNAIL_HOSTS: 'img.example.com' });
  const imgSrc = policy.split('; ').find((directive) => directive.startsWith('img-src'));
  assert.match(imgSrc, /'self'/);
  // Any https image is allowed, since a hand-typed thumbnail may point anywhere.
  assert.match(imgSrc, /\bhttps:(?!\/\/)/, 'img-src must permit https: images generally');
  // Default hosts are still listed (harmless, documents the upload target).
  assert.match(imgSrc, /https:\/\/files\.catbox\.moe/);
  // Everything else stays locked down.
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /script-src [^;]*https:(?!\/\/)/, 'only img-src is widened');
  assert.match(policy, /frame-ancestors 'none'/);
});

test('a page served by the app carries the https img-src', async () => {
  const app = await createApp();
  try {
    const res = await app.request('/');
    const policy = res.headers.get('content-security-policy');
    assert.match(policy, /img-src [^;]*\bhttps:(?!\/\/)/);
    assert.match(policy, /img-src [^;]*https:\/\/files\.catbox\.moe/);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Web create / view / edit
// ---------------------------------------------------------------------------

test('a paste keeps only the URL, and renders it as an image and a link preview', async () => {
  const app = await createApp();
  try {
    const created = await app.request('/p', {
      body: form({ title: 'shot.txt', content: 'with a picture', thumbnail_url: CATBOX }),
    });
    const id = pasteIdFrom(created);
    const page = await (await app.request(`/p/${id}`)).text();
    assert.match(page, new RegExp(`<img class="thumbnail-image" src="${CATBOX.replace(/[.]/g, '\\.')}"`));
    assert.match(page, /<meta property="og:image" content="https:\/\/files\.catbox\.moe\/ab12cd\.jpg">/);
    assert.match(page, /twitter:card" content="summary_large_image"/);
    assert.match(page, /hosted publicly, visible to anyone with the link/);

    // The database holds a URL — never image bytes.
    const row = await app.db.get('SELECT thumbnail_url, content FROM pastes WHERE id = ?', [id]);
    assert.equal(row.thumbnail_url, CATBOX);
    assert.doesNotMatch(String(row.thumbnail_url), /^data:/);
  } finally {
    await app.close();
  }
});

test('a paste without a thumbnail is completely unchanged', async () => {
  const app = await createApp();
  try {
    const created = await app.request('/p', { body: form({ title: 'plain.txt', content: 'no picture' }) });
    const id = pasteIdFrom(created);
    const page = await (await app.request(`/p/${id}`)).text();
    assert.doesNotMatch(page, /thumbnail-image/);
    assert.doesNotMatch(page, /og:image/);
    const row = await app.db.get('SELECT thumbnail_url FROM pastes WHERE id = ?', [id]);
    assert.equal(row.thumbnail_url, null);
  } finally {
    await app.close();
  }
});

test('an image URL on any https host is accepted and stored', async () => {
  const app = await createApp();
  try {
    const res = await app.request('/p', {
      body: form({ title: 'ok.txt', content: 'keep this text', thumbnail_url: OTHER_HOST }),
    });
    const id = pasteIdFrom(res);
    assert.equal((await app.db.get('SELECT thumbnail_url FROM pastes WHERE id = ?', [id])).thumbnail_url, OTHER_HOST);
  } finally {
    await app.close();
  }
});

test('a non-https thumbnail is rejected with a helpful error and the paste is not created', async () => {
  const app = await createApp();
  try {
    const res = await app.request('/p', {
      body: form({ title: 'bad.txt', content: 'keep this text', thumbnail_url: 'http://tracker.example.com/pixel.gif' }),
    });
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.match(page, /must start with https/i);
    // The editor keeps the reader's work, including the URL they typed.
    assert.match(page, /keep this text/);
    assert.match(page, /value="http:\/\/tracker\.example\.com\/pixel\.gif"/);
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM pastes')).n), 0);
  } finally {
    await app.close();
  }
});

test('the editor states that a thumbnail is public, and works without JavaScript', async () => {
  const app = await createApp();
  try {
    const page = await (await app.request('/')).text();
    const workspace = page.match(/<form class="workspace"[\s\S]*?<\/form>/)?.[0];
    assert.ok(workspace);
    // A plain URL input inside the ordinary form: no JS needed to set one.
    assert.match(workspace, /name="thumbnail_url"/);
    assert.match(workspace, /<label[^>]+for="thumbnail_url"/);
    assert.match(workspace, /Anyone with the link can see the thumbnail/);
    assert.match(workspace, /password-protected or one-time paste/);
    // Still exactly one submit button — the upload control is a label + input.
    assert.equal((workspace.match(/type="submit"/g) || []).length, 1);
    assert.match(workspace, /data-thumbnail-input/);
  } finally {
    await app.close();
  }
});

test('owners can add, replace and remove a thumbnail by editing', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'edit1');
    const created = await app.request('/p', { body: form({ title: 'a.txt', content: 'body' }), jar: 'edit1' });
    const id = pasteIdFrom(created);

    const add = await app.request(`/p/${id}/edit`, {
      body: form({ title: 'a.txt', content: 'body', thumbnail_url: CATBOX }),
      jar: 'edit1',
    });
    assert.equal(add.status, 303);
    assert.equal((await app.db.get('SELECT thumbnail_url FROM pastes WHERE id = ?', [id])).thumbnail_url, CATBOX);

    // An empty field on edit means "keep", not "clear".
    await app.request(`/p/${id}/edit`, { body: form({ title: 'a.txt', content: 'body v2' }), jar: 'edit1' });
    assert.equal((await app.db.get('SELECT thumbnail_url FROM pastes WHERE id = ?', [id])).thumbnail_url, CATBOX);

    // Replacing.
    await app.request(`/p/${id}/edit`, {
      body: form({ title: 'a.txt', content: 'body v3', thumbnail_url: OTHER_HOST }),
      jar: 'edit1',
    });
    assert.equal((await app.db.get('SELECT thumbnail_url FROM pastes WHERE id = ?', [id])).thumbnail_url, OTHER_HOST);

    // The edit form offers the explicit removal checkbox once one is set.
    const formPage = await (await app.request(`/p/${id}/edit`, { jar: 'edit1' })).text();
    assert.match(formPage, /name="remove_thumbnail"/);

    const removed = await app.request(`/p/${id}/edit`, {
      body: form({ title: 'a.txt', content: 'body v4', remove_thumbnail: '1' }),
      jar: 'edit1',
    });
    assert.equal(removed.status, 303);
    assert.equal((await app.db.get('SELECT thumbnail_url FROM pastes WHERE id = ?', [id])).thumbnail_url, null);
  } finally {
    await app.close();
  }
});

test('a validation error elsewhere never silently drops a pending removal', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'edit2');
    const created = await app.request('/p', {
      body: form({ title: 'a.txt', content: 'body', thumbnail_url: CATBOX }),
      jar: 'edit2',
    });
    const id = pasteIdFrom(created);

    // Ask to remove the thumbnail *and* submit an invalid title in one go.
    const res = await app.request(`/p/${id}/edit`, {
      body: form({ title: '', content: 'body', remove_thumbnail: '1' }),
      jar: 'edit2',
    });
    assert.equal(res.status, 400);
    const page = await res.text();
    // The checkbox comes back checked, so re-submitting still removes it …
    assert.match(page, /name="remove_thumbnail" value="1"[^>]*checked/);
    // … and the old URL is not quietly re-filled into the field.
    assert.doesNotMatch(page, new RegExp(`name="thumbnail_url" type="url" value="${CATBOX.replace(/[.]/g, '\\.')}"`));
    // Nothing was written: the failed submit left the paste alone.
    assert.equal((await app.db.get('SELECT thumbnail_url FROM pastes WHERE id = ?', [id])).thumbnail_url, CATBOX);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// The public-thumbnail contract
// ---------------------------------------------------------------------------

test('a protected paste shows its thumbnail while locked, but never title or content', async () => {
  const app = await createApp();
  try {
    const created = await app.request('/p', {
      body: form({
        title: 'secret-plans.txt',
        content: 'the actual secret',
        password: 'open-sesame',
        thumbnail_url: CATBOX,
      }),
    });
    const id = pasteIdFrom(created);

    const locked = await app.request(`/p/${id}`, { jar: 'stranger' });
    assert.equal(locked.status, 200);
    const page = await locked.text();
    // Public by construction, and labelled as such.
    assert.match(page, /thumbnail-image/);
    assert.match(page, /not part of the protected content/);
    // The gate still holds for everything that is content.
    assert.doesNotMatch(page, /secret-plans\.txt/);
    assert.doesNotMatch(page, /the actual secret/);
    assert.doesNotMatch(page, /open-sesame/);
    assert.match(page, /Password-protected paste/);
  } finally {
    await app.close();
  }
});

test('a locked paste leaks nothing extra through the API', async () => {
  const app = await createApp();
  try {
    const created = await app.request('/p', {
      body: form({ title: 'locked.txt', content: 'hidden', password: 'passphrase-1', thumbnail_url: CATBOX }),
    });
    const id = pasteIdFrom(created);
    const res = await app.request(`/api/pastes/${id}`, { jar: 'stranger' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.thumbnailUrl, undefined, 'no paste object at all while locked');
    assert.equal(body.title, undefined);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

test('the API creates, reports, updates and clears a thumbnail', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'api1');
    const key = await createApiKeyFor(app, 'api1');
    const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    const created = await app.request('/api/pastes', {
      headers: auth,
      body: jsonBody({ title: 'via-api.txt', content: 'hello', thumbnailUrl: CATBOX }),
    });
    assert.equal(created.status, 201);
    const paste = await created.json();
    assert.equal(paste.thumbnailUrl, CATBOX);

    const fetched = await (await app.request(`/api/pastes/${paste.id}`)).json();
    assert.equal(fetched.thumbnailUrl, CATBOX);

    // Absent field keeps it.
    await app.request(`/api/pastes/${paste.id}`, { method: 'PATCH', headers: auth, body: jsonBody({ title: 'renamed.txt' }) });
    assert.equal((await (await app.request(`/api/pastes/${paste.id}`)).json()).thumbnailUrl, CATBOX);

    // Explicit null removes it.
    const cleared = await app.request(`/api/pastes/${paste.id}`, {
      method: 'PATCH',
      headers: auth,
      body: jsonBody({ thumbnailUrl: null }),
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).thumbnailUrl, null);

    // A non-https URL is a 400, not a silent drop.
    const bad = await app.request(`/api/pastes/${paste.id}`, {
      method: 'PATCH',
      headers: auth,
      body: jsonBody({ thumbnailUrl: 'http://evil.example.com/x.png' }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /must start with https/i);
  } finally {
    await app.close();
  }
});

test('forking reuses the public image, and an override wins', async () => {
  const app = await createApp();
  try {
    const created = await app.request('/p', {
      body: form({ title: 'src.txt', content: 'copy me', thumbnail_url: CATBOX }),
    });
    const id = pasteIdFrom(created);

    const copy = await (await app.request(`/api/pastes/${id}/fork`, {
      headers: { 'content-type': 'application/json' },
      body: jsonBody({}),
    })).json();
    assert.equal(copy.thumbnailUrl, CATBOX, 'a copy points at the same public image');
    assert.notEqual(copy.id, id);
    // The source is untouched.
    assert.equal((await app.db.get('SELECT thumbnail_url FROM pastes WHERE id = ?', [id])).thumbnail_url, CATBOX);

    const overridden = await (await app.request(`/api/pastes/${id}/fork`, {
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ thumbnailUrl: null }),
    })).json();
    assert.equal(overridden.thumbnailUrl, null);

    // The duplicate screen pre-fills the same URL.
    const forkPage = await (await app.request(`/p/${id}/fork`)).text();
    assert.match(forkPage, new RegExp(`name="thumbnail_url" type="url" value="${CATBOX.replace(/[.]/g, '\\.')}"`));
  } finally {
    await app.close();
  }
});

test('/api/meta documents the thumbnail contract', async () => {
  const app = await createApp();
  try {
    const meta = await (await app.request('/api/meta')).json();
    assert.equal(meta.thumbnail.width, 1200);
    assert.equal(meta.thumbnail.height, 630);
    assert.equal(meta.thumbnail.public, true);
    assert.ok(meta.thumbnail.allowedHosts.includes('files.catbox.moe'));
    assert.ok(meta.thumbnail.types.includes('image/jpeg'));
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

test('listings show a small thumb and a badge', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'list1');
    await app.request('/p', {
      body: form({ title: 'shown.txt', content: 'x', thumbnail_url: CATBOX, visibility: 'public' }),
      jar: 'list1',
    });
    const mine = await (await app.request('/me', { jar: 'list1' })).text();
    assert.match(mine, /class="list-thumb"/);
    assert.match(mine, /<span class="badge">thumbnail<\/span>/);

    const profile = await (await app.request('/u/list1')).text();
    assert.match(profile, /class="list-thumb"/);
    assert.match(profile, new RegExp(CATBOX.replace(/[.]/g, '\\.')));
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Upload endpoint
// ---------------------------------------------------------------------------

test('uploads are validated before a single byte leaves the Worker', () => {
  assert.equal(validateUpload({ type: 'image/jpeg', size: 1000 }).ok, true);
  assert.equal(validateUpload({ type: 'image/jpeg; charset=binary', size: 1000 }).ok, true);
  assert.equal(validateUpload({ type: 'image/svg+xml', size: 1000 }).ok, false, 'SVG can carry script');
  assert.equal(validateUpload({ type: 'application/pdf', size: 1000 }).ok, false);
  assert.equal(validateUpload({ type: 'image/jpeg', size: 0 }).ok, false);
  assert.equal(validateUpload({ type: 'image/jpeg', size: THUMBNAIL.maxBytes + 1 }).ok, false);
  assert.equal(validateUpload(null).ok, false);
  assert.equal(uploadFilename('image/png'), 'thumbnail.png');
  assert.equal(uploadFilename('image/jpeg'), 'thumbnail.jpg');
});

test('uploads go to catbox by default and can be switched off', () => {
  assert.equal(uploadProvider({}), 'catbox');
  assert.equal(uploadProvider({ CATBOX_USERHASH: 'abc' }), 'catbox');
  assert.equal(uploadsEnabled({}), true);
  assert.equal(uploadProvider({ THUMBNAIL_UPLOADS: 'off' }), null);
  assert.equal(uploadsEnabled({ THUMBNAIL_UPLOADS: 'off' }), false);
});

test('the upload route refuses non-multipart bodies and reports when it is disabled', async () => {
  const off = await createApp({ env: { THUMBNAIL_UPLOADS: 'off' } });
  try {
    const res = await off.request('/p/thumbnail', { method: 'POST', body: 'x=1' });
    assert.equal(res.status, 501);
    assert.match((await res.json()).error, /not configured/);
    // …and the editor then offers only the URL field.
    const page = await (await off.request('/')).text();
    assert.doesNotMatch(page, /data-thumbnail-input/);
    assert.match(page, /name="thumbnail_url"/);
  } finally {
    await off.close();
  }

  const on = await createApp();
  try {
    const res = await on.request('/p/thumbnail', { method: 'POST', body: 'x=1' });
    assert.equal(res.status, 415);
    assert.match((await res.json()).error, /multipart\/form-data/);
  } finally {
    await on.close();
  }
});

test('an upload with no image field is a 400, and oversized ones are refused early', async () => {
  const app = await createApp();
  try {
    const body = new FormData();
    body.append('notanimage', 'hello');
    const request = new Request('https://mantisbin.test/p/thumbnail', { method: 'POST', body });
    const empty = await app.request('/p/thumbnail', {
      method: 'POST',
      body: new Uint8Array(await request.arrayBuffer()),
      headers: { 'content-type': request.headers.get('content-type') },
    });
    assert.equal(empty.status, 400);

    const huge = await app.request('/p/thumbnail', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(THUMBNAIL.maxBytes * 4) },
      body: 'ignored',
    });
    assert.equal(huge.status, 413);
  } finally {
    await app.close();
  }
});

test('a non-URL upload response from the host never becomes a stored URL', async () => {
  const app = await createApp();
  const realFetch = globalThis.fetch;
  // Catbox answers 200 with a plain sentence when it refuses; that must never be
  // mistaken for a link and stored.
  globalThis.fetch = async () => new Response('not-a-url', { status: 200 });
  try {
    const body = new FormData();
    body.append('image', new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), 'a.jpg');
    const request = new Request('https://mantisbin.test/p/thumbnail', { method: 'POST', body });
    const res = await app.request('/p/thumbnail', {
      method: 'POST',
      body: new Uint8Array(await request.arrayBuffer()),
      headers: { 'content-type': request.headers.get('content-type') },
    });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /refused the upload/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('a successful upload returns the host URL and nothing is stored server-side', async () => {
  const app = await createApp();
  const realFetch = globalThis.fetch;
  /** @type {any[]} */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, redirect: init?.redirect });
    return new Response(CATBOX, { status: 200 });
  };
  try {
    const body = new FormData();
    body.append('image', new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), 'a.jpg');
    const request = new Request('https://mantisbin.test/p/thumbnail', { method: 'POST', body });
    const res = await app.request('/p/thumbnail', {
      method: 'POST',
      body: new Uint8Array(await request.arrayBuffer()),
      headers: { 'content-type': request.headers.get('content-type') },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { url: CATBOX });
    assert.equal(calls.length, 1, 'exactly one outbound request, never retried');
    assert.match(calls[0].url, /catbox\.moe/);
    assert.equal(calls[0].redirect, 'error', 'a redirect could smuggle in another origin');
    assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM pastes')).n), 0, 'uploading creates no paste');
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('uploads POST to catbox and forward the configured userhash', async () => {
  const app = await createApp({ env: { CATBOX_USERHASH: 'my-userhash' } });
  const realFetch = globalThis.fetch;
  /** @type {any} */
  let seen = null;
  globalThis.fetch = async (url, init) => {
    // Read the multipart body so we can assert the userhash was included.
    const bodyText = await new Response(init?.body).text().catch(() => '');
    seen = { url: String(url), method: init?.method, bodyText };
    return new Response(CATBOX, { status: 200 });
  };
  try {
    const body = new FormData();
    body.append('image', new Blob([new Uint8Array(64)], { type: 'image/png' }), 'a.png');
    const request = new Request('https://mantisbin.test/p/thumbnail', { method: 'POST', body });
    const res = await app.request('/p/thumbnail', {
      method: 'POST',
      body: new Uint8Array(await request.arrayBuffer()),
      headers: { 'content-type': request.headers.get('content-type') },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { url: CATBOX });
    assert.equal(seen.url, 'https://catbox.moe/user/api.php');
    assert.equal(seen.method, 'POST');
    assert.match(seen.bodyText, /reqtype/);
    assert.match(seen.bodyText, /my-userhash/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('an image host that is down is a 502, never a 500 crash', async () => {
  const app = await createApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const body = new FormData();
    body.append('image', new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), 'a.jpg');
    const request = new Request('https://mantisbin.test/p/thumbnail', { method: 'POST', body });
    const res = await app.request('/p/thumbnail', {
      method: 'POST',
      body: new Uint8Array(await request.arrayBuffer()),
      headers: { 'content-type': request.headers.get('content-type') },
    });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /could not be reached/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('a refused upload surfaces the host reason instead of a generic error', async () => {
  const app = await createApp();
  const realFetch = globalThis.fetch;
  // Catbox answers `200 OK` with an error sentence when it refuses an upload —
  // for example when it filters traffic from datacenter IPs, which is what
  // Workers egress from. That sentence is the diagnosis; swallowing it into
  // "could not be reached" sends everyone chasing the wrong outage.
  globalThis.fetch = async () => new Response('Invalid Uploader', { status: 200 });
  try {
    const res = await uploadImage(app);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /refused the upload/);
    assert.match(body.error, /Invalid Uploader/);
    assert.match(body.error, /paste an image URL instead/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('an HTML block page from the host is never echoed back to the reader', async () => {
  const app = await createApp();
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args);
  };
  globalThis.fetch = async () => new Response('<html><body>Access denied: datacenter IP</body></html>', { status: 403 });
  try {
    const res = await uploadImage(app);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /HTTP 403/);
    assert.doesNotMatch(body.error, /html/i);
    assert.doesNotMatch(body.error, /datacenter/);
    // …and the markup stays out of the operator log too.
    assert.doesNotMatch(JSON.stringify(warnings), /<html>/);
    assert.match(JSON.stringify(warnings), /catbox responded 403/);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    await app.close();
  }
});

test('upstream rate limiting passes through as a 429 with Retry-After', async () => {
  const app = await createApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('Too many requests', { status: 429, headers: { 'retry-after': '45' } });
  try {
    const res = await uploadImage(app);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '45');
    assert.match((await res.json()).error, /rate-limiting/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }

  // Without an upstream hint the route still answers 429 with a sane default.
  const app2 = await createApp();
  globalThis.fetch = async () => new Response('Too many requests', { status: 429 });
  try {
    const res = await uploadImage(app2);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
  } finally {
    globalThis.fetch = realFetch;
    await app2.close();
  }
});

test('an upstream "too large" passes through as a 413', async () => {
  const app = await createApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('File too large', { status: 413 });
  try {
    const res = await uploadImage(app);
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /too large/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('uploads identify themselves to the image host', async () => {
  const realFetch = globalThis.fetch;
  try {
    const catboxApp = await createApp();
    /** @type {any} */
    let catboxHeaders = null;
    globalThis.fetch = async (url, init) => {
      catboxHeaders = init?.headers;
      return new Response(CATBOX, { status: 200 });
    };
    try {
      assert.equal((await uploadImage(catboxApp)).status, 201);
      assert.match(String(catboxHeaders?.['User-Agent'] || ''), /MantisBin/);
    } finally {
      await catboxApp.close();
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/meta names the live upload provider', async () => {
  const plain = await createApp();
  try {
    const meta = await (await plain.request('/api/meta')).json();
    assert.equal(meta.thumbnail.provider, 'catbox');
    assert.equal(meta.thumbnail.uploads, true);
  } finally {
    await plain.close();
  }
  const off = await createApp({ env: { THUMBNAIL_UPLOADS: 'off' } });
  try {
    const meta = await (await off.request('/api/meta')).json();
    assert.equal(meta.thumbnail.provider, null);
    assert.equal(meta.thumbnail.uploads, false);
  } finally {
    await off.close();
  }
});

test('thumbnail uploads are rate limited per client', async () => {
  const app = await createApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(CATBOX, { status: 200 });
  try {
    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const body = new FormData();
      body.append('image', new Blob([new Uint8Array(16)], { type: 'image/jpeg' }), 'a.jpg');
      const request = new Request('https://mantisbin.test/p/thumbnail', { method: 'POST', body });
      const res = await app.request('/p/thumbnail', {
        method: 'POST',
        body: new Uint8Array(await request.arrayBuffer()),
        headers: { 'content-type': request.headers.get('content-type') },
        ip: '203.0.113.7',
      });
      if (res.status === 429) {
        limited++;
        assert.ok(Number(res.headers.get('retry-after')) > 0);
      }
    }
    assert.ok(limited > 0, 'the bucket must close before 25 uploads');
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('pastes created before the feature keep working and report no thumbnail', async () => {
  const app = await createApp();
  try {
    // A row written by older code: the column exists but was never populated.
    await app.db.run(
      'INSERT INTO pastes (id, title, content, language, font, font_size, size, views, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['oldPast1', 'legacy.txt', 'still here', 'plaintext', 'mono', 14, 10, 0, 1, 1],
    );
    const page = await (await app.request('/p/oldPast1')).text();
    assert.match(page, /still here/);
    assert.doesNotMatch(page, /thumbnail-image/);
    assert.equal((await (await app.request('/api/pastes/oldPast1')).json()).thumbnailUrl, null);
  } finally {
    await app.close();
  }
});
