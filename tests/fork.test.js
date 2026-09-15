/**
 * Fork / duplicate (roadmap 2.2 §3).
 *
 * The promise under test: a copy is an ordinary paste created by whoever asked
 * for it — new random id, own expiration/view count/owner, the source untouched
 * — and no read path can be used to copy content out of a paste the actor has
 * not unlocked (and never out of a failed or partial read).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, RATE_LIMITS } from '../src/config.js';
import { createApp, createApiKeyFor, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';

const BODY = 'def main():\n    return 42  # the source body';

/** Register an account and fail loudly if the username/password was rejected. */
async function account(app, username) {
  const res = await registerUser(app, username);
  assert.equal(res.status, 303, `registering ${username}`);
  return username;
}

/** Create a plain paste through the web form. */
async function createSource(app, extra = {}, jar) {
  const res = await app.request('/p', {
    body: form({ title: 'Original', content: BODY, language: 'python', expiration: '1d', ...extra }),
    jar,
  });
  assert.equal(res.status, 303);
  return pasteIdFrom(res);
}

function sourceSnapshot(app, id) {
  return app.db.get(
    'SELECT title, content, language, font, font_size, views, user_id, expires_at, password_hash, burn_mode FROM pastes WHERE id = ?',
    [id],
  );
}

// ---------------------------------------------------------------------------
// The duplicate screen
// ---------------------------------------------------------------------------

