/**
 * Burn-after-reading (roadmap 2.2 §2).
 *
 * The promise under test: a one-time paste is handed to exactly one successful
 * read — HTML view, /raw or API, depending on the mode — and nothing else can
 * consume it. Wrong passphrases, 401s, lock screens, 404s and rate-limited
 * requests must leave the paste untouched, and two concurrent readers must
 * never both receive it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BURN_MODES, DEFAULT_BURN_MODE, RATE_LIMITS } from '../src/config.js';
import { claimBurn, normalizeBurnMode, shouldBurn } from '../src/lib/burn.js';
import { runMaintenance } from '../src/lib/maintenance.js';
import { getPaste } from '../src/lib/pastes.js';
import { validateBurnMode } from '../src/lib/validate.js';
import { createApp, createApiKeyFor, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';

const SECRET = 'burn-body-marker';

/** Create a paste with a burn mode through the web form. */
async function createBurn(app, burnAfter, extra = {}) {
  const res = await app.request('/p', {
    body: form({ title: 'one time', content: SECRET, burn_after: burnAfter, expiration: 'never', ...extra }),
  });
  assert.equal(res.status, 303, `creating a ${burnAfter} paste should succeed`);
  return pasteIdFrom(res);
}

async function rowExists(app, id) {
  return Boolean(await app.db.get('SELECT id FROM pastes WHERE id = ?', [id]));
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

test('burn modes: whitelist, defaults and the read matrix', () => {
  // Creation accepts the three documented ids, case-insensitively.
  assert.equal(validateBurnMode('never').value, 'never');
  assert.equal(validateBurnMode('view').value, 'view');
  assert.equal(validateBurnMode('READ').value, 'read');
  // Missing/blank means the default, an unknown mode is a hard error.
  assert.equal(validateBurnMode('').value, DEFAULT_BURN_MODE);
  assert.equal(validateBurnMode(undefined).value, DEFAULT_BURN_MODE);
  assert.equal(validateBurnMode(null).value, DEFAULT_BURN_MODE);
  assert.equal(validateBurnMode('burn-it').ok, false);
  assert.equal(validateBurnMode(42).ok, false);
  assert.equal(normalizeBurnMode('read'), 'read');
  assert.equal(normalizeBurnMode('nonsense'), 'never');
  assert.equal(BURN_MODES.length, 3);

  // never: nothing burns. view: only an HTML view. read: any content read.
  assert.equal(shouldBurn({ burn_mode: 'never' }, 'view'), false);
  assert.equal(shouldBurn({ burn_mode: 'never' }, 'read'), false);
  assert.equal(shouldBurn({ burn_mode: 'view' }, 'view'), true);
  assert.equal(shouldBurn({ burn_mode: 'view' }, 'read'), false);
  assert.equal(shouldBurn({ burn_mode: 'read' }, 'view'), true);
  assert.equal(shouldBurn({ burn_mode: 'read' }, 'read'), true);
  assert.equal(shouldBurn({}, 'view'), false, 'a row without the column never burns');
});

// ---------------------------------------------------------------------------
// Burn after the first view
// ---------------------------------------------------------------------------

test('burn after the first view: content once, then gone from every endpoint', async () => {
  const app = await createApp();
  const id = await createBurn(app, 'view');
  assert.equal((await app.db.get('SELECT burn_mode FROM pastes WHERE id = ?', [id])).burn_mode, 'view');

  // The creator form advertises the mode, and the paste view shows it.
  const home = await (await app.request('/')).text();
  assert.match(home, /name="burn_after"/);
  assert.match(home, /Burn after the first view/);
  assert.match(home, /deleted for everyone/);

  const first = await app.request(`/p/${id}`, { ip: '1.1.1.1' });
  assert.equal(first.status, 200);
  const html = await first.text();
  assert.match(html, new RegExp(SECRET));
  assert.match(html, /burns after the first view/, 'the metadata shows the burn mode without hiding content');

  // The row is gone the moment the paste is served.
  assert.equal(await rowExists(app, id), false, 'the paste is deleted as it is served');
  assert.equal(await app.db.get('SELECT COUNT(*) AS n FROM paste_views WHERE paste_id = ?', [id]).then((r) => r.n), 0);

  // Every later read is a plain 404.
  for (const path of [`/p/${id}`, `/p/${id}/raw`, `/api/pastes/${id}`, `/api/pastes/${id}/raw`]) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
    const body = await res.text();
    assert.equal(body.includes(SECRET), false, path);
  }
  await app.close();
});

