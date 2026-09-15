/**
 * End-to-end tests for password-protected pastes (roadmap 2.2 §1).
 *
 * The promise under test: a protected paste leaks nothing — not content, not
 * title, not the passphrase itself — through any of the four read paths (HTML
 * view, web raw, API JSON, API raw) until the passphrase has been verified, and
 * brute forcing is rate limited while owners keep full access.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, RATE_LIMITS } from '../src/config.js';
import { createApp, createApiKeyFor, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';

const PASS = 's3cret-handoff-code';
const TITLE = 'Incident postmortem draft';
const CONTENT = 'root cause: the launch code is 1234';

/** Create a protected paste through the web form and return its id. */
async function createProtected(app, extra = {}, jar) {
  const res = await app.request('/p', {
    body: form({ title: TITLE, content: CONTENT, password: PASS, expiration: 'never', ...extra }),
    jar,
  });
  assert.equal(res.status, 303, 'protected paste creation should succeed');
  return pasteIdFrom(res);
}

// ---------------------------------------------------------------------------
// Lock screen + unlock
// ---------------------------------------------------------------------------

test('a protected paste stores only a PBKDF2 hash and shows a lock screen first', async () => {
  const app = await createApp();
  const id = await createProtected(app);

  // The passphrase is never stored, and the row keeps the documented format.
  const row = await app.db.get('SELECT title, content, password_hash FROM pastes WHERE id = ?', [id]);
  assert.match(row.password_hash, /^pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(row.password_hash.split('$')[1], '100000', 'stays inside the Workers PBKDF2 ceiling');
  assert.equal(JSON.stringify(row).includes(PASS), false, 'passphrase must never reach the database');

  const locked = await app.request(`/p/${id}`);
  assert.equal(locked.status, 200);
  assert.equal(locked.headers.get('x-robots-tag'), 'noindex, nofollow');
  const html = await locked.text();
  assert.match(html, /This paste is protected/);
  assert.match(html, /name="password"/);
  assert.equal(html.includes(TITLE), false, 'the title is content too — never sent before unlock');
  assert.equal(html.includes(CONTENT), false);
  assert.equal(html.includes('launch code'), false);
  assert.equal(html.includes(PASS), false, 'the passphrase must never be echoed into HTML');
  assert.doesNotMatch(html, /<input[^>]*name="password"[^>]*value=/i, 'the passphrase field must never be pre-filled');
  assert.doesNotMatch(html, /onclick=/i);
  // Safe metadata only.
  assert.match(html, /never expires/);
  assert.match(html, /unlisted/);

  // …and an unlocked view shows the paste, without the passphrase anywhere.
  const unlock = await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), jar: 'v' });
  assert.equal(unlock.status, 303);
  assert.equal(unlock.headers.get('location'), `/p/${id}`);
  const cookies = unlock.headers.getSetCookie();
  const unlockCookie = cookies.find((c) => c.startsWith('mb_unlock='));
  assert.ok(unlockCookie, 'unlock sets a cookie');
  assert.match(unlockCookie, /HttpOnly/i);
  assert.match(unlockCookie, /SameSite=Lax/i);
  assert.match(unlockCookie, /Max-Age=1800/);
  assert.equal(decodeURIComponent(unlockCookie).includes(PASS), false, 'no passphrase in the cookie');

  const view = await app.request(`/p/${id}`, { jar: 'v' });
  const viewHtml = await view.text();
  assert.equal(view.status, 200);
  assert.match(viewHtml, new RegExp(TITLE));
  assert.match(viewHtml, /launch code is 1234/);
  assert.match(viewHtml, /password-protected/);
  assert.equal(viewHtml.includes(PASS), false);
  await app.close();
});

test('a wrong passphrase is rejected, is not remembered, and cannot be smuggled in a URL', async () => {
  const app = await createApp();
  const id = await createProtected(app);

  const wrong = await app.request(`/p/${id}/unlock`, { body: form({ password: 'not-the-passphrase' }), jar: 'v' });
  assert.equal(wrong.status, 401);
  assert.equal(app.jar('v').has('mb_unlock'), false, 'no unlock cookie for a failed attempt');
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /Wrong passphrase/);
  assert.equal(wrongHtml.includes(CONTENT), false);
  assert.match(wrongHtml, /name="robots" content="noindex, nofollow"/);

  // ?password=… in the query string is simply ignored — there is no such input.
  const smuggled = await app.request(`/p/${id}?password=${encodeURIComponent(PASS)}`);
  const smuggledHtml = await smuggled.text();
  assert.equal(smuggledHtml.includes(CONTENT), false);
  assert.match(smuggledHtml, /This paste is protected/);
  await app.close();
});

