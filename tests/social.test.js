/**
 * Phase 3 — follows, bookmarks, reactions and notifications.
 *
 * Every social action is deliberately a plain form post, so these tests drive
 * the same HTML a browser would send and then read back the same pages a
 * visitor would see. Where a behaviour is a *rule* (no self-follow, public-only
 * reactions, one row per pair) it is asserted against the database too, because
 * the HTML can always be circumnavigated by posting the form directly.
 *
 * Jar convention: `registerUser(app, name)` stores the session under the jar
 * named after the account, so `{ jar: 'alpha' }` means "as alpha".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiKeyFor, createApp, ORIGIN, pasteIdFrom, registerUser } from './helpers.js';
import { pruneNotifications, userGraphStatements } from '../src/lib/social.js';
import { REACTIONS, SOCIAL } from '../src/config.js';

async function join(app, username) {
  const response = await registerUser(app, username);
  assert.equal(response.status, 303, `register ${username} (got ${response.status})`);
  return username;
}

async function post(app, path, fields, jar) {
  return app.request(path, { method: 'POST', body: new URLSearchParams(fields).toString(), jar });
}

/** Create a paste and return its id; asserts the create actually happened. */
async function makePaste(app, jar, title, extra = {}) {
  const response = await post(app, '/p', { title, content: 'hello world', ...extra }, jar);
  assert.equal(response.status, 303, `create ${title} (got ${response.status})`);
  const id = pasteIdFrom(response);
  assert.ok(id, `create ${title} returned no paste id`);
  return id;
}

function count(app, sql, params = []) {
  return app.db.get(sql, params).then((row) => Number(Object.values(row)[0]));
}

function userId(app, username) {
  return app.db.get('SELECT id FROM users WHERE username = ?', [username]).then((row) => Number(row.id));
}

test('a signed-out visitor cannot follow, bookmark or react', async () => {
  const app = await createApp();
  try {
    await join(app, 'target');
    const follow = await post(app, '/u/target/follow', {}, null);
    assert.equal(follow.status, 303);
    assert.match(follow.headers.get('location'), /^\/login\?next=/);

    const bookmark = await post(app, '/p/aaaaaaaa/bookmark', {}, null);
    assert.equal(bookmark.status, 303);
    assert.match(bookmark.headers.get('location'), /^\/login/);

    const react = await post(app, '/p/aaaaaaaa/react', { reaction: 'heart' }, null);
    assert.equal(react.status, 303);
    assert.match(react.headers.get('location'), /^\/login/);

    // A mailbox is private, and so is the saved list.
    assert.equal((await app.request('/notifications')).status, 303);
    assert.equal((await app.request('/me/bookmarks')).status, 303);
  } finally {
    await app.close();
  }
});

test('following is idempotent, self-follow is refused', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');

    const first = await post(app, '/u/beta/follow', { follow: '1' }, 'alpha');
    assert.equal(first.status, 303);
    assert.match(first.headers.get('location'), /notice=followed/);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM follows'), 1);

    // Posting the same form again must not create a second row.
    await post(app, '/u/beta/follow', { follow: '1' }, 'alpha');
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM follows'), 1);

    const self = await post(app, '/u/alpha/follow', { follow: '1' }, 'alpha');
    assert.equal(self.status, 400);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM follows'), 1);

    const missing = await post(app, '/u/ghostuser/follow', { follow: '1' }, 'alpha');
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test('unfollowing removes the row and the follower list reflects it', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    await post(app, '/u/beta/follow', { follow: '1' }, 'alpha');

    const listed = await (await app.request('/u/beta/followers')).text();
    assert.match(listed, /@alpha/);
    assert.match(listed, /1 follower/);

    const off = await post(app, '/u/beta/follow', { follow: '0' }, 'alpha');
    assert.equal(off.status, 303);
    assert.match(off.headers.get('location'), /notice=unfollowed/);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM follows'), 0);

    const after = await (await app.request('/u/beta/followers')).text();
    assert.doesNotMatch(after, /@alpha/);
  } finally {
    await app.close();
  }
});