test('concurrent readers: exactly one gets the paste, the rest get 404', async () => {
  const app = await createApp();
  const id = await createBurn(app, 'view');
  const responses = await Promise.all([1, 2, 3, 4, 5].map(() => app.request(`/p/${id}`)));
  const statuses = responses.map((res) => res.status);
  const bodies = await Promise.all(responses.map((res) => res.text()));

  assert.equal(statuses.filter((status) => status === 200).length, 1, `exactly one 200 (got ${statuses})`);
  assert.equal(statuses.filter((status) => status === 404).length, 4, `the rest are 404 (got ${statuses})`);
  assert.equal(bodies.filter((body) => body.includes(SECRET)).length, 1, 'the content is handed out once');
  assert.equal(await rowExists(app, id), false);
  await app.close();
});

test('burn after the first view survives raw and API reads — only a view consumes it', async () => {
  const app = await createApp();
  const id = await createBurn(app, 'view');

  assert.equal(await (await app.request(`/p/${id}/raw`)).text(), SECRET);
  assert.equal((await app.db.get('SELECT burned FROM pastes WHERE id = ?', [id])).burned, 0);
  const api = await app.request(`/api/pastes/${id}`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).content, SECRET);
  assert.equal(await (await app.request(`/api/pastes/${id}/raw`)).text(), SECRET);
  assert.equal(await rowExists(app, id), true, 'a raw/API read never burns a view-mode paste');

  assert.equal((await app.request(`/p/${id}`)).status, 200);
  assert.equal(await rowExists(app, id), false);
  await app.close();
});

// ---------------------------------------------------------------------------
// Burn after the first read
// ---------------------------------------------------------------------------

test('burn after the first read: each of the four read paths consumes the paste', async () => {
  const app = await createApp();
  const paths = [`/p/:id`, `/p/:id/raw`, `/api/pastes/:id`, `/api/pastes/:id/raw`];

  for (const pattern of paths) {
    const id = await createBurn(app, 'read', { title: `read via ${pattern}` });
    const path = pattern.replace(':id', id);
    const res = await app.request(path);
    assert.equal(res.status, 200, `${path} should serve once`);
    const body = await res.text();
    assert.equal(body.includes(SECRET), true, path);
    assert.equal(await rowExists(app, id), false, `${path} should consume the paste`);
    assert.equal((await app.request(path)).status, 404, `${path} second time`);
  }
  await app.close();
});