test('an unlock cookie is scoped to one paste and cannot be tampered with', async () => {
  const app = await createApp();
  const first = await createProtected(app);
  const second = await createProtected(app, { title: 'Other secret', content: 'second secret body' });

  await app.request(`/p/${first}/unlock`, { body: form({ password: PASS }), jar: 'v' });
  assert.equal((await app.request(`/p/${first}`, { jar: 'v' })).status, 200);
  // Same passphrase, different paste: the signed token does not transfer.
  const other = await app.request(`/p/${second}`, { jar: 'v' });
  assert.match(await other.text(), /This paste is protected/);

  // Flip one hex character of the signature: the paste locks again.
  const jar = app.jar('v');
  const valid = jar.get('mb_unlock');
  const flip = valid.replace(/([0-9a-f])(?=[0-9a-f]*$)/, (hex) => (hex === 'a' ? 'b' : 'a'));
  assert.notEqual(flip, valid);
  jar.set('mb_unlock', flip);
  assert.match(await (await app.request(`/p/${first}`, { jar: 'v' })).text(), /This paste is protected/);

  // The two most recent unlocks can live side by side.
  await app.request(`/p/${first}/unlock`, { body: form({ password: PASS }), jar: 'v' });
  await app.request(`/p/${second}/unlock`, { body: form({ password: PASS }), jar: 'v' });
  const both = await (await app.request(`/p/${first}`, { jar: 'v' })).text();
  assert.match(both, new RegExp(TITLE), 'unlocking a second paste must not lock you out of the first');
  await app.close();
});

// ---------------------------------------------------------------------------
// raw + API gating
// ---------------------------------------------------------------------------

test('raw and API endpoints refuse to serve a protected paste before unlock', async () => {
  const app = await createApp();
  const id = await createProtected(app);

  for (const path of [`/p/${id}/raw`, `/p/${id}/raw?download=1`, `/api/pastes/${id}/raw`]) {
    const res = await app.request(path);
    assert.equal(res.status, 401, path);
    const body = await res.text();
    assert.equal(body.includes('launch code'), false, path);
    assert.equal(body.includes(PASS), false, path);
    assert.equal(body.includes('Incident postmortem draft'), false, 'no metadata leak either');
  }
  // The web raw route explains how to unlock, in plain text for curl users.
  const raw = await app.request(`/p/${id}/raw`);
  assert.match(raw.headers.get('content-type'), /text\/plain/);
  assert.match(await raw.text(), /password-protected/);
  assert.equal(raw.headers.get('x-robots-tag'), 'noindex, nofollow');

  const api = await app.request(`/api/pastes/${id}`);
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('content-type'), 'application/json; charset=utf-8');
  const error = await api.json();
  assert.equal(typeof error.error, 'string');
  assert.equal(error.content, undefined);
  assert.equal(error.title, undefined);
  assert.equal(error.url, undefined);
  assert.equal(JSON.stringify(error).includes('Incident postmortem'), false);

  // After unlocking through the HTML form, the same cookie opens both paths.
  await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), jar: 'v' });
  assert.equal(await (await app.request(`/p/${id}/raw`, { jar: 'v' })).text(), CONTENT);
  const apiUnlocked = await app.request(`/api/pastes/${id}`, { jar: 'v' });
  assert.equal(apiUnlocked.status, 200);
  const paste = await apiUnlocked.json();
  assert.equal(paste.content, CONTENT);
  assert.equal(paste.protected, true);
  assert.equal(await (await app.request(`/api/pastes/${id}/raw`, { jar: 'v' })).text(), CONTENT);
  await app.close();
});