test('a paste view offers a duplicate action that opens a pre-filled editor', async () => {
  const app = await createApp();
  const id = await createSource(app, { font: 'serif', font_size: '18' });

  const view = await (await app.request(`/p/${id}`)).text();
  assert.match(view, new RegExp(`href="/p/${id}/fork"`));
  assert.match(view, /Duplicate</);
  const viewsAfterView = (await sourceSnapshot(app, id)).views;

  const res = await app.request(`/p/${id}/fork`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  const html = await res.text();

  // It is the ordinary editor, pointed at the ordinary create endpoint.
  assert.match(html, /<h1>Duplicate paste<\/h1>/);
  assert.match(html, /action="\/p" method="post"/);
  assert.match(html, /Save copy/);
  assert.match(html, new RegExp(`href="/p/${id}"`), 'a cancel link back to the source');
  assert.match(html, /The copy gets its own URL/);
  assert.doesNotMatch(html, /data-draft="new"/, 'the duplicate screen never writes into the create draft');
  assert.doesNotMatch(html, /onclick=/i);

  // Copied fields: title, content, language, font, font size.
  assert.match(html, /value="Original"/);
  assert.match(html, new RegExp(BODY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /<option value="python" selected>/);
  assert.match(html, /<option value="serif" selected>/);
  assert.match(html, /<option value="18" selected>/);
  assert.match(html, /<option value="1d" selected>/, 'the copy starts with the source’s remaining lifetime');

  // The copy starts unprotected and does not burn, whatever the source did.
  assert.doesNotMatch(html, /name="password"[^>]*value=/i);
  assert.match(html, /<option value="never" selected>/);
  assert.equal((await sourceSnapshot(app, id)).views, viewsAfterView, 'duplicating is not a view of the source');
  await app.close();
});

test('an unknown or malformed source id is a 404, not a broken form', async () => {
  const app = await createApp();
  assert.equal((await app.request('/p/AAAAAAAA/fork')).status, 404);
  assert.equal((await app.request('/p/nope/fork')).status, 404);
  assert.equal((await app.request('/p/AAAAAAAA/fork', { method: 'POST' })).status, 405);
  await app.close();
});

// ---------------------------------------------------------------------------
// Independence of copies
// ---------------------------------------------------------------------------

test('saving the duplicate creates an independent paste and leaves the source alone', async () => {
  const app = await createApp();
  const id = await createSource(app, { font: 'serif', font_size: '18' });
  const before = await sourceSnapshot(app, id);

  const saved = await app.request('/p', {
    body: form({ title: 'Original copy', content: BODY, language: 'python', font: 'serif', font_size: '18', expiration: '1d' }),
  });
  assert.equal(saved.status, 303);
  const copyId = pasteIdFrom(saved);
  assert.match(copyId, /^[A-Za-z0-9]{8}$/);
  assert.notEqual(copyId, id, 'a copy gets its own random id');

  const copy = await app.db.get('SELECT * FROM pastes WHERE id = ?', [copyId]);
  const source = await app.db.get('SELECT * FROM pastes WHERE id = ?', [id]);
  assert.equal(copy.content, source.content);
  assert.equal(copy.language, source.language);
  assert.equal(copy.font, source.font);
  assert.equal(copy.font_size, source.font_size);
  assert.equal(copy.views, 0, 'the copy has its own view count');
  assert.equal(source.views, before.views);
  assert.equal(JSON.stringify(before) === JSON.stringify(await sourceSnapshot(app, id)), true, 'the source row is untouched');

  // The two live their own lives: editing one never touches the other.
  await app.db.run('UPDATE pastes SET title = ? WHERE id = ?', ['Renamed source', id]);
  const copyHtml = await (await app.request(`/p/${copyId}`)).text();
  assert.match(copyHtml, /Original copy/);
  // …and deleting the source keeps the copy readable.
  await app.db.run('DELETE FROM pastes WHERE id = ?', [id]);
  assert.equal((await app.request(`/p/${id}`)).status, 404);
  assert.equal((await app.request(`/p/${copyId}`)).status, 200);
  await app.close();
});

// ---------------------------------------------------------------------------
// Ownership follows the actor
// ---------------------------------------------------------------------------

test('web: anonymous copies stay anonymous, signed-in copies belong to the actor', async () => {
  const app = await createApp();
  await account(app, 'forkon');
  await account(app, 'forktw');
  const source = await createSource(app, {}, 'forkon');

  // Registered user A forks.
  const forkA = await app.request('/p', {
    body: form({ title: 'copy by one', content: BODY, language: 'python', expiration: '1d' }),
    jar: 'forkon',
  });
  const copyA = pasteIdFrom(forkA);
  assert.equal((await app.db.get('SELECT user_id FROM pastes WHERE id = ?', [copyA])).user_id, 1);

  // Registered user B forks the same source: B owns the copy, not A.
  const forkB = await app.request('/p', {
    body: form({ title: 'copy by two', content: BODY, language: 'python', expiration: '1d' }),
    jar: 'forktw',
  });
  const copyB = pasteIdFrom(forkB);
  const ownerB = (await app.db.get('SELECT user_id FROM pastes WHERE id = ?', [copyB])).user_id;
  assert.notEqual(ownerB, 1);
  assert.equal((await app.request(`/p/${copyB}/edit`, { jar: 'forktw' })).status, 200, 'the copier can edit their copy');
  assert.equal((await app.request(`/p/${copyB}/edit`, { jar: 'forkon' })).status, 403);

  // Anonymous fork: no owner, and it shows up for nobody in /me.
  const anonFork = await app.request('/p', {
    body: form({ title: 'anon copy', content: BODY, language: 'python', expiration: '1d' }),
  });
  const anonCopy = pasteIdFrom(anonFork);
  assert.equal((await app.db.get('SELECT user_id FROM pastes WHERE id = ?', [anonCopy])).user_id, null);
  const meHtml = await (await app.request('/me', { jar: 'forkon' })).text();
  assert.match(meHtml, /copy by one/);
  assert.doesNotMatch(meHtml, /anon copy/);

  // The source keeps its own owner and expiry throughout.
  const sourceRow = await sourceSnapshot(app, source);
  assert.equal(sourceRow.user_id, 1);
  assert.equal(sourceRow.title, 'Original');
  await app.close();
});

test('API: a key makes the copy owned, no key makes it anonymous, fields can be overridden', async () => {
  const app = await createApp();
  await account(app, 'forkky');
  const key = await createApiKeyFor(app, 'forkky');
  const source = await createSource(app, { font: 'serif', font_size: '18' });

  // Keyless: anonymous copy, source fields copied, empty body is allowed.
  const anon = await app.request(`/api/pastes/${source}/fork`, { method: 'POST' });
  assert.equal(anon.status, 201);
  const anonCopy = await anon.json();
  assert.notEqual(anonCopy.id, source);
  assert.equal(anonCopy.title, 'Original');
  assert.equal(anonCopy.language, 'python');
  assert.equal(anonCopy.font, 'serif');
  assert.equal(anonCopy.fontSize, 18);
  assert.equal(anonCopy.views, 0);
  assert.equal(anonCopy.burnAfter, 'never');
  assert.equal((await app.db.get('SELECT user_id FROM pastes WHERE id = ?', [anonCopy.id])).user_id, null);
  assert.match(await (await app.request(`/p/${anonCopy.id}/raw`)).text(), /the source body/);

  // Keyed: owned copy with overrides.
  const keyed = await app.request(`/api/pastes/${source}/fork`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: jsonBody({ title: 'owned copy', language: 'rust', expiresIn: '1h', burnAfter: 'read', password: 'copy-passphrase' }),
  });
  assert.equal(keyed.status, 201);
  const ownedCopy = await keyed.json();
  assert.equal(ownedCopy.title, 'owned copy');
  assert.equal(ownedCopy.language, 'rust');
  assert.equal(ownedCopy.protected, true);
  assert.equal(ownedCopy.burnAfter, 'read');
  assert.equal((await app.db.get('SELECT user_id FROM pastes WHERE id = ?', [ownedCopy.id])).user_id, 1);
  assert.equal((await app.request(`/api/pastes/${ownedCopy.id}`)).status, 401, 'the copy carries its own protection');
  const mine = await (await app.request('/api/pastes/mine', { headers: { authorization: `Bearer ${key}` } })).json();
  assert.ok(mine.pastes.some((paste) => paste.id === ownedCopy.id));

  // An invalid key never silently degrades to an anonymous copy.
  const badKey = await app.request(`/api/pastes/${source}/fork`, {
    method: 'POST',
    headers: { authorization: 'Bearer mb_nope' },
  });
  assert.equal(badKey.status, 401);
  // Unknown modes and content overrides are refused, not ignored.
  const badMode = await app.request(`/api/pastes/${source}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ burnAfter: 'sometimes' }),
  });
  assert.equal(badMode.status, 400);
  const contentOverride = await app.request(`/api/pastes/${source}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ content: 'not a copy' }),
  });
  assert.equal(contentOverride.status, 400);

  // The source is still exactly one paste, unchanged.
  const sourceRow = await sourceSnapshot(app, source);
  assert.equal(sourceRow.title, 'Original');
  assert.equal(sourceRow.font_size, 18);
  assert.equal(sourceRow.password_hash, null);
  await app.close();
});

