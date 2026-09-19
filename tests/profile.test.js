import test from 'node:test';
import assert from 'node:assert/strict';

import { avatarPattern, avatarSvg } from '../src/lib/avatar.js';
import { createApiKeyFor, createApp, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';

test('avatars are deterministic, distinct per user and carry no user text', () => {
  assert.equal(avatarSvg('ambr'), avatarSvg('AMBR'));
  assert.notEqual(avatarSvg('ambr'), avatarSvg('brxc'));
  const svg = avatarSvg('ambr');
  assert.ok(svg.startsWith('<svg '));
  assert.ok(!svg.includes('ambr'));
  const { cells } = avatarPattern('ambr');
  assert.equal(cells.length, 15);
  assert.ok(cells.some(Boolean) && cells.some((cell) => !cell));
});

test('members publish to their profile; anonymous pastes stay unlisted', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'profu');
    const pub = await app.request('/p', {
      jar: 'profu',
      body: form({ title: 'hello.rs', content: 'fn main() {}', language: 'auto', visibility: 'public', expiration: '1w' }),
    });
    assert.equal(pub.status, 303);
    const pubId = pasteIdFrom(pub);
    const priv = await app.request('/p', {
      jar: 'profu',
      body: form({ title: 'secret.txt', content: 'shh', language: 'plaintext', visibility: 'unlisted', expiration: '1w' }),
    });
    assert.equal(priv.status, 303);

    const stored = await app.db.get('SELECT language, visibility FROM pastes WHERE id = ?', [pubId]);
    assert.equal(stored.language, 'rust');
    assert.equal(stored.visibility, 'public');

    const profile = await app.request('/u/profu');
    assert.equal(profile.status, 200);
    const html = await profile.text();
    assert.match(html, /hello\.rs/);
    assert.doesNotMatch(html, /secret\.txt/);
    assert.match(html, /avatar\.svg/);
    assert.doesNotMatch(html, /noindex/);

    // Anonymous pastes cannot be public, even when forged.
    const forged = await app.request('/p', {
      body: form({ title: 'anon.txt', content: 'x', language: 'plaintext', visibility: 'public', expiration: '1w' }),
    });
    assert.equal(forged.status, 400);
    assert.match(await forged.text(), /need an account/);

    // Unknown or malformed usernames 404.
    assert.equal((await app.request('/u/zzzq9')).status, 404);
    assert.equal((await app.request('/u/!!!')).status, 404);
    assert.equal((await app.request('/u/zzzq9/avatar.svg')).status, 404);

    // The avatar is a long-lived public image.
    const image = await app.request('/u/profu/avatar.svg');
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(image.headers.get('cache-control'), /immutable/);
  } finally {
    await app.close();
  }
});

test('unpublishing removes a paste from the profile immediately', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'editu');
    const created = await app.request('/p', {
      jar: 'editu',
      body: form({ title: 'notes.md', content: '# hi', language: 'auto', visibility: 'public', expiration: '1w' }),
    });
    const id = pasteIdFrom(created);
    assert.match(await (await app.request('/u/editu')).text(), /notes\.md/);

    const saved = await app.request(`/p/${id}/edit`, {
      jar: 'editu',
      body: form({ title: 'notes.md', content: '# hi', language: 'markdown', visibility: 'unlisted', expiration: '1w' }),
    });
    assert.equal(saved.status, 303);
    assert.doesNotMatch(await (await app.request('/u/editu')).text(), /notes\.md/);
  } finally {
    await app.close();
  }
});