test('API clients can unlock a protected paste and get the content with the cookie', async () => {
  const app = await createApp();
  await registerUser(app, 'apipw1');
  const key = await createApiKeyFor(app, 'apipw1');
  const created = await app.request('/api/pastes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: jsonBody({ title: 'api secret', content: 'api secret body', password: PASS, expiresIn: 'never' }),
  });
  assert.equal(created.status, 201);
  const paste = await created.json();
  assert.equal(paste.protected, true);
  assert.equal(JSON.stringify(paste).includes(PASS), false);

  // Reads stay locked for anonymous clients — the key is never required, and
  // never silently unlocks a paste (see the owner-key test below for the
  // documented ownership bypass).
  const locked = await app.request(`/api/pastes/${paste.id}`);
  assert.equal(locked.status, 401);

  const badJson = await app.request(`/api/pastes/${paste.id}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ password: 'wrong-passphrase' }),
    jar: 'api',
  });
  assert.equal(badJson.status, 401);
  assert.equal(app.jar('api').has('mb_unlock'), false);

  const unlocked = await app.request(`/api/pastes/${paste.id}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ password: PASS }),
    jar: 'api',
  });
  assert.equal(unlocked.status, 200);
  const result = await unlocked.json();
  assert.equal(result.unlocked, true);
  assert.equal(result.id, paste.id);
  assert.ok(Date.parse(result.expiresAt) > Date.now());
  assert.equal(JSON.stringify(result).includes(PASS), false);
  assert.match(unlocked.headers.getSetCookie().find((c) => c.startsWith('mb_unlock=')), /HttpOnly/i);

  const after = await app.request(`/api/pastes/${paste.id}`, { jar: 'api' });
  assert.equal(after.status, 200);
  assert.equal((await after.json()).content, 'api secret body');

  // Unlocking a paste that has no passphrase is a client error, not a 404.
  const plain = await app.request('/api/pastes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: jsonBody({ title: 'plain', content: 'nothing secret' }),
  });
  const plainPaste = await plain.json();
  const pointless = await app.request(`/api/pastes/${plainPaste.id}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ password: PASS }),
  });
  assert.equal(pointless.status, 400);
  await app.close();
});

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

test('the owner reads, edits and deletes a protected paste without the passphrase', async () => {
  const app = await createApp();
  await registerUser(app, 'owner7');
  const id = await createProtected(app, {}, 'owner7');

  // No unlock cookie anywhere in this test: ownership is the bypass.
  const view = await app.request(`/p/${id}`, { jar: 'owner7' });
  assert.equal(view.status, 200);
  const html = await view.text();
  assert.match(html, /launch code is 1234/);
  assert.match(html, /href="\/p\/[A-Za-z0-9]+\/edit"/);
  assert.equal(html.includes(PASS), false);

  assert.equal(await (await app.request(`/p/${id}/raw`, { jar: 'owner7' })).text(), CONTENT);
  const api = await app.request(`/api/pastes/${id}`);
  assert.equal(api.status, 401, 'ownership does not leak to keyless API reads');

  // Editing keeps the protection unless the form says otherwise.
  const form2 = await app.request(`/p/${id}/edit`, { jar: 'owner7' });
  assert.equal(form2.status, 200);
  const formHtml = await form2.text();
  assert.match(formHtml, /Remove the current password/);
  assert.doesNotMatch(formHtml, /<input[^>]*name="password"[^>]*value=/i);

  const saved = await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'owner7',
    body: form({ title: 'v2', content: 'second revision', language: 'plaintext', expiration: 'never' }),
  });
  assert.equal(saved.status, 303);
  const row = await app.db.get('SELECT password_hash FROM pastes WHERE id = ?', [id]);
  assert.equal(typeof row.password_hash, 'string', 'leaving the field empty keeps the protection');

  // A signed-out visitor still needs the original passphrase.
  const outsider = await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), jar: 'v' });
  assert.equal(outsider.status, 303);
  assert.match(await (await app.request(`/p/${id}`, { jar: 'v' })).text(), /second revision/);

  const removed = await app.request(`/p/${id}/delete`, { method: 'POST', jar: 'owner7' });
  assert.equal(removed.status, 303);
  assert.equal((await app.request(`/p/${id}`)).status, 404);
  await app.close();
});

test('owners can set, replace and remove a passphrase while editing', async () => {
  const app = await createApp();
  await registerUser(app, 'edlock');
  const created = await app.request('/p', {
    body: form({ title: 'plain first', content: 'body', expiration: 'never' }),
    jar: 'edlock',
  });
  const id = pasteIdFrom(created);
  assert.equal((await app.db.get('SELECT password_hash FROM pastes WHERE id = ?', [id])).password_hash, null);

  // Add protection on edit.
  await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'edlock',
    body: form({ title: 'now protected', content: 'body', expiration: 'never', password: PASS }),
  });
  const row = await app.db.get('SELECT password_hash FROM pastes WHERE id = ?', [id]);
  assert.match(row.password_hash, /^pbkdf2-sha256\$/);
  assert.match(await (await app.request(`/p/${id}`)).text(), /This paste is protected/);

  // Replace it: the old passphrase stops working, the new one works.
  const replacement = 'a-brand-new-passphrase';
  await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'edlock',
    body: form({ title: 'now protected', content: 'body', expiration: 'never', password: replacement }),
  });
  assert.equal((await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), jar: 'old' })).status, 401);
  assert.equal(
    (await app.request(`/p/${id}/unlock`, { body: form({ password: replacement }), jar: 'new' })).status,
    303,
  );

  // A too-short passphrase is rejected and nothing about it is echoed back.
  const tooShort = await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'edlock',
    body: form({ title: 'now protected', content: 'body', expiration: 'never', password: 'abc' }),
  });
  assert.equal(tooShort.status, 400);
  const shortHtml = await tooShort.text();
  assert.match(shortHtml, /at least 6 characters/i);
  assert.doesNotMatch(shortHtml, /value="abc"/);
  assert.match(
    (await app.db.get('SELECT password_hash FROM pastes WHERE id = ?', [id])).password_hash,
    /^pbkdf2-sha256\$/,
    'a rejected edit leaves the stored hash alone',
  );

  // Remove the protection explicitly.
  await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'edlock',
    body: form({ title: 'public again', content: 'body', expiration: 'never', remove_password: '1' }),
  });
  assert.equal((await app.db.get('SELECT password_hash FROM pastes WHERE id = ?', [id])).password_hash, null);
  const publicView = await (await app.request(`/p/${id}`)).text();
  assert.match(publicView, /public again/);
  assert.doesNotMatch(publicView, /This paste is protected/);
  await app.close();
});

// ---------------------------------------------------------------------------
// Abuse, expiry, validation
// ---------------------------------------------------------------------------

test('repeated wrong passphrases are rate limited per paste and IP', async () => {
  const app = await createApp();
  const id = await createProtected(app);
  const limit = RATE_LIMITS.unlock.limit;

  for (let attempt = 0; attempt < limit; attempt++) {
    const res = await app.request(`/p/${id}/unlock`, {
      body: form({ password: `wrong-${attempt}` }),
      ip: '5.5.5.5',
      jar: 'v',
    });
    assert.equal(res.status, 401, `attempt ${attempt + 1} should be a plain rejection`);
  }

  const blocked = await app.request(`/p/${id}/unlock`, { body: form({ password: `wrong-${limit}` }), ip: '5.5.5.5' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After is set');
  assert.equal(blocked.headers.getSetCookie().some((c) => c.startsWith('mb_unlock=')), false);

  // Correct passphrase is refused too while the bucket is hot.
  const stillBlocked = await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), ip: '5.5.5.5', jar: 'v' });
  assert.equal(stillBlocked.status, 429);
  assert.equal(app.jar('v').has('mb_unlock'), false);

  // The API unlock shares the bucket…
  const apiBlocked = await app.request(`/api/pastes/${id}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ password: PASS }),
    ip: '5.5.5.5',
  });
  assert.equal(apiBlocked.status, 429);

  // …but a different IP, and the same IP on another paste, are unaffected.
  const otherIp = await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), ip: '6.6.6.6', jar: 'w' });
  assert.equal(otherIp.status, 303);
  const otherPaste = await createProtected(app);
  const otherPasteRes = await app.request(`/p/${otherPaste}/unlock`, { body: form({ password: PASS }), ip: '5.5.5.5', jar: 'x' });
  assert.equal(otherPasteRes.status, 303);
  await app.close();
});

