/**
 * End-to-end tests for the whole product: anonymous flows, accounts,
 * ownership, API, expiration, security headers, privacy and limits.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS } from '../src/config.js';
import { createApp, createApiKeyFor, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';

// ---------------------------------------------------------------------------
// Anonymous
// ---------------------------------------------------------------------------

test('homepage shows the editor immediately and no paste feed', async () => {
  const app = await createApp();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<textarea/);
  assert.match(html, /name="title"/);
  assert.match(html, /name="expiration"/);
  assert.match(html, /MantisBin/);
  assert.doesNotMatch(html, /recent pastes|public feed/i);
  // The homepage is indexable (it is the product's public content).
  assert.equal(res.headers.get('x-robots-tag'), null);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  await app.close();
});

test('create -> view -> raw round trip (anonymous)', async () => {
  const app = await createApp();
  const res = await app.request('/p', {
    body: form({ title: 'hello world', content: 'line one\nline two\nhttps://example.com/a', language: 'plaintext', expiration: '1w' }),
  });
  assert.equal(res.status, 303);
  const id = pasteIdFrom(res);
  assert.match(id, /^[A-Za-z0-9]{8}$/, 'id must be 8 base62 chars');

  const view = await app.request(`/p/${id}`);
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('x-robots-tag'), 'noindex, nofollow');
  const viewHtml = await view.text();
  assert.match(viewHtml, /hello world/);
  assert.match(viewHtml, /line one\nline two/);
  assert.match(viewHtml, /<a href="https:\/\/example.com\/a"/);
  assert.match(viewHtml, /name="robots" content="noindex, nofollow"/);

  const raw = await app.request(`/p/${id}/raw`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /text\/plain/);
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await raw.text(), 'line one\nline two\nhttps://example.com/a');
  await app.close();
});

test('title is mandatory and capped', async () => {
  const app = await createApp();
  const missing = await app.request('/p', { body: form({ content: 'x' }) });
  assert.equal(missing.status, 400);
  const long = await app.request('/p', { body: form({ title: 't'.repeat(LIMITS.titleMax + 1), content: 'x' }) });
  assert.equal(long.status, 400);
  const exact = await app.request('/p', { body: form({ title: 't'.repeat(LIMITS.titleMax), content: 'x' }) });
  assert.equal(exact.status, 303);
  await app.close();
});

test('empty content is rejected', async () => {
  const app = await createApp();
  const res = await app.request('/p', { body: form({ title: 't', content: '' }) });
  assert.equal(res.status, 400);
  await app.close();
});

test('anonymous paste size limit is 5 MB (server-side)', async () => {
  const app = await createApp();
  const over = await app.request('/p', { body: form({ title: 'big', content: 'x'.repeat(LIMITS.anonMaxBytes + 1) }) });
  assert.equal(over.status, 413);
  const under = await app.request('/p', { body: form({ title: 'big', content: 'x'.repeat(LIMITS.anonMaxBytes - 100) }) });
  assert.equal(under.status, 303);
  await app.close();
});

test('expiration: never and timed, expired pastes are deleted from the database', async () => {
  const app = await createApp();
  const never = await app.request('/p', { body: form({ title: 'forever', content: 'x', expiration: 'never' }) });
  const neverId = pasteIdFrom(never);
  let row = await app.db.get('SELECT expires_at FROM pastes WHERE id = ?', [neverId]);
  assert.equal(row.expires_at, null);

  const timed = await app.request('/p', { body: form({ title: 'brief', content: 'x', expiration: '10m' }) });
  const timedId = pasteIdFrom(timed);
  row = await app.db.get('SELECT expires_at FROM pastes WHERE id = ?', [timedId]);
  assert.ok(row.expires_at > Math.floor(Date.now() / 1000));

  // Viewable before expiry…
  assert.equal((await app.request(`/p/${timedId}`)).status, 200);
  // …then force expiry and confirm it is inaccessible AND removed.
  await app.db.run('UPDATE pastes SET expires_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - 5, timedId]);
  assert.equal((await app.request(`/p/${timedId}`)).status, 404);
  assert.equal((await app.request(`/p/${timedId}/raw`)).status, 404);
  assert.equal(await app.db.get('SELECT id FROM pastes WHERE id = ?', [timedId]), null);
  await app.close();
});

test('unknown and malformed paste ids are 404s, not errors', async () => {
  const app = await createApp();
  assert.equal((await app.request('/p/AAAAAAAA')).status, 404);
  assert.equal((await app.request('/p/nope')).status, 404);
  assert.equal((await app.request('/p/AAAAAAAA/raw')).status, 404);
  const api = await app.request('/api/pastes/AAAAAAAA');
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /application\/json/);
  const body = await api.json();
  assert.equal(typeof body.error, 'string');
  await app.close();
});

test('pasted HTML is escaped, URLs are linkified safely', async () => {
  const app = await createApp();
  const res = await app.request('/p', {
    body: form({
      title: '<img src=x onerror=alert(1)>',
      content: '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\nsee https://ok.example/p?a=1&b=2 end\njavascript:alert(3)',
    }),
  });
  const id = pasteIdFrom(res);
  const view = await app.request(`/p/${id}`);
  const html = await view.text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/ok.example\/p\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /href="javascript:/);
  // Title is escaped in the heading too.
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  await app.close();
});

test('syntax highlighting is manual and language is stored', async () => {
  const app = await createApp();
  const res = await app.request('/p', {
    body: form({ title: 'py', content: 'def main():\n    return 42  # comment', language: 'python' }),
  });
  const id = pasteIdFrom(res);
  const html = await (await app.request(`/p/${id}`)).text();
  assert.match(html, /class="t-kw">def</);
  assert.match(html, /class="t-com"># comment</);
  assert.match(html, /class="t-num">42</);
  const row = await app.db.get('SELECT language FROM pastes WHERE id = ?', [id]);
  assert.equal(row.language, 'python');

  // Unknown language falls back to plaintext rather than failing.
  const odd = await app.request('/p', { body: form({ title: 'odd', content: 'x = 1', language: 'brainfuck-9000' }) });
  const oddId = pasteIdFrom(odd);
  const oddRow = await app.db.get('SELECT language FROM pastes WHERE id = ?', [oddId]);
  assert.equal(oddRow.language, 'plaintext');
  await app.close();
});

test('font and font size choices are stored and applied', async () => {
  const app = await createApp();
  const res = await app.request('/p', {
    body: form({ title: 'styled', content: 'abc', font: 'serif', font_size: '18', expiration: 'never' }),
  });
  const id = pasteIdFrom(res);
  const html = await (await app.request(`/p/${id}`)).text();
  assert.match(html, /class="code font-serif fs-18"/);
  // Bad values fall back to defaults.
  const bad = await app.request('/p', { body: form({ title: 'bad', content: 'abc', font: 'evil', font_size: '99' }) });
  const badId = pasteIdFrom(bad);
  const badHtml = await (await app.request(`/p/${badId}`)).text();
  assert.match(badHtml, /class="code font-mono fs-14"/);
  await app.close();
});

test('large pastes skip highlighting and still render', async () => {
  const app = await createApp();
  const line = 'SELECT * FROM t; -- comment\n';
  const big = line.repeat(Math.ceil((LIMITS.highlightMaxBytes + 1024) / line.length));
  const res = await app.request('/p', { body: form({ title: 'big', content: big, language: 'sql' }) });
  const id = pasteIdFrom(res);
  const view = await app.request(`/p/${id}`);
  assert.equal(view.status, 200);
  const html = await view.text();
  assert.match(html, /Large paste/);
  assert.doesNotMatch(html, /class="t-kw"/);
  await app.close();
});

test('view counter ignores repeat refreshes but counts distinct visitors', async () => {
  const app = await createApp();
  const res = await app.request('/p', { body: form({ title: 'views', content: 'v' }) });
  const id = pasteIdFrom(res);
  await app.request(`/p/${id}`, { ip: '1.1.1.1' });
  await app.request(`/p/${id}`, { ip: '1.1.1.1' });
  await app.request(`/p/${id}`, { ip: '1.1.1.1' });
  await app.request(`/p/${id}`, { ip: '2.2.2.2' });
  const api = await app.request(`/api/pastes/${id}`);
  const data = await api.json();
  assert.equal(data.views, 2);
  await app.close();
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

test('registration validation: usernames and passwords', async () => {
  const app = await createApp();
  const bad = [
    { username: 'abc', password: 'longenough1' }, // too short
    { username: 'abcdefg', password: 'longenough1' }, // too long
    { username: 'ab_cd', password: 'longenough1' },
    { username: 'ab-cd', password: 'longenough1' },
    { username: 'ab.cd', password: 'longenough1' },
    { username: 'ab cd', password: 'longenough1' },
    { username: 'abcd', password: 'short1' }, // password too short
  ];
  for (const payload of bad) {
    const res = await app.request('/register', { body: form(payload) });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
  const ok = await registerUser(app, 'alice1');
  assert.equal(ok.status, 303);
  assert.equal((await app.request('/me', { jar: 'alice1' })).status, 200);
  // Duplicate username (case-insensitive) rejected.
  const dup = await app.request('/register', { body: form({ username: 'ALICE1', password: 'longenough1' }) });
  assert.equal(dup.status, 400);
  await app.close();
});

test('login, logout and session behaviour', async () => {
  const app = await createApp();
  await registerUser(app, 'bob123');
  const wrong = await app.request('/login', { body: form({ username: 'bob123', password: 'wrong-password' }), jar: 'anon' });
  assert.equal(wrong.status, 401);
  const ok = await app.request('/login', { body: form({ username: 'bob123', password: 'correct-horse-1' }), jar: 'bob' });
  assert.equal(ok.status, 303);
  assert.match(app.jar('bob').get('mb_session') || '', /.{16,}/);
  assert.equal((await app.request('/me', { jar: 'bob' })).status, 200);
  const out = await app.request('/logout', { method: 'POST', jar: 'bob' });
  assert.equal(out.status, 303);
  const after = await app.request('/me', { jar: 'bob' });
  assert.equal(after.status, 303); // redirected to login
  await app.close();
});

test('session cookies are HttpOnly, SameSite=Lax and hashed at rest', async () => {
  const app = await createApp();
  const res = await registerUser(app, 'carol1');
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('mb_session='));
  assert.ok(session, 'session cookie set');
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Lax/i);
  const token = /mb_session=([^;]+)/.exec(session)[1];
  const rows = await app.db.all('SELECT token_hash FROM sessions');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, decodeURIComponent(token));
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  await app.close();
});

test('ownership: only the owner can edit or delete', async () => {
  const app = await createApp();
  await registerUser(app, 'owner1');
  await registerUser(app, 'other1');
  const created = await app.request('/p', { body: form({ title: 'mine', content: 'secret stuff', expiration: 'never' }), jar: 'owner1' });
  const id = pasteIdFrom(created);

  // Anonymous: redirected to login for the edit form, 401 for the mutation.
  assert.equal((await app.request(`/p/${id}/edit`)).status, 303);
  assert.equal((await app.request(`/p/${id}/edit`, { method: 'POST', body: form({ title: 'x', content: 'y', expiration: 'never' }) })).status, 401);
  assert.equal((await app.request(`/p/${id}/delete`, { method: 'POST' })).status, 401);

  // Another account: 403 everywhere.
  assert.equal((await app.request(`/p/${id}/edit`, { jar: 'other1' })).status, 403);
  assert.equal((await app.request(`/p/${id}/edit`, { method: 'POST', jar: 'other1', body: form({ title: 'x', content: 'y', expiration: 'never' }) })).status, 403);
  assert.equal((await app.request(`/p/${id}/delete`, { method: 'POST', jar: 'other1' })).status, 403);

  // Owner can edit and delete.
  const edited = await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'owner1',
    body: form({ title: 'mine v2', content: 'updated', language: 'plaintext', expiration: 'never' }),
  });
  assert.equal(edited.status, 303);
  const html = await (await app.request(`/p/${id}`)).text();
  assert.match(html, /mine v2/);
  assert.match(html, /updated/);
  const deleted = await app.request(`/p/${id}/delete`, { method: 'POST', jar: 'owner1' });
  assert.equal(deleted.status, 303);
  assert.equal((await app.request(`/p/${id}`)).status, 404);
  await app.close();
});

test('editing re-applies validation and size limits', async () => {
  const app = await createApp();
  await registerUser(app, 'edith1');
  const created = await app.request('/p', { body: form({ title: 'small', content: 'x', expiration: 'never' }), jar: 'edith1' });
  const id = pasteIdFrom(created);
  const tooBig = await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'edith1',
    body: form({ title: 'small', content: 'x'.repeat(LIMITS.userMaxBytes + 1), expiration: 'never' }),
  });
  assert.equal(tooBig.status, 413);
  const noTitle = await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'edith1',
    body: form({ title: '', content: 'y', expiration: 'never' }),
  });
  assert.equal(noTitle.status, 400);
  await app.close();
});

test('my pastes lists only your own pastes', async () => {
  const app = await createApp();
  await registerUser(app, 'lista1');
  await registerUser(app, 'listb2');
  await app.request('/p', { body: form({ title: 'A owns', content: 'a', expiration: 'never' }), jar: 'lista1' });
  await app.request('/p', { body: form({ title: 'B owns', content: 'b', expiration: 'never' }), jar: 'listb2' });
  const mine = await (await app.request('/me', { jar: 'lista1' })).text();
  assert.match(mine, /A owns/);
  assert.doesNotMatch(mine, /B owns/);
  await app.close();
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

test('API: keys gate writes, reads are public', async () => {
  const app = await createApp();
  const noKey = await app.request('/api/pastes', { method: 'POST', body: jsonBody({ title: 't', content: 'c' }), headers: { 'content-type': 'application/json' } });
  assert.equal(noKey.status, 401);
  const badKey = await app.request('/api/pastes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer mb_notakey' },
    body: jsonBody({ title: 't', content: 'c' }),
  });
  assert.equal(badKey.status, 401);

  await registerUser(app, 'apione');
  const key = await createApiKeyFor(app, 'apione');
  assert.match(key, /^mb_[A-Za-z0-9]{32}$/);

  const created = await app.request('/api/pastes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: jsonBody({ title: 'api', content: '{"k": 1}', language: 'json', expiresIn: '1d' }),
  });
  assert.equal(created.status, 201);
  const paste = await created.json();
  assert.match(paste.id, /^[A-Za-z0-9]{8}$/);
  assert.equal(paste.content, undefined);
  assert.ok(paste.expiresAt);

  // Public read, no key.
  const got = await app.request(`/api/pastes/${paste.id}`);
  assert.equal(got.status, 200);
  const full = await got.json();
  assert.equal(full.content, '{"k": 1}');
  assert.equal(got.headers.get('x-robots-tag'), 'noindex, nofollow');

  // Raw through both URLs.
  for (const path of [`/api/pastes/${paste.id}/raw`, `/p/${paste.id}/raw`]) {
    const rawRes = await app.request(path);
    assert.equal(rawRes.status, 200);
    assert.equal(await rawRes.text(), '{"k": 1}');
  }

  // X-API-Key header also works; PATCH by owner.
  const patched = await app.request(`/api/pastes/${paste.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: jsonBody({ title: 'api v2' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).title, 'api v2');

  // Another user's key cannot touch it.
  await registerUser(app, 'apitwo');
  const key2 = await createApiKeyFor(app, 'apitwo');
  const forbidden = await app.request(`/api/pastes/${paste.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${key2}` },
  });
  assert.equal(forbidden.status, 403);

  const mine = await app.request('/api/pastes/mine', { headers: { authorization: `Bearer ${key}` } });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).pastes.length, 1);

  const removed = await app.request(`/api/pastes/${paste.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } });
  assert.equal(removed.status, 200);
  assert.equal((await app.request(`/api/pastes/${paste.id}`)).status, 404);
  await app.close();
});

test('API: oversized and invalid payloads are rejected', async () => {
  const app = await createApp();
  await registerUser(app, 'apisz1');
  const key = await createApiKeyFor(app, 'apisz1');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const big = await app.request('/api/pastes', { method: 'POST', headers, body: jsonBody({ title: 't', content: 'x'.repeat(LIMITS.userMaxBytes + 1) }) });
  assert.equal(big.status, 413);
  const noTitle = await app.request('/api/pastes', { method: 'POST', headers, body: jsonBody({ content: 'x' }) });
  assert.equal(noTitle.status, 400);
  const notJson = await app.request('/api/pastes', { method: 'POST', headers, body: 'not json' });
  assert.equal(notJson.status, 400);
  await app.close();
});

test('API meta + health are public', async () => {
  const app = await createApp();
  const meta = await app.request('/api/meta');
  assert.equal(meta.status, 200);
  const data = await meta.json();
  assert.ok(data.languages.length >= 20);
  assert.ok(data.expirations.some((e) => e.id === 'never'));
  const health = await app.request('/api/health');
  assert.equal((await health.json()).status, 'ok');
  await app.close();
});

test('rate limits: auth attempts are capped, legitimate traffic is not', async () => {
  const app = await createApp();
  let last = 200;
  for (let i = 0; i < 45; i++) {
    const res = await app.request('/login', { body: form({ username: 'nobody1', password: 'wrong-password' }), ip: '8.8.8.8' });
    last = res.status;
    if (res.status === 429) break;
  }
  assert.equal(last, 429, 'auth endpoint should rate limit brute force');
  // A different IP is unaffected.
  const other = await app.request('/login', { body: form({ username: 'nobody1', password: 'wrong-password' }), ip: '9.9.9.9' });
  assert.equal(other.status, 401);
  await app.close();
});

// ---------------------------------------------------------------------------
// Misc routes / privacy / errors
// ---------------------------------------------------------------------------

test('theme toggle sets a cookie and is reflected server-side', async () => {
  const app = await createApp();
  const res = await app.request('/theme', { method: 'POST', body: form({ theme: 'light', next: '/' }) });
  assert.equal(res.status, 303);
  assert.equal(app.jar().get('mb_theme'), 'light');
  const html = await (await app.request('/')).text();
  assert.match(html, /data-theme="light"/);
  await app.close();
});

test('unknown routes 404, wrong methods 405, errors stay friendly', async () => {
  const app = await createApp();
  const missing = await app.request('/definitely-not-a-page');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Not found/);
  const wrongMethod = await app.request('/', { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  const apiMissing = await app.request('/api/pastes');
  assert.equal(apiMissing.status, 405);
  const body = await apiMissing.json();
  assert.equal(typeof body.error, 'string');
  await app.close();
});

test('docs page documents the API', async () => {
  const app = await createApp();
  const res = await app.request('/docs');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /\/api\/pastes/);
  assert.match(html, /Authorization: Bearer/);
  await app.close();
});

test('brand assets are served', async () => {
  const app = await createApp();
  for (const path of ['/favicon.svg', '/logo.svg', '/mark.svg']) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /image\/svg/);
    const svg = await res.text();
    assert.match(svg, /<svg/);
  }
  await app.close();
});

test('API keys: at most 3, revocable, shown once', async () => {
  const app = await createApp();
  await registerUser(app, 'keymaster'.slice(0, 6));
  const jar = 'keymaster'.slice(0, 6);
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await createApiKeyFor(app, jar));
  const rows = await app.db.all('SELECT id FROM api_keys');
  assert.equal(rows.length, 3, 'key cap enforced');
  const page = await (await app.request('/me', { jar })).text();
  assert.match(page, /API keys/);
  const id = (await app.db.all('SELECT id FROM api_keys ORDER BY id LIMIT 1'))[0].id;
  const revoke = await app.request('/me/keys/revoke', { method: 'POST', jar, body: form({ id }) });
  assert.equal(revoke.status, 303);
  assert.equal((await app.db.all('SELECT id FROM api_keys')).length, 2);
  await app.close();
});