test('a follower list offers a follow button per account', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    await join(app, 'gamma');
    await join(app, 'delta');
    await post(app, '/u/gamma/follow', { follow: '1' }, 'alpha');
    await post(app, '/u/gamma/follow', { follow: '1' }, 'beta');

    // Signed out, the list is readable but offers no buttons: following needs an account.
    const asGuest = await (await app.request('/u/gamma/followers')).text();
    assert.match(asGuest, /@alpha/);
    assert.doesNotMatch(asGuest, /action="\/u\/alpha\/follow"/);

    const html = await (await app.request('/u/gamma/followers', { jar: 'delta' })).text();
    assert.match(html, /@alpha/);
    assert.match(html, /@beta/);
    // Two rows, two follow buttons, and no self-button for gamma.
    assert.equal((html.match(/>Follow</g) || []).length, 2);
    assert.equal((html.match(/action="\/u\/(alpha|beta)\/follow"/g) || []).length, 2);

    // Seen as alpha, alpha's own row carries no button at all (you cannot
    // follow yourself) and beta's row still offers Follow.
    const asAlpha = await (await app.request('/u/gamma/followers', { jar: 'alpha' })).text();
    assert.equal((asAlpha.match(/action="\/u\/(alpha|beta)\/follow"/g) || []).length, 1);
    assert.doesNotMatch(asAlpha, /action="\/u\/alpha\/follow"/);
  } finally {
    await app.close();
  }
});

test('follow notifications reach the followed account, and are deduped per day', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    await post(app, '/u/beta/follow', { follow: '1' }, 'alpha');

    const [alphaId, betaId] = await Promise.all([userId(app, 'alpha'), userId(app, 'beta')]);
    const rows = await app.db.all('SELECT * FROM notifications WHERE recipient_user_id = ?', [betaId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'follow');
    assert.equal(Number(rows[0].actor_user_id), alphaId);
    assert.match(rows[0].dedupe_key, /^follow:/);

    // A second follow on the same day cannot duplicate the notice.
    await post(app, '/u/beta/follow', { follow: '1' }, 'alpha');
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications'), 1);

    // Unfollowing clears a notice the visitor has not read yet.
    await post(app, '/u/beta/follow', { follow: '0' }, 'alpha');
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications'), 0);
  } finally {
    await app.close();
  }
});

test('a bookmark round-trips through the paste page', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'posted.txt', { visibility: 'public' });

    const before = await (await app.request(`/p/${id}`, { jar: 'alpha' })).text();
    assert.match(before, new RegExp(`action="/p/${id}/bookmark"`));
    assert.match(before, />Save</);

    const saved = await post(app, `/p/${id}/bookmark`, { saved: '1', next: `/p/${id}` }, 'alpha');
    assert.equal(saved.status, 303);
    assert.match(saved.headers.get('location'), /notice=saved/);

    const after = await (await app.request(`/p/${id}`, { jar: 'alpha' })).text();
    assert.match(after, />Saved</);

    const bookmarks = await (await app.request('/me/bookmarks', { jar: 'alpha' })).text();
    assert.match(bookmarks, /posted\.txt/);
    assert.match(bookmarks, /@beta/);

    const removed = await post(app, `/p/${id}/bookmark`, { saved: '0', next: `/p/${id}` }, 'alpha');
    assert.match(removed.headers.get('location'), /notice=removed/);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM bookmarks'), 0);
    const emptied = await (await app.request('/me/bookmarks', { jar: 'alpha' })).text();
    assert.doesNotMatch(emptied, /posted\.txt/);
  } finally {
    await app.close();
  }
});

test('bookmarks are private, work on unlisted pastes, and are capped', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'link-only.txt', { visibility: 'unlisted' });

    const saved = await post(app, `/p/${id}/bookmark`, { saved: '1' }, 'alpha');
    assert.equal(saved.status, 303);
    assert.match(saved.headers.get('location'), /notice=saved/);

    // The author never sees that a visitor saved their paste.
    const authorPage = await (await app.request(`/p/${id}`, { jar: 'beta' })).text();
    assert.doesNotMatch(authorPage, />Saved</);

    // Nobody else's list is reachable: the route only ever reads your own.
    const other = await (await app.request('/me/bookmarks', { jar: 'beta' })).text();
    assert.doesNotMatch(other, /link-only\.txt/);

    // Fill the cap; the next save must degrade to a clear notice, not an error.
    const alphaId = await userId(app, 'alpha');
    const filler = [];
    for (let i = 0; i < SOCIAL.bookmarks - 1; i += 1) {
      filler.push({
        sql: 'INSERT OR IGNORE INTO bookmarks (user_id, paste_id, created_at) VALUES (?, ?, ?)',
        params: [alphaId, String(i).padStart(8, '0'), 0],
      });
    }
    await app.db.batch(filler);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?', [alphaId]), SOCIAL.bookmarks);

    const second = await makePaste(app, 'beta', 'one-too-many.txt', { visibility: 'public' });
    const capped = await post(app, `/p/${second}/bookmark`, { saved: '1' }, 'alpha');
    assert.equal(capped.status, 303);
    assert.match(capped.headers.get('location'), /notice=limit/);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM bookmarks WHERE paste_id = ?', [second]), 0);
  } finally {
    await app.close();
  }
});