test('an expired protected paste is gone from every entry point', async () => {
  const app = await createApp();
  const id = await createProtected(app, { expiration: '10m' });
  assert.equal((await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), jar: 'v' })).status, 303);
  assert.equal((await app.request(`/p/${id}`, { jar: 'v' })).status, 200);

  await app.db.run('UPDATE pastes SET expires_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - 5, id]);
  assert.equal((await app.request(`/p/${id}`)).status, 404);
  assert.equal((await app.request(`/p/${id}/unlock`, { method: 'POST', body: form({ password: PASS }) })).status, 404);
  assert.equal((await app.request(`/p/${id}/raw`)).status, 404);
  assert.equal((await app.request(`/api/pastes/${id}`)).status, 404);
  assert.equal((await app.request(`/api/pastes/${id}/unlock`, { method: 'POST', body: jsonBody({ password: PASS }) })).status, 404);
  assert.equal(await app.db.get('SELECT id FROM pastes WHERE id = ?', [id]), null, 'expired rows are deleted');
  await app.close();
});

test('passphrase creation rules are enforced on the web and JSON paths', async () => {
  const app = await createApp();
  // Too short (web).
  const short = await app.request('/p', { body: form({ title: 't', content: 'c', password: 'abc' }) });
  assert.equal(short.status, 400);
  const shortHtml = await short.text();
  assert.match(shortHtml, /at least 6 characters/i);
  assert.equal(shortHtml.includes('abc'), false, 'the rejected passphrase is never echoed');

  // Blank-but-not-empty (web): whitespace is not a passphrase.
  const blank = await app.request('/p', { body: form({ title: 't', content: 'c', password: '      ' }) });
  assert.equal(blank.status, 400);

  // Over-long (web).
  const long = await app.request('/p', { body: form({ title: 't', content: 'c', password: 'x'.repeat(257) }) });
  assert.equal(long.status, 400);

  // An empty field simply means "no protection".
  const plain = await app.request('/p', { body: form({ title: 'plain', content: 'c', password: '' }) });
  assert.equal(plain.status, 303);
  const plainId = pasteIdFrom(plain);
  assert.equal((await app.db.get('SELECT password_hash FROM pastes WHERE id = ?', [plainId])).password_hash, null);
  assert.equal((await app.request(`/p/${plainId}`)).status, 200);

  // API: same rules, JSON errors.
  await registerUser(app, 'apirul');
  const key = await createApiKeyFor(app, 'apirul');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const shortApi = await app.request('/api/pastes', {
    method: 'POST',
    headers,
    body: jsonBody({ title: 't', content: 'c', password: 'abc' }),
  });
  assert.equal(shortApi.status, 400);
  assert.match((await shortApi.json()).error, /at least 6 characters/i);

  const created = await app.request('/api/pastes', {
    method: 'POST',
    headers,
    body: jsonBody({ title: 'api protected', content: 'c', password: PASS }),
  });
  assert.equal(created.status, 201);
  const paste = await created.json();
  assert.equal(paste.protected, true);
  assert.equal(JSON.stringify(paste).includes(PASS), false);
  assert.equal((await app.request(`/api/pastes/${paste.id}`)).status, 401);

  // PATCH can add, keep and remove the protection.
  const patchedKeep = await app.request(`/api/pastes/${paste.id}`, {
    method: 'PATCH',
    headers,
    body: jsonBody({ title: 'renamed' }),
  });
  assert.equal(patchedKeep.status, 200);
  assert.equal((await patchedKeep.json()).protected, true, 'an unrelated PATCH keeps the lock');
  assert.equal((await app.request(`/api/pastes/${paste.id}`)).status, 401);

  const patchedClear = await app.request(`/api/pastes/${paste.id}`, {
    method: 'PATCH',
    headers,
    body: jsonBody({ password: null }),
  });
  assert.equal(patchedClear.status, 200);
  assert.equal((await patchedClear.json()).protected, false);
  assert.equal((await app.request(`/api/pastes/${paste.id}`)).status, 200);

  const patchedSet = await app.request(`/api/pastes/${paste.id}`, {
    method: 'PATCH',
    headers,
    body: jsonBody({ password: 'a-fresh-passphrase' }),
  });
  assert.equal(patchedSet.status, 200);
  assert.equal((await patchedSet.json()).protected, true);
  assert.equal((await app.request(`/api/pastes/${paste.id}`)).status, 401);
  await app.close();
});