test('API clients can create and manage one-time pastes', async () => {
  const app = await createApp();
  await registerUser(app, 'brnapi');
  const key = await createApiKeyFor(app, 'brnapi');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };

  // The vocabulary is public, so clients can discover the modes.
  const meta = await (await app.request('/api/meta')).json();
  assert.deepEqual(meta.burnModes.map((mode) => mode.id), ['never', 'view', 'read']);
  assert.equal(meta.defaultBurnMode, 'never');

  const created = await app.request('/api/pastes', {
    method: 'POST',
    headers,
    body: jsonBody({ title: 'api one time', content: SECRET, burnAfter: 'read', expiresIn: 'never' }),
  });
  assert.equal(created.status, 201);
  const paste = await created.json();
  assert.equal(paste.burnAfter, 'read');
  // The creator's own key is ownership, so a locked paste is not the only thing
  // at stake: reading it consumes it even for the owner.
  assert.equal((await app.request(`/api/pastes/${paste.id}`, { headers })).status, 200);
  assert.equal((await app.request(`/api/pastes/${paste.id}`, { headers })).status, 404);

  // Unknown mode: refused, never silently downgraded to a permanent paste.
  const bad = await app.request('/api/pastes', {
    method: 'POST',
    headers,
    body: jsonBody({ title: 't', content: 'c', burnAfter: 'sometimes' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Unknown burn mode/);

  // PATCH: absent keeps the mode, a value replaces it, null returns to 'never'.
  const keep = await app.request('/api/pastes', {
    method: 'POST',
    headers,
    body: jsonBody({ title: 'patch target', content: SECRET, burnAfter: 'view', expiresIn: 'never' }),
  });
  const target = await keep.json();
  const patched = await app.request(`/api/pastes/${target.id}`, {
    method: 'PATCH',
    headers,
    body: jsonBody({ title: 'renamed' }),
  });
  assert.equal((await patched.json()).burnAfter, 'view', 'an unrelated PATCH keeps the one-time setting');

  const cleared = await app.request(`/api/pastes/${target.id}`, {
    method: 'PATCH',
    headers,
    body: jsonBody({ burnAfter: null }),
  });
  assert.equal((await cleared.json()).burnAfter, 'never');
  assert.equal((await app.request(`/p/${target.id}/raw`)).status, 200);
  assert.equal(await rowExists(app, target.id), true, 'a cleared paste no longer burns');

  const upgraded = await app.request(`/api/pastes/${target.id}`, {
    method: 'PATCH',
    headers,
    body: jsonBody({ burnAfter: 'read' }),
  });
  assert.equal((await upgraded.json()).burnAfter, 'read');
  assert.equal(await (await app.request(`/p/${target.id}/raw`)).text(), SECRET);
  assert.equal(await rowExists(app, target.id), false);
  await app.close();
});

// ---------------------------------------------------------------------------
// Nothing else burns a paste
// ---------------------------------------------------------------------------

test('a wrong passphrase, a lock screen and a 401 never burn a protected one-time paste', async () => {
  const app = await createApp();
  const id = await createBurn(app, 'read', { password: 'handoff-code-123' });

  // Lock screen: safe metadata only, and the paste is untouched.
  const locked = await app.request(`/p/${id}`);
  assert.equal(locked.status, 200);
  const lockedHtml = await locked.text();
  assert.equal(lockedHtml.includes(SECRET), false);
  assert.equal(lockedHtml.includes('one time'), false, 'no title before unlock');
  assert.match(lockedHtml, /burns after the first read/);
  assert.equal(await rowExists(app, id), true);

  // 401s from raw and the API, plus two wrong passphrases.
  assert.equal((await app.request(`/p/${id}/raw`)).status, 401);
  assert.equal((await app.request(`/api/pastes/${id}`)).status, 401);
  assert.equal((await app.request(`/api/pastes/${id}/raw`)).status, 401);
  const wrongForm = await app.request(`/p/${id}/unlock`, { body: form({ password: 'wrong-code-here' }), ip: '4.4.4.4' });
  assert.equal(wrongForm.status, 401, '/p/:id/unlock');
  const wrongJson = await app.request(`/api/pastes/${id}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ password: 'wrong-code-here' }),
    ip: '4.4.4.4',
  });
  assert.equal(wrongJson.status, 401, '/api/pastes/:id/unlock');
  assert.equal(await rowExists(app, id), true, 'failures never consume a one-time paste');

  // A successful unlock alone does not burn it either: the read does.
  const unlock = await app.request(`/p/${id}/unlock`, { body: form({ password: 'handoff-code-123' }), jar: 'v' });
  assert.equal(unlock.status, 303);
  assert.equal(await rowExists(app, id), true, 'unlocking is not reading');
  // The API still refuses without that cookie — and that 401 does not burn it.
  assert.equal((await app.request(`/api/pastes/${id}`)).status, 401);
  assert.equal(await rowExists(app, id), true);

  const view = await app.request(`/p/${id}`, { jar: 'v' });
  assert.equal(view.status, 200);
  assert.match(await view.text(), new RegExp(SECRET));
  assert.equal(await rowExists(app, id), false);

  // The unlock cookie is worthless once the paste is gone.
  assert.equal((await app.request(`/p/${id}`, { jar: 'v' })).status, 404);
  assert.equal((await app.request(`/p/${id}/raw`, { jar: 'v' })).status, 404);
  await app.close();
});

test('rate-limited unlock attempts do not burn the paste', async () => {
  const app = await createApp();
  const id = await createBurn(app, 'view', { password: 'handoff-code-123' });

  for (let attempt = 0; attempt <= RATE_LIMITS.unlock.limit; attempt++) {
    await app.request(`/p/${id}/unlock`, { body: form({ password: 'nope-nope-nope' }), ip: '7.7.7.7' });
  }
  const blocked = await app.request(`/p/${id}/unlock`, { body: form({ password: 'handoff-code-123' }), ip: '7.7.7.7' });
  assert.equal(blocked.status, 429);
  assert.equal(await rowExists(app, id), true, 'a 429 must not consume the paste');

  // Another IP can still unlock and read it exactly once.
  assert.equal(
    (await app.request(`/p/${id}/unlock`, { body: form({ password: 'handoff-code-123' }), ip: '8.8.8.8', jar: 'ok' })).status,
    303,
  );
  assert.equal((await app.request(`/p/${id}`, { jar: 'ok' })).status, 200);
  assert.equal(await rowExists(app, id), false);
  await app.close();
});

test('missing and expired pastes never burn anything else', async () => {
  const app = await createApp();
  const id = await createBurn(app, 'view', { expiration: '10m' });

  // Unknown ids are just 404s.
  assert.equal((await app.request('/p/AAAAAAAA')).status, 404);
  assert.equal((await app.request('/p/AAAAAAAA/raw')).status, 404);
  assert.equal((await app.request('/p/short')).status, 404);
  assert.equal(await rowExists(app, id), true);

  // An expired one-time paste is removed by expiry, not handed out once.
  await app.db.run('UPDATE pastes SET expires_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - 5, id]);
  const expired = await app.request(`/p/${id}`);
  assert.equal(expired.status, 404);
  assert.equal(await rowExists(app, id), false, 'expired rows are deleted by the expiration sweep');
  await app.close();
});

test('the owner reading their own one-time paste consumes it too', async () => {
  const app = await createApp();
  await registerUser(app, 'brnown');
  const id = await createBurn(app, 'view', { password: 'handoff-code-123' });
  // Re-create as the owner so the paste belongs to the account.
  const owned = await app.request('/p', {
    body: form({ title: 'owned one time', content: SECRET, burn_after: 'view', expiration: 'never' }),
    jar: 'brnown',
  });
  const ownedId = pasteIdFrom(owned);

  const view = await app.request(`/p/${ownedId}`, { jar: 'brnown' });
  assert.equal(view.status, 200);
  assert.match(await view.text(), new RegExp(SECRET));
  assert.equal(await rowExists(app, ownedId), false, 'a one-time paste is one-time for its owner as well');
  assert.equal((await app.request(`/p/${ownedId}`, { jar: 'brnown' })).status, 404);

  // A protected paste created by the account behaves the same way.
  const protectedOwned = await app.request('/p', {
    body: form({ title: 'owned protected', content: SECRET, burn_after: 'read', password: 'handoff-code-123' }),
    jar: 'brnown',
  });
  const protectedId = pasteIdFrom(protectedOwned);
  assert.equal((await app.request(`/p/${protectedId}/edit`, { jar: 'brnown' })).status, 200, 'owned and editable before it burns');
  assert.equal((await app.request(`/p/${protectedId}/raw`, { jar: 'brnown' })).status, 200);
  assert.equal(await rowExists(app, protectedId), false);
  assert.equal(id === protectedId, false);
  await app.close();
});

// ---------------------------------------------------------------------------
// Storage, edits and maintenance
// ---------------------------------------------------------------------------

test('burn modes survive edits and can be changed or cleared', async () => {
  const app = await createApp();
  await registerUser(app, 'brnedt');
  const created = await app.request('/p', {
    body: form({ title: 'editable', content: SECRET, burn_after: 'view', expiration: 'never' }),
    jar: 'brnedt',
  });
  const id = pasteIdFrom(created);

  // The edit form pre-selects the current mode, so an unrelated save keeps it.
  const editForm = await (await app.request(`/p/${id}/edit`, { jar: 'brnedt' })).text();
  assert.match(editForm, /<option value="view" selected>/);
  await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'brnedt',
    body: form({ title: 'edited', content: SECRET, expiration: 'never', burn_after: 'view' }),
  });
  assert.equal((await app.db.get('SELECT burn_mode FROM pastes WHERE id = ?', [id])).burn_mode, 'view');

  // Clearing the mode makes it a normal paste again.
  await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'brnedt',
    body: form({ title: 'edited', content: SECRET, expiration: 'never', burn_after: 'never' }),
  });
  assert.equal((await app.db.get('SELECT burn_mode FROM pastes WHERE id = ?', [id])).burn_mode, 'never');
  assert.equal((await app.request(`/p/${id}`)).status, 200);
  assert.equal(await rowExists(app, id), true, 'a paste without a burn mode is never consumed by reading');

  // A tampered mode is refused rather than silently stored.
  const tampered = await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'brnedt',
    body: form({ title: 'edited', content: SECRET, expiration: 'never', burn_after: 'sometimes' }),
  });
  assert.equal(tampered.status, 400);
  assert.equal((await app.db.get('SELECT burn_mode FROM pastes WHERE id = ?', [id])).burn_mode, 'never');
  await app.close();
});

test('the claim is exactly-once at the database level', async () => {
  const app = await createApp();
  const id = await createBurn(app, 'read');

  const [first, second, third] = await Promise.all([claimBurn(app.db, id), claimBurn(app.db, id), claimBurn(app.db, id)]);
  assert.deepEqual([first, second, third].filter(Boolean).length, 1, 'only the first claim wins');
  // A paste without a burn mode can never be claimed.
  const plain = await createBurn(app, 'never');
  assert.equal(await claimBurn(app.db, plain), false);
  await app.close();
});

test('a consumed paste is unreadable even before it is deleted, and maintenance sweeps it', async () => {
  const app = await createApp();
  const id = await createBurn(app, 'view');

  // Simulate a worker dying between the claim and the delete.
  assert.equal(await claimBurn(app.db, id), true);
  assert.equal(await app.db.get('SELECT id FROM pastes WHERE id = ?', [id]) !== null, true);

  // Reads already treat it as gone, and clean it up opportunistically.
  assert.equal(await getPaste(app.db, id, { content: true }), null);
  assert.equal(await rowExists(app, id), false);

  // The hourly maintenance run sweeps anything a crashed request left behind.
  const stranded = await createBurn(app, 'read');
  assert.equal(await claimBurn(app.db, stranded), true);
  await app.db.run('INSERT INTO paste_views (paste_id, visitor, created_at) VALUES (?, ?, ?)', [stranded, 'ghost', 1]);
  const summary = await runMaintenance(app.db);
  assert.equal(summary.burned, 1);
  assert.equal(await rowExists(app, stranded), false);
  assert.equal(
    await app.db.get('SELECT COUNT(*) AS n FROM paste_views WHERE paste_id = ?', [stranded]).then((row) => row.n),
    0,
    'the view log goes with it',
  );
  await app.close();
});