test('a protected paste needs the unlock cookie before it can be bookmarked', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'locked.txt', { visibility: 'public', password: 'open-sesame' });

    const locked = await post(app, `/p/${id}/bookmark`, { saved: '1' }, 'alpha');
    assert.equal(locked.status, 303);
    assert.match(locked.headers.get('location'), /notice=locked/);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM bookmarks'), 0);

    const unlocked = await post(app, `/p/${id}/unlock`, { password: 'open-sesame' }, 'alpha');
    assert.equal(unlocked.status, 303);
    const saved = await post(app, `/p/${id}/bookmark`, { saved: '1' }, 'alpha');
    assert.match(saved.headers.get('location'), /notice=saved/);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM bookmarks'), 1);
  } finally {
    await app.close();
  }
});

test('a reaction is stored, counted, and shown to everyone', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'reactable.txt', { visibility: 'public' });

    const reacted = await post(app, `/p/${id}/react`, { reaction: 'fire' }, 'alpha');
    assert.equal(reacted.status, 303);
    assert.match(reacted.headers.get('location'), /notice=reacted/);
    assert.equal((await app.db.get('SELECT reaction FROM reactions WHERE paste_id = ?', [id])).reaction, '🔥');

    // The reactor's chip is pressed; a signed-out reader still sees the count.
    const mine = await (await app.request(`/p/${id}`, { jar: 'alpha' })).text();
    assert.match(mine, /aria-pressed="true"/);
    const guest = await (await app.request(`/p/${id}`)).text();
    assert.match(guest, /class="reaction-chip/);
    assert.doesNotMatch(guest, /aria-pressed="true"/);
    assert.match(guest, /🔥/);

    // Changing the reaction replaces it, never adds a second one.
    await post(app, `/p/${id}/react`, { reaction: 'heart' }, 'alpha');
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM reactions'), 1);
    assert.equal((await app.db.get('SELECT reaction FROM reactions')).reaction, '❤️');

    // An emoji outside the palette is refused outright rather than stored.
    const junk = await post(app, `/p/${id}/react`, { reaction: '🍌' }, 'alpha');
    assert.equal(junk.status, 400);

    // An empty value means "take mine back".
    const cleared = await post(app, `/p/${id}/react`, { reaction: '' }, 'alpha');
    assert.equal(cleared.status, 303);
    assert.match(cleared.headers.get('location'), /notice=unreacted/);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM reactions'), 0);
  } finally {
    await app.close();
  }
});

test('reactions are reserved for public pastes', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'quiet.txt', { visibility: 'unlisted' });

    const response = await post(app, `/p/${id}/react`, { reaction: 'heart' }, 'alpha');
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /notice=private/);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM reactions'), 0);

    // The page does not even offer the buttons.
    const page = await (await app.request(`/p/${id}`, { jar: 'alpha' })).text();
    assert.doesNotMatch(page, /name="reaction"/);
  } finally {
    await app.close();
  }
});

test('reacting notifies the author once, and never the reactor', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'news.txt', { visibility: 'public' });
    await post(app, `/p/${id}/react`, { reaction: 'clap' }, 'alpha');
    await post(app, `/p/${id}/react`, { reaction: 'clap' }, 'alpha');
    await post(app, `/p/${id}/react`, { reaction: 'party' }, 'alpha');

    const betaId = await userId(app, 'beta');
    const rows = await app.db.all('SELECT * FROM notifications WHERE recipient_user_id = ? AND type = ?', [betaId, 'reaction']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].paste_id, id);

    // The author reacting to their own paste is not news for themselves.
    await post(app, `/p/${id}/react`, { reaction: 'fire' }, 'beta');
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE type = ?', ['reaction']), 1);
  } finally {
    await app.close();
  }
});