test('unprotected pastes keep working exactly as before', async () => {
  const app = await createApp();
  const created = await app.request('/p', { body: form({ title: 'open', content: 'open body', expiration: 'never' }) });
  const id = pasteIdFrom(created);
  const view = await app.request(`/p/${id}`);
  assert.equal(view.status, 200);
  assert.equal((await view.text()).includes('open body'), true);
  assert.equal(await (await app.request(`/p/${id}/raw`)).text(), 'open body');
  const api = await app.request(`/api/pastes/${id}`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).protected, false);
  // Unlocking a paste without a passphrase is not a route to anything.
  assert.equal((await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }) })).status, 303);
  const meta = await (await app.request('/api/meta')).json();
  assert.equal(meta.limits.passphraseMin, LIMITS.passphraseMin);
  assert.equal(meta.unlock.seconds, 1800);
  assert.equal(meta.unlock.attempts, RATE_LIMITS.unlock.limit);
  await app.close();
});

test('the passphrase never appears in URLs, HTML or the location header', async () => {
  const app = await createApp();
  const created = await app.request('/p', { body: form({ title: 'no leaks', content: 'body', password: PASS }) });
  const id = pasteIdFrom(created);
  assert.equal((created.headers.get('location') || '').includes(PASS), false);
  assert.equal(created.headers.get('location'), `/p/${id}?created=1`);

  const pages = [`/p/${id}`, `/docs`, '/', '/api/meta'];
  for (const path of pages) {
    const res = await app.request(path);
    const body = await res.text();
    assert.equal(body.includes(PASS), false, `${path} must not contain a passphrase`);
  }

  // The rate-limit and view bookkeeping stores no passphrase either.
  await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), jar: 'v' });
  await app.request(`/p/${id}`, { jar: 'v' });
  const buckets = await app.db.all('SELECT bucket FROM rate_limits');
  const views = await app.db.all('SELECT paste_id, visitor FROM paste_views');
  assert.equal(JSON.stringify(buckets).includes(PASS), false);
  assert.equal(JSON.stringify(views).includes(PASS), false);
  assert.ok(buckets.some((row) => row.bucket.startsWith(`unlock:${id}:`)), 'unlock attempts are bucketed by paste + IP');
  assert.equal(JSON.stringify(buckets).includes('5.5.5.5'), false);
  await app.close();
});