test('API: visibility on create/update/fork, plus the profile JSON endpoint', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'apiu1');
    const key = await createApiKeyFor(app, 'apiu1');
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    const created = await app.request('/api/pastes', {
      method: 'POST',
      headers,
      body: jsonBody({ title: 'lib.go', content: 'package lib', language: 'auto', visibility: 'public' }),
    });
    assert.equal(created.status, 201);
    const data = await created.json();
    assert.equal(data.visibility, 'public');
    assert.equal(data.language, 'go');

    const meta = await (await app.request('/api/meta')).json();
    assert.deepEqual(
      meta.visibilities.map((v) => v.id),
      ['unlisted', 'public'],
    );

    const mine = await app.request('/api/pastes/mine', { headers });
    assert.equal((await mine.json()).pastes[0].visibility, 'public');

    const profile = await app.request('/api/users/apiu1');
    assert.equal(profile.status, 200);
    const profileJson = await profile.json();
    assert.equal(profileJson.username, 'apiu1');
    assert.equal(profileJson.pastes.length, 1);
    assert.equal(profileJson.pastes[0].title, 'lib.go');
    assert.equal(profileJson.pastes[0].content, undefined);
    assert.equal((await app.request('/api/users/zzzq9')).status, 404);

    // Anonymous forks cannot publish; signed-in forks start unlisted.
    const anonFork = await app.request(`/api/pastes/${data.id}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ visibility: 'public' }),
    });
    assert.equal(anonFork.status, 400);
    const ownedFork = await app.request(`/api/pastes/${data.id}/fork`, {
      method: 'POST',
      headers,
      body: jsonBody({}),
    });
    assert.equal((await ownedFork.json()).visibility, 'unlisted');

    const updated = await app.request(`/api/pastes/${data.id}`, {
      method: 'PATCH',
      headers,
      body: jsonBody({ visibility: 'unlisted' }),
    });
    assert.equal((await updated.json()).visibility, 'unlisted');
    const kept = await app.request(`/api/pastes/${data.id}`, { method: 'PATCH', headers, body: jsonBody({}) });
    assert.equal((await kept.json()).visibility, 'unlisted');
  } finally {
    await app.close();
  }
});

test('settings: password change revokes other sessions', async () => {
  const app = await createApp();
  try {
    assert.equal((await app.request('/me/settings')).status, 303);

    await registerUser(app, 'setu1', 'old-password-1');
    await app.request('/login', { body: form({ username: 'setu1', password: 'old-password-1' }), jar: 'second' });
    let settings = await (await app.request('/me/settings', { jar: 'setu1' })).text();
    assert.match(settings, /setu1/);
    assert.match(settings, /Change password/);
    assert.match(settings, /Sessions/);
    assert.match(settings, /Delete account/);
    assert.match(settings, /\/u\/setu1/);
    assert.equal((settings.match(/Session #/g) || []).length, 2);

    const wrong = await app.request('/me/password', {
      jar: 'setu1',
      body: form({ current_password: 'nope-nope-nope', new_password: 'new-password-1' }),
    });
    assert.equal(wrong.status, 400);

    const changed = await app.request('/me/password', {
      jar: 'setu1',
      body: form({ current_password: 'old-password-1', new_password: 'new-password-1' }),
    });
    assert.equal(changed.status, 303);
    // This session survives; the other one is dead.
    assert.equal((await app.request('/me', { jar: 'setu1' })).status, 200);
    assert.equal((await app.request('/me', { jar: 'second' })).status, 303);
    // The old password is dead everywhere.
    assert.equal(
      (await app.request('/login', { body: form({ username: 'setu1', password: 'old-password-1' }), jar: 'third' })).status,
      401,
    );
    assert.equal(
      (await app.request('/login', { body: form({ username: 'setu1', password: 'new-password-1' }), jar: 'third' })).status,
      303,
    );
  } finally {
    await app.close();
  }
});

test('settings: sessions can be revoked one by one', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'sess1');
    await app.request('/login', { body: form({ username: 'sess1', password: 'correct-horse-1' }), jar: 'other' });
    const settings = await (await app.request('/me/settings', { jar: 'sess1' })).text();
    const ids = [...settings.matchAll(/name="id" value="(\d+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, 2);
    // Newest first: the first id belongs to the `other` jar.
    const revoked = await app.request('/me/sessions/revoke', { jar: 'sess1', body: form({ id: ids[0] }) });
    assert.equal(revoked.status, 303);
    assert.equal((await app.request('/me', { jar: 'other' })).status, 303);
    assert.equal((await app.request('/me', { jar: 'sess1' })).status, 200);
  } finally {
    await app.close();
  }
});

test('delete account keeps pastes online but anonymised and unlisted', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'delu1', 'delete-me-12');
    const key = await createApiKeyFor(app, 'delu1');
    const created = await app.request('/p', {
      jar: 'delu1',
      body: form({ title: 'keepme.txt', content: 'still here', language: 'plaintext', visibility: 'public', expiration: 'never' }),
    });
    const id = pasteIdFrom(created);
    assert.match(await (await app.request('/u/delu1')).text(), /keepme\.txt/);

    const wrong = await app.request('/me/delete', { jar: 'delu1', body: form({ password: 'wrong-password' }) });
    assert.equal(wrong.status, 400);
    assert.equal((await app.request('/u/delu1')).status, 200);

    const gone = await app.request('/me/delete', { jar: 'delu1', body: form({ password: 'delete-me-12' }) });
    assert.equal(gone.status, 200);
    assert.match(await gone.text(), /Account deleted/);

    // The paste survives, anonymised and unlisted; the profile is gone.
    const view = await app.request(`/p/${id}`);
    assert.equal(view.status, 200);
    const row = await app.db.get('SELECT user_id, visibility FROM pastes WHERE id = ?', [id]);
    assert.equal(row.user_id, null);
    assert.equal(row.visibility, 'unlisted');
    assert.equal((await app.request('/u/delu1')).status, 404);
    // Keys and passwords die with the account.
    assert.equal(
      (await app.request('/api/pastes/mine', { headers: { authorization: `Bearer ${key}` } })).status,
      401,
    );
    assert.equal(
      (await app.request('/login', { body: form({ username: 'delu1', password: 'delete-me-12' }), jar: 'ghost' })).status,
      401,
    );
  } finally {
    await app.close();
  }
});

test('editor shows visibility radios to members and a hero to visitors', async () => {
  const app = await createApp();
  try {
    const anon = await (await app.request('/')).text();
    assert.match(anon, /Paste\. Save\. Share\. Copy\./);
    assert.doesNotMatch(anon, /name="visibility"/);
    assert.match(anon, /create an account/);

    await registerUser(app, 'radiu');
    const member = await (await app.request('/', { jar: 'radiu' })).text();
    assert.match(member, /name="visibility"/);
    assert.match(member, /value="public"/);
    assert.doesNotMatch(member, /hero-title/);
  } finally {
    await app.close();
  }
});

test('theme toggle cycles light, dark, ocean and auto', async () => {
  const app = await createApp();
  try {
    const res = await app.request('/theme', { method: 'POST', body: form({ theme: 'ocean', next: '/' }) });
    assert.equal(res.status, 303);
    assert.equal(app.jar().get('mb_theme'), 'ocean');
    assert.match(await (await app.request('/')).text(), /data-theme="ocean"/);

    const invalid = await app.request('/theme', { method: 'POST', body: form({ theme: 'banana', next: '/' }) });
    assert.equal(invalid.status, 303);
    assert.equal(app.jar().get('mb_theme'), 'auto');
  } finally {
    await app.close();
  }
});