test('a public paste announces itself to followers, exactly once', async () => {
  const app = await createApp();
  try {
    await join(app, 'author');
    await join(app, 'fan');
    await post(app, '/u/author/follow', { follow: '1' }, 'fan');

    const id = await makePaste(app, 'author', 'release.txt', { visibility: 'public' });
    const fanId = await userId(app, 'fan');
    const rows = await app.db.all('SELECT * FROM notifications WHERE recipient_user_id = ? AND type = ?', [fanId, 'new_paste']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].link, `/p/${id}`);
    assert.equal(rows[0].paste_id, id);

    // Editing the same public paste is not new news.
    const edit = await post(app, `/p/${id}/edit`, { title: 'release 2.txt', content: 'hello again', visibility: 'public' }, 'author');
    assert.equal(edit.status, 303);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE type = ?', ['new_paste']), 1);

    // An unlisted paste that is *made* public later is news — once.
    const hidden = await makePaste(app, 'author', 'later.txt', { visibility: 'unlisted' });
    await post(app, `/p/${hidden}/edit`, { title: 'later.txt', content: 'hello world', visibility: 'public' }, 'author');
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE type = ?', ['new_paste']), 2);
  } finally {
    await app.close();
  }
});

test('unlisted, protected and anonymous pastes never reach a follower mailbox', async () => {
  const app = await createApp();
  try {
    await join(app, 'author');
    await join(app, 'fan');
    await post(app, '/u/author/follow', { follow: '1' }, 'fan');

    await makePaste(app, 'author', 'quiet.txt', { visibility: 'unlisted' });
    await makePaste(app, 'author', 'locked.txt', { visibility: 'public', password: 'hunter2' });
    await makePaste(app, 'author', 'default.txt');
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE type = ?', ['new_paste']), 0);
  } finally {
    await app.close();
  }
});

test('notifications mark one read, then all read, and never across accounts', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    await post(app, '/u/alpha/follow', { follow: '1' }, 'beta');
    const [alphaId, betaId] = await Promise.all([userId(app, 'alpha'), userId(app, 'beta')]);
    await app.db.run(
      'INSERT INTO notifications (id, recipient_user_id, actor_user_id, paste_id, type, title, message, link, dedupe_key, is_read, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ['admintestnotice1', alphaId, null, null, 'admin', 'Scheduled maintenance', 'Read-only for ten minutes.', '/docs', 'admin:test', 0, 1_700_000_000],
    );

    const page = await (await app.request('/notifications', { jar: 'alpha' })).text();
    assert.match(page, /Scheduled maintenance/);
    assert.match(page, /Mark all read/);
    assert.match(page, /Scheduled maintenance/);

    const one = await post(app, '/notifications/read', { id: 'admintestnotice1', next: '/notifications' }, 'alpha');
    assert.equal(one.status, 303);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE is_read = 1'), 1);

    // Beta marking alpha's notice read is a no-op: the update is scoped.
    await app.db.run('UPDATE notifications SET is_read = 0');
    const foreign = await post(app, '/notifications/read', { id: 'admintestnotice1' }, 'beta');
    assert.equal(foreign.status, 303);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE is_read = 0'), 2);

    const all = await post(app, '/notifications/read', { all: '1' }, 'alpha');
    assert.match(all.headers.get('location'), /notice=read/);
    // Alpha owns both rows, so both go read — and nobody else had any.
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE is_read = 0'), 0);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ?', [betaId]), 0);
  } finally {
    await app.close();
  }
});

test('the nav bell shows an unread count and saturates at 9+', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    await post(app, '/u/alpha/follow', { follow: '1' }, 'beta');

    const home = await (await app.request('/', { jar: 'alpha' })).text();
    assert.match(home, /class="nav-badge"/);
    assert.match(home, /nav-bell/);
    // A signed-out visitor has no bell at all.
    const guest = await (await app.request('/')).text();
    assert.doesNotMatch(guest, /nav-bell/);

    const alphaId = await userId(app, 'alpha');
    const bulk = [];
    for (let i = 0; i < 12; i += 1) {
      bulk.push({
        sql: 'INSERT INTO notifications (id, recipient_user_id, actor_user_id, paste_id, type, title, message, link, dedupe_key, is_read, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        params: [`bulk${i}`, alphaId, null, null, 'admin', 'Bulk notice', '', '/docs', `bulk:${i}`, 0, 1_700_000_000 + i],
      });
    }
    await app.db.batch(bulk);
    const saturated = await (await app.request('/', { jar: 'alpha' })).text();
    assert.match(saturated, /9\+/);
  } finally {
    await app.close();
  }
});