test('an owner API key opens a locked paste; other keys and no key do not', async () => {
  const app = await createApp();
  await registerUser(app, 'keyown');
  await registerUser(app, 'keyoth');
  const ownerKey = await createApiKeyFor(app, 'keyown');
  const otherKey = await createApiKeyFor(app, 'keyoth');
  const created = await app.request('/api/pastes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerKey}` },
    body: jsonBody({ title: 'key-protected', content: 'key-protected body', password: PASS, expiresIn: 'never' }),
  });
  const paste = await created.json();

  // No key: locked, and no content or metadata leaks.
  const anonymous = await app.request(`/api/pastes/${paste.id}`);
  assert.equal(anonymous.status, 401);
  assert.equal(JSON.stringify(await anonymous.json()).includes('key-protected'), false);

  // Somebody else's valid key: still locked.
  const stranger = await app.request(`/api/pastes/${paste.id}`, { headers: { authorization: `Bearer ${otherKey}` } });
  assert.equal(stranger.status, 401);
  // An invalid key must not turn into a 401-with-different-meaning or a 500.
  const junk = await app.request(`/api/pastes/${paste.id}/raw`, { headers: { 'x-api-key': 'mb_nope' } });
  assert.equal(junk.status, 401);

  // The owner's key is ownership proof: full content, no passphrase needed.
  const owner = await app.request(`/api/pastes/${paste.id}`, { headers: { authorization: `Bearer ${ownerKey}` } });
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).content, 'key-protected body');
  const raw = await app.request(`/api/pastes/${paste.id}/raw`, { headers: { authorization: `Bearer ${ownerKey}` } });
  assert.equal(await raw.text(), 'key-protected body');
  await app.close();
});

test('a locked view is not counted as a view', async () => {
  const app = await createApp();
  const id = await createProtected(app);
  await app.request(`/p/${id}`, { ip: '3.3.3.3' });
  await app.request(`/p/${id}`, { ip: '3.3.3.3' });
  assert.equal((await app.db.get('SELECT views FROM pastes WHERE id = ?', [id])).views, 0, 'no view for a lock screen');

  await app.request(`/p/${id}/unlock`, { body: form({ password: PASS }), jar: 'v', ip: '3.3.3.3' });
  await app.request(`/p/${id}`, { jar: 'v', ip: '3.3.3.3' });
  assert.equal((await app.db.get('SELECT views FROM pastes WHERE id = ?', [id])).views, 1);
  await app.close();
});

test('being signed in is not a bypass — only the owner is', async () => {
  const app = await createApp();
  await registerUser(app, 'ownxyz');
  await registerUser(app, 'other9');
  const id = await createProtected(app, {}, 'ownxyz');

  const stranger = await app.request(`/p/${id}`, { jar: 'other9' });
  assert.match(await stranger.text(), /This paste is protected/);
  assert.equal((await app.request(`/p/${id}/raw`, { jar: 'other9' })).status, 401);
  assert.equal((await app.request(`/api/pastes/${id}`, { jar: 'other9' })).status, 401);
  // Ownership rules still apply on top of the lock.
  assert.equal((await app.request(`/p/${id}/edit`, { jar: 'other9' })).status, 403);
  assert.equal((await app.request(`/p/${id}/delete`, { method: 'POST', jar: 'other9' })).status, 403);
  await app.close();
});