test('a copy keeps the source’s remaining lifetime but then expires on its own schedule', async () => {
  const app = await createApp();
  const source = await createSource(app, { expiration: '1d' });
  const fork = await (await app.request(`/api/pastes/${source}/fork`, { method: 'POST' })).json();

  const now = Math.floor(Date.now() / 1000);
  const remaining = Number((await sourceSnapshot(app, source)).expires_at) - now;
  const copyRemaining = Date.parse(fork.expiresAt) / 1000 - now;
  assert.ok(Math.abs(copyRemaining - remaining) < 5, `copy lives about as long as the source (${copyRemaining} vs ${remaining})`);

  // Changing the source's expiry does not move the copy's.
  await app.db.run('UPDATE pastes SET expires_at = ? WHERE id = ?', [now + 60, source]);
  const copyRow = await app.db.get('SELECT expires_at FROM pastes WHERE id = ?', [fork.id]);
  assert.ok(Number(copyRow.expires_at) > now + 3600);

  // 'never' sources produce 'never' copies.
  const forever = await createSource(app, { expiration: 'never' });
  const foreverCopy = await (await app.request(`/api/pastes/${forever}/fork`, { method: 'POST' })).json();
  assert.equal(foreverCopy.expiresAt, null);
  await app.close();
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test('duplicating cannot bypass the size limits of the actor', async () => {
  const app = await createApp();
  await account(app, 'forksz');
  const key = await createApiKeyFor(app, 'forksz');

  // A 6 MB paste can only exist with a key (10 MB), and keeps existing.
  const big = 'x'.repeat(6 * 1024 * 1024);
  const created = await app.request('/api/pastes', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: jsonBody({ title: 'big source', content: big, expiresIn: 'never' }),
  });
  assert.equal(created.status, 201);
  const source = await created.json();

  // Anonymous copy: refused with the anonymous limit, and nothing is created.
  const anon = await app.request(`/api/pastes/${source.id}/fork`, { method: 'POST' });
  assert.equal(anon.status, 413);
  assert.match((await anon.json()).error, /5\.00 MB for anonymous users/);
  const before = await app.db.get('SELECT COUNT(*) AS n FROM pastes').then((row) => row.n);

  // The same paste duplicated with the key: allowed (10 MB).
  const keyed = await app.request(`/api/pastes/${source.id}/fork`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(keyed.status, 201);
  const copy = await keyed.json();
  assert.equal((await app.db.get('SELECT size FROM pastes WHERE id = ?', [copy.id])).size, big.length);
  assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM pastes').then((row) => row.n)), before + 1);

  // The web duplicate screen shows the actor's own limit in the counter.
  const anonPage = await (await app.request(`/p/${source.id}/fork`)).text();
  assert.match(anonPage, new RegExp(`data-limit="${LIMITS.anonMaxBytes}"`));
  const keyPage = await (await app.request(`/p/${source.id}/fork`, { headers: { 'x-api-key': key } })).text();
  assert.match(keyPage, new RegExp(`data-limit="${LIMITS.anonMaxBytes}"`), 'a signed-out browser gets the anonymous limit');
  await app.close();
});

test('forking is rate limited like creating a paste', async () => {
  const app = await createApp();
  const source = await createSource(app);

  // Anonymous web forks share the create bucket (per IP).
  let blocked = null;
  for (let i = 0; i < RATE_LIMITS.create.limit + 2 && !blocked; i++) {
    const res = await app.request(`/api/pastes/${source}/fork`, { method: 'POST', ip: '9.9.9.9' });
    if (res.status === 429) blocked = res;
  }
  assert.ok(blocked, 'anonymous forking must hit the create limit');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // A different IP is unaffected…
  assert.equal((await app.request(`/api/pastes/${source}/fork`, { method: 'POST', ip: '10.10.10.10' })).status, 201);
  // …and the web path shares that same per-IP bucket.
  assert.equal((await app.request('/p', { body: form({ title: 't', content: 'c' }), ip: '9.9.9.9' })).status, 429);

  // Keyed forks use the API-key create bucket.
  await account(app, 'forklm');
  const key = await createApiKeyFor(app, 'forklm');
  const headers = { authorization: `Bearer ${key}` };
  assert.equal((await app.request(`/api/pastes/${source}/fork`, { method: 'POST', headers })).status, 201);
  const buckets = await app.db.all("SELECT bucket FROM rate_limits WHERE bucket LIKE 'apicreate:key:%'");
  assert.ok(buckets.length, 'keyed forking is counted against the API create limit');
  await app.close();
});

// ---------------------------------------------------------------------------
// Protected and one-time sources
// ---------------------------------------------------------------------------

test('a protected source must be unlocked before it can be copied', async () => {
  const app = await createApp();
  const source = await createSource(app, { password: 'handoff-code-123' });

  // Web: the unlock screen, with the fork page as the post-unlock destination.
  const locked = await app.request(`/p/${source}/fork`);
  assert.equal(locked.status, 200);
  const lockedHtml = await locked.text();
  assert.equal(lockedHtml.includes('the source body'), false, 'no content before unlock');
  assert.match(lockedHtml, /This paste is protected/);
  assert.match(lockedHtml, new RegExp(`name="next" value="/p/${source}/fork"`));

  // API: a flat 401 and no copy.
  assert.equal((await app.request(`/api/pastes/${source}/fork`, { method: 'POST' })).status, 401);
  assert.equal(await app.db.get('SELECT COUNT(*) AS n FROM pastes').then((row) => row.n), 1, 'no partial copy is created');

  // A wrong passphrase keeps it locked; the source stays readable for real readers.
  const wrong = await app.request(`/p/${source}/unlock`, {
    body: form({ password: 'wrong-passphrase', next: `/p/${source}/fork` }),
    jar: 'v',
  });
  assert.equal(wrong.status, 401);
  assert.equal((await app.request(`/p/${source}/fork`, { jar: 'v' })).status, 200);
  assert.equal((await (await app.request(`/p/${source}/fork`, { jar: 'v' })).text()).includes('This paste is protected'), true);

  // The right passphrase opens the duplicate screen, and the copy is not protected.
  const unlock = await app.request(`/p/${source}/unlock`, {
    body: form({ password: 'handoff-code-123', next: `/p/${source}/fork` }),
    jar: 'v',
  });
  assert.equal(unlock.status, 303);
  assert.equal(unlock.headers.get('location'), `/p/${source}/fork`);
  const forkHtml = await (await app.request(`/p/${source}/fork`, { jar: 'v' })).text();
  assert.match(forkHtml, /the source body/);
  assert.match(forkHtml, /Passwords are never copied/);

  const copy = await app.request('/p', {
    body: form({ title: 'unprotected copy', content: BODY, language: 'python', expiration: '1d' }),
  });
  const copyId = pasteIdFrom(copy);
  assert.equal((await app.db.get('SELECT password_hash FROM pastes WHERE id = ?', [copyId])).password_hash, null);
  assert.equal((await app.request(`/p/${copyId}`)).status, 200, 'the copy is an ordinary paste');

  // The source keeps its protection and is still locked for strangers.
  const sourceRow = await sourceSnapshot(app, source);
  assert.match(String(sourceRow.password_hash), /^pbkdf2-sha256\$/);
  assert.match(await (await app.request(`/p/${source}`)).text(), /This paste is protected/);
  await app.close();
});

test('owners copy their own protected pastes without the passphrase', async () => {
  const app = await createApp();
  await account(app, 'forkow');
  const source = await createSource(app, { password: 'handoff-code-123' }, 'forkow');

  // Session ownership: the duplicate screen opens straight away.
  const page = await app.request(`/p/${source}/fork`, { jar: 'forkow' });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /the source body/);

  // API-key ownership: the copy is owned and complete.
  const key = await createApiKeyFor(app, 'forkow');
  const forced = await app.request(`/api/pastes/${source}/fork`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(forced.status, 201);
  const copy = await forced.json();
  assert.equal((await app.db.get('SELECT user_id FROM pastes WHERE id = ?', [copy.id])).user_id, 1);
  await app.close();
});

test('one-time pastes are consumed by copying, and a consumed paste cannot be copied again', async () => {
  const app = await createApp();

  // view mode: the duplicate screen is a content read, so it consumes the source.
  const oneTime = await createSource(app, { burn_after: 'view' });
  const page = await app.request(`/p/${oneTime}/fork`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /burns after the first view/);
  assert.match(html, /has now been consumed/);
  assert.equal(await app.db.get('SELECT id FROM pastes WHERE id = ?', [oneTime]), null);
  const again = await app.request(`/p/${oneTime}/fork`);
  assert.equal(again.status, 404);
  assert.equal((await again.text()).includes('the source body'), false);

  // read mode via the API.
  const apiOneTime = await createSource(app, { burn_after: 'read' });
  const first = await app.request(`/api/pastes/${apiOneTime}/fork`, { method: 'POST' });
  assert.equal(first.status, 201);
  assert.equal(await app.db.get('SELECT id FROM pastes WHERE id = ?', [apiOneTime]), null);
  const second = await app.request(`/api/pastes/${apiOneTime}/fork`, { method: 'POST' });
  assert.equal(second.status, 404);
  assert.equal((await second.json()).content, undefined);
  await app.close();
});