test('the /me page links to the new social pages', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    const html = await (await app.request('/me', { jar: 'alpha' })).text();
    assert.match(html, /href="\/me\/bookmarks"/);
    assert.match(html, /href="\/notifications"/);
  } finally {
    await app.close();
  }
});

test('the reaction palette on a paste page is the configured one, in order', async () => {
  const app = await createApp();
  try {
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'palette.txt', { visibility: 'public' });
    const html = await (await app.request(`/p/${id}`, { jar: 'beta' })).text();
    const palette = [...html.matchAll(/name="reaction" value="([^"]*)"/g)].map((match) => match[1]);
    // The empty value is the "remove mine" button, which only a reactor sees.
    assert.deepEqual(palette, REACTIONS.map((entry) => entry.emoji));
  } finally {
    await app.close();
  }
});

test('one reaction per account and paste is a database invariant', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'invariant.txt', { visibility: 'public' });
    const alphaId = await userId(app, 'alpha');

    await app.db.run('INSERT INTO reactions (user_id, paste_id, reaction, created_at) VALUES (?, ?, ?, ?)', [alphaId, id, '🔥', 0]);
    await app.db.run(
      'INSERT INTO reactions (user_id, paste_id, reaction, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, paste_id) DO UPDATE SET reaction = excluded.reaction',
      [alphaId, id, '🎉', 0],
    );
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM reactions WHERE paste_id = ?', [id]), 1);
    assert.equal((await app.db.get('SELECT reaction FROM reactions WHERE paste_id = ?', [id])).reaction, '🎉');
  } finally {
    await app.close();
  }
});

test('deleting a paste takes its bookmarks, reactions and notifications with it', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    await post(app, '/u/alpha/follow', { follow: '1' }, 'beta');
    const id = await makePaste(app, 'alpha', 'doomed.txt', { visibility: 'public' });
    await post(app, `/p/${id}/bookmark`, { saved: '1' }, 'beta');
    await post(app, `/p/${id}/react`, { reaction: 'heart' }, 'beta');
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM bookmarks'), 1);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM reactions'), 1);
    // Two rows point at the paste: beta's "new paste" fanout and alpha's
    // "somebody reacted" notice.
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE paste_id = ?', [id]), 2);

    const gone = await post(app, `/p/${id}/delete`, {}, 'alpha');
    assert.equal(gone.status, 303);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM bookmarks'), 0);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM reactions'), 0);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE paste_id = ?', [id]), 0);
    // The follow notice (which names no paste) is untouched by all this.
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE paste_id IS NULL'), 1);
  } finally {
    await app.close();
  }
});

test('pruneNotifications drops only read, old rows', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    const alphaId = await userId(app, 'alpha');
    const old = 1_000_000;
    const fresh = 4_000_000_000;
    for (const [id, isRead, createdAt] of [
      ['oldread', 1, old],
      ['oldunread', 0, old],
      ['newread', 1, fresh],
    ]) {
      await app.db.run(
        'INSERT INTO notifications (id, recipient_user_id, actor_user_id, paste_id, type, title, message, link, dedupe_key, is_read, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [id, alphaId, null, null, 'admin', id, '', '/docs', null, isRead, createdAt],
      );
    }

    const removed = await pruneNotifications(app.db, 3_000_000_000);
    assert.equal(removed, 1);
    const left = (await app.db.all('SELECT id FROM notifications ORDER BY id')).map((row) => row.id);
    assert.deepEqual(left, ['newread', 'oldunread']);
  } finally {
    await app.close();
  }
});

test('an account deletion clears its whole social graph', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    await post(app, '/u/beta/follow', { follow: '1' }, 'alpha');
    await post(app, '/u/alpha/follow', { follow: '1' }, 'beta');
    await post(app, '/u/alpha/follow', { follow: '1' }, 'gamma-junk').catch(() => null);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM follows'), 2);
    assert.ok((await count(app, 'SELECT COUNT(*) AS n FROM notifications')) >= 2);

    const alphaId = await userId(app, 'alpha');
    await app.db.batch(userGraphStatements(alphaId));
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM follows'), 0);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications'), 0);
  } finally {
    await app.close();
  }
});

test('the social rate limit eventually refuses a flood', async () => {
  const app = await createApp();
  try {
    await join(app, 'alpha');
    await join(app, 'beta');
    const id = await makePaste(app, 'beta', 'flood.txt', { visibility: 'public' });
    const alphaId = await userId(app, 'alpha');
    // The bucket is per account: spend it, then expect a 429 rather than a write.
    await app.db.run('INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, ?, ?)', [
      `social:${alphaId}:3600`,
      10_000,
      Math.floor(Date.now() / 1000) + 3600,
    ]);

    const blocked = await post(app, `/p/${id}/react`, { reaction: 'heart' }, 'alpha');
    assert.equal(blocked.status, 429);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM reactions'), 0);

    // A different account is unaffected — the bucket is per account, not global.
    const fine = await post(app, `/p/${id}/react`, { reaction: 'heart' }, 'beta');
    assert.equal(fine.status, 303);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM reactions'), 1);
  } finally {
    await app.close();
  }
});

test('the reaction normaliser takes a glyph, a stable id or a :token:', async () => {
  const { normalizeReaction } = await import('../src/lib/social.js');
  assert.equal(normalizeReaction('🔥'), '🔥');
  assert.equal(normalizeReaction(' fire '), '🔥');
  assert.equal(normalizeReaction(':fire:'), '🔥');
  assert.equal(normalizeReaction('MINDblown'), '🤯');
  assert.equal(normalizeReaction('🍌'), null);
  assert.equal(normalizeReaction(''), null);
  assert.equal(normalizeReaction(null), null);
});

test('social pages render without a configured APP_SECRET (dev fallback)', async () => {
  // The owner check hashes the visitor address with the app secret. When it is
  // unset (local dev, a preview deploy) that hash must fall back rather than
  // throwing — otherwise the whole profile page 500s.
  const app = await createApp({ env: { APP_SECRET: undefined } });
  try {
    await join(app, 'nosecret');
    const created = await post(app, '/p', { title: 'dev.txt', content: 'hi', visibility: 'public' }, 'nosecret');
    assert.equal(created.status, 303);

    const profile = await app.request('/u/nosecret');
    assert.equal(profile.status, 200);
    const html = await profile.text();
    assert.match(html, /dev\.txt/);
    assert.match(html, /<b>1<\/b> profile view/);

    // The paste page has the same dependency, for the view counter.
    const id = pasteIdFrom(created);
    assert.equal((await app.request(`/p/${id}`)).status, 200);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// The API publishes through the same rules as the web form (merge phase 4 fix)
// ---------------------------------------------------------------------------

test('the API announces a paste exactly like the web form does', async () => {
  const app = await createApp();
  try {
    await join(app, 'apifan');
    await join(app, 'apifanfan');
    await post(app, '/u/apifan/follow', { follow: '1' }, 'apifanfan');
    const key = await createApiKeyFor(app, 'apifan');
    const fanId = await userId(app, 'apifanfan');
    const api = {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', origin: ORIGIN },
    };

    // 1. Created public → the follower hears about it.
    const created = await app.request('/api/pastes', {
      ...api,
      body: JSON.stringify({ title: 'api.txt', content: 'x', visibility: 'public' }),
    });
    assert.equal(created.status, 201);
    const paste = await created.json();
    assert.equal(
      await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ? AND type = ?', [fanId, 'new_paste']),
      1,
    );

    // 2. Created unlisted, then edited into public → same news, same once.
    const quiet = await app.request('/api/pastes', {
      ...api,
      body: JSON.stringify({ title: 'quiet.txt', content: 'x' }),
    });
    assert.equal(quiet.status, 201);
    const quietId = (await quiet.json()).id;
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE paste_id = ?', [quietId]), 0);
    const published = await app.request(`/api/pastes/${quietId}`, {
      method: 'PATCH',
      headers: api.headers,
      body: JSON.stringify({ visibility: 'public' }),
    });
    assert.equal(published.status, 200);
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE paste_id = ?', [quietId]), 1);

    // 3. A fork the actor publishes on their own profile.
    const source = await makePaste(app, 'apifanfan', 'forkme.txt', { visibility: 'public' });
    const fork = await app.request(`/api/pastes/${source}/fork`, {
      ...api,
      body: JSON.stringify({ visibility: 'public' }),
    });
    assert.equal(fork.status, 201);
    const copy = await fork.json();
    assert.equal(await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE paste_id = ?', [copy.id]), 1);
    assert.equal(
      await count(app, 'SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ? AND type = ?', [fanId, 'new_paste']),
      3,
    );
    assert.equal(paste.id.length, 8);
  } finally {
    await app.close();
  }
});
