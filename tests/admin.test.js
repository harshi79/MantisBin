import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_COOKIE, ADMIN_LOGIN_COOKIE } from '../src/lib/admin.js';
import { sha256Hex } from '../src/lib/crypto.js';
import { authenticateApiKey, createApiKey, createSession, findUserByUsername, resolveSession } from '../src/lib/auth.js';
import { ensureSchema } from '../src/db/schema.js';
import { createNodeDb } from '../src/db/node-sqlite.js';
import { createApp, form, ORIGIN, pasteIdFrom, registerUser } from './helpers.js';

// Test fixtures only. Production has no default administrator password.
const PASSWORD = 'test-only-admin-password-123';
const ADMIN_ENV = { ADMIN_PASSWORD: PASSWORD };
const origin = { origin: ORIGIN };
function csrf(body) {
  const token = /name="csrf" value="([A-Za-z0-9]+)"/.exec(body)?.[1];
  assert.ok(token, 'the form must contain a CSRF token');
  return token;
}
async function signIn(app, jar = 'admin') {
  const challenge = csrf(await (await app.request('/admin/login', { jar })).text());
  const response = await app.request('/admin/login', { jar, headers: origin, body: form({ csrf: challenge, password: PASSWORD }) });
  assert.equal(response.status, 303);
  return { response, token: csrf(await (await app.request('/admin', { jar })).text()) };
}
async function act(app, token, action, target, extra = {}) {
  return app.request('/admin/action', { jar: 'admin', headers: origin,
    body: form({ csrf: token, action, target, confirm: 'yes', reason: 'Testing moderation', ...extra }) });
}
async function makePaste(app, values = {}, jar = 'guest') {
  const result = await app.request('/p', { jar, body: form({ title: 'example.txt', content: 'example content', ...values }) });
  assert.equal(result.status, 303);
  return pasteIdFrom(result);
}

test('admin fails closed for missing/weak secrets on every protected endpoint', async () => {
  for (const env of [{}, { ADMIN_PASSWORD: 'short' }, { ADMIN_PASSWORD: 'x'.repeat(257) }, { ...ADMIN_ENV, APP_SECRET: '' }]) {
    const app = await createApp({ env });
    try {
      for (const path of ['/admin', '/admin/login', '/admin/pastes', '/admin/users', '/admin/audit', '/admin/confirm']) {
        const response = await app.request(path);
        assert.equal(response.status, 503, path);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      }
      assert.equal((await app.request('/admin/action', { body: form({ action: 'cleanup' }) })).status, 503);
      assert.equal((await app.request('/')).status, 200, 'public application stays available');
    } finally { await app.close(); }
  }
});

test('regular accounts and fabricated admin cookies cannot access administration', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    await registerUser(app, 'user01');
    const redirect = await app.request('/admin', { jar: 'user01' });
    assert.equal(redirect.headers.get('location'), '/admin/login');
    for (const path of ['/admin/pastes', '/admin/users', '/admin/audit', '/admin/confirm?action=cleanup']) {
      assert.equal((await app.request(path, { jar: 'user01' })).status, 401);
    }
    app.jar('user01').set(ADMIN_COOKIE, 'A'.repeat(48));
    assert.equal((await app.request('/admin/action', { jar: 'user01', headers: origin, body: form({ action: 'cleanup', csrf: 'fake' }) })).status, 401);
  } finally { await app.close(); }
});

test('administrator login requires same-origin and CSRF, issues private hashed sessions and never echoes passwords', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const challenge = csrf(await (await app.request('/admin/login', { jar: 'admin' })).text());
    for (const headers of [{}, { origin: 'https://evil.test' }, { origin: 'null' }]) {
      assert.equal((await app.request('/admin/login', { jar: 'admin', headers, body: form({ csrf: challenge, password: PASSWORD }) })).status, 403);
    }
    assert.equal((await app.request('/admin/login', { jar: 'admin', headers: origin, body: form({ csrf: 'wrong', password: PASSWORD }) })).status, 403);
    const bad = await app.request('/admin/login', { jar: 'admin', headers: origin, body: form({ csrf: challenge, password: 'incorrect-secret-123' }) });
    assert.equal(bad.status, 401);
    assert.doesNotMatch(await bad.text(), /incorrect-secret-123/);
    const { response } = await signIn(app);
    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find((value) => value.startsWith(ADMIN_COOKIE + '='));
    assert.match(sessionCookie, /Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=3600; Secure/);
    assert.ok(!app.jar('admin').has(ADMIN_LOGIN_COOKIE));
    const token = app.jar('admin').get(ADMIN_COOKIE);
    const row = await app.db.get('SELECT * FROM admin_sessions');
    assert.equal(row.token_hash, await sha256Hex(token));
    assert.ok(!JSON.stringify(row).includes(token));
    assert.ok(!JSON.stringify(row).includes(PASSWORD));
    const dashboard = await app.request('/admin', { jar: 'admin' });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get('referrer-policy'), 'same-origin');
    assert.equal(dashboard.headers.get('cache-control'), 'no-store');
    assert.equal(dashboard.headers.get('x-frame-options'), 'DENY');
  } finally { await app.close(); }
});

test('admin login limits attempts per hashed IP and globally', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const challenge = csrf(await (await app.request('/admin/login')).text());
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.request('/admin/login', { ip: '192.0.2.123', headers: origin, body: form({ csrf: challenge, password: 'wrong' }) })).status, 401);
    }
    const limited = await app.request('/admin/login', { ip: '192.0.2.123', headers: origin, body: form({ csrf: challenge, password: PASSWORD }) });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const buckets = JSON.stringify(await app.db.all('SELECT bucket FROM rate_limits'));
    assert.ok(!buckets.includes('192.0.2.123'));
    await app.db.run("UPDATE rate_limits SET count = 50 WHERE bucket = 'admin:login:global:900'");
    assert.equal((await app.request('/admin/login', { ip: '192.0.2.99', headers: origin, body: form({ csrf: challenge, password: PASSWORD }) })).status, 429);
  } finally { await app.close(); }
});

test('admin sessions expire, cannot be fixed at login, and are invalidated by secret rotation', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    await signIn(app);
    const original = app.jar('admin').get(ADMIN_COOKIE);
    // A fresh login POST replaces, rather than reuses, the existing session.
    const challenge = csrf(await (await app.request('/admin/login', { jar: 'challenge' })).text());
    app.jar('admin').set(ADMIN_LOGIN_COOKIE, challenge);
    await app.request('/admin/login', { jar: 'admin', headers: origin, body: form({ csrf: challenge, password: PASSWORD }) });
    assert.notEqual(app.jar('admin').get(ADMIN_COOKIE), original);
    app.jar('old').set(ADMIN_COOKIE, original);
    assert.equal((await app.request('/admin/pastes', { jar: 'old' })).status, 401);
    await app.db.run('UPDATE admin_sessions SET expires_at = 1');
    assert.equal((await app.request('/admin/users', { jar: 'admin' })).status, 401);
    await signIn(app);
    app.env.ADMIN_PASSWORD = 'a-new-long-administrator-secret';
    assert.equal((await app.request('/admin/audit', { jar: 'admin' })).status, 401);
    app.env.ADMIN_PASSWORD = PASSWORD;
    await signIn(app);
    app.env.APP_SECRET = 'another-signing-secret-value';
    assert.equal((await app.request('/admin/audit', { jar: 'admin' })).status, 401);
  } finally { await app.close(); }
});

test('logout revokes its server-side session and rejects CSRF', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const { token } = await signIn(app);
    const cookie = app.jar('admin').get(ADMIN_COOKIE);
    assert.equal((await app.request('/admin/logout', { jar: 'admin', headers: origin, body: form({ csrf: 'bad' }) })).status, 403);
    assert.equal((await app.request('/admin/logout', { jar: 'admin', headers: origin, body: form({ csrf: token }) })).status, 303);
    app.jar('replay').set(ADMIN_COOKIE, cookie);
    assert.equal((await app.request('/admin/users', { jar: 'replay' })).status, 401);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'logout'")).n, 1);
  } finally { await app.close(); }
});

test('admin listings and analytics never expose or consume protected/one-time content', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const id = await makePaste(app, { title: 'SECRET-TITLE', content: 'SECRET-BODY', password: 'private-password', burn_after: 'read', thumbnail_url: 'https://example.com/SECRET-IMAGE.png' });
    await signIn(app);
    for (const path of ['/admin', '/admin/pastes', '/admin/pastes?protection=password', '/admin/pastes?protection=burn', `/admin/confirm?action=delete_paste&target=${id}`]) {
      const response = await app.request(path, { jar: 'admin' });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.doesNotMatch(body, /SECRET-TITLE|SECRET-BODY|SECRET-IMAGE|private-password|pbkdf2-sha256/);
    }
    const row = await app.db.get('SELECT burned, views, content FROM pastes WHERE id = ?', [id]);
    assert.equal(row.burned, 0);
    assert.equal(row.views, 0);
    assert.equal(row.content, 'SECRET-BODY');
  } finally { await app.close(); }
});

test('all mutations require CSRF, explicit confirmation and reason; actions are allowlisted', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const { token } = await signIn(app);
    const id = await makePaste(app);
    assert.equal((await act(app, 'bad', 'delete_paste', id)).status, 403);
    assert.equal((await act(app, token, 'delete_paste', id, { confirm: 'no' })).status, 400);
    assert.equal((await act(app, token, 'delete_paste', id, { reason: 'x' })).status, 400);
    assert.equal((await act(app, token, 'delete_paste', id, { reason: 'x'.repeat(301) })).status, 400);
    assert.equal((await act(app, token, '__proto__', id)).status, 400);
    assert.equal((await act(app, token, 'delete_paste', "' OR 1=1" )).status, 400);
    assert.equal((await app.request('/admin/action', { jar: 'admin', headers: { origin: 'https://evil.test' }, body: form({ csrf: token, action: 'delete_paste', target: id, confirm: 'yes', reason: 'delete this' }) })).status, 403);
    assert.equal((await app.request('/admin/action', { jar: 'admin' })).status, 405);
    assert.ok(await app.db.get('SELECT id FROM pastes WHERE id = ?', [id]));
    assert.equal((await act(app, token, 'delete_paste', id)).status, 303);
    assert.equal(await app.db.get('SELECT id FROM pastes WHERE id = ?', [id]), null);
    const audit = await app.db.get("SELECT * FROM admin_audit WHERE action = 'delete_paste'");
    assert.equal(audit.target, id);
    assert.equal(audit.reason, 'Testing moderation');
  } finally { await app.close(); }
});

test('moderation and its audit entry commit atomically', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const id = await makePaste(app);
    const { token } = await signIn(app);
    await app.db.run("INSERT INTO paste_views (paste_id, visitor, created_at) VALUES (?, 'test', 1)", [id]);
    await app.db.run("CREATE TRIGGER reject_admin_audit BEFORE INSERT ON admin_audit WHEN NEW.action = 'delete_paste' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    assert.equal((await act(app, token, 'delete_paste', id)).status, 500);
    assert.ok(await app.db.get('SELECT id FROM pastes WHERE id = ?', [id]));
    assert.ok(await app.db.get('SELECT paste_id FROM paste_views WHERE paste_id = ?', [id]));
    await app.db.run('DROP TRIGGER reject_admin_audit');
    assert.equal((await act(app, token, 'delete_paste', id)).status, 303);
    assert.equal(await app.db.get('SELECT paste_id FROM paste_views WHERE paste_id = ?', [id]), null);
  } finally { await app.close(); }
});

test('suspend/revoke/restore protect both account sessions and API keys; deletion anonymises pastes', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    await registerUser(app, 'owner1');
    const account = await findUserByUsername(app.db, 'owner1');
    const session = await createSession(app.db, account.id);
    const key = await createApiKey(app.db, account.id, 'test');
    const paste = await makePaste(app, { visibility: 'public' }, 'owner1');
    const { token } = await signIn(app);
    assert.equal((await act(app, token, 'suspend_user', account.id)).status, 303);
    assert.equal(await resolveSession(app.db, session.token), null);
    assert.equal(await authenticateApiKey(app.db, key.plain), null);
    assert.equal((await app.request('/login', { jar: 'fresh', body: form({ username: 'owner1', password: 'correct-horse-1' }) })).status, 401);
    // Even a session/key minted concurrently with suspension cannot authenticate.
    const racedSession = await createSession(app.db, account.id);
    const racedKey = await createApiKey(app.db, account.id, 'raced');
    assert.equal(await resolveSession(app.db, racedSession.token), null);
    assert.equal(await authenticateApiKey(app.db, racedKey.plain), null);
    assert.equal((await act(app, token, 'restore_user', account.id)).status, 303);
    assert.equal((await app.request('/login', { jar: 'fresh', body: form({ username: 'owner1', password: 'correct-horse-1' }) })).status, 303);
    assert.equal(await authenticateApiKey(app.db, key.plain), null, 'old key remains revoked');
    assert.equal(await authenticateApiKey(app.db, racedKey.plain), null, 'a key from a racing request is not revived');
    assert.equal((await act(app, token, 'revoke_user', account.id)).status, 303);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [account.id])).n, 0);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?', [account.id])).n, 0);
    assert.equal((await act(app, token, 'delete_user', account.id)).status, 303);
    const retained = await app.db.get('SELECT user_id, visibility, content FROM pastes WHERE id = ?', [paste]);
    assert.equal(retained.user_id, null);
    assert.equal(retained.visibility, 'unlisted');
    assert.equal(retained.content, 'example content');
    assert.equal(await findUserByUsername(app.db, 'owner1'), null);
  } finally { await app.close(); }
});

test('manual cleanup is bounded and preserves active one-time pastes', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const active = await makePaste(app, { burn_after: 'read' });
    const now = Math.floor(Date.now() / 1000);
    await app.db.batch(Array.from({ length: 205 }, (_, i) => ({
      sql: 'INSERT INTO pastes (id, title, content, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      params: [`old${String(i).padStart(5, '0')}`, 'old', 'expired content', now - 100, now - 100, now - 1],
    })));
    const { token } = await signIn(app);
    assert.equal((await act(app, token, 'cleanup', 'expired')).status, 303);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM pastes WHERE expires_at <= ?', [now])).n, 5);
    assert.equal((await app.db.get('SELECT burned FROM pastes WHERE id = ?', [active])).burned, 0);
    assert.match((await app.db.get("SELECT reason FROM admin_audit WHERE action = 'cleanup'")).reason, /selected 200/);
  } finally { await app.close(); }
});

test('lists paginate, filter metadata and escape untrusted query/reason values', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const now = Math.floor(Date.now() / 1000);
    await app.db.batch(Array.from({ length: 27 }, (_, i) => ({
      sql: 'INSERT INTO pastes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      params: [`page${String(i).padStart(4, '0')}`, 'untitled', 'text', now, now],
    })));
    const { token } = await signIn(app);
    const first = await (await app.request('/admin/pastes', { jar: 'admin' })).text();
    const second = await (await app.request('/admin/pastes?page=2', { jar: 'admin' })).text();
    assert.equal((first.match(/action=delete_paste/g) || []).length, 25);
    assert.equal((second.match(/action=delete_paste/g) || []).length, 2);
    assert.match(first, />Next<\/a>/);
    const filtered = await (await app.request('/admin/pastes?q=page0000&owner=guest&state=active', { jar: 'admin' })).text();
    assert.equal((filtered.match(/action=delete_paste/g) || []).length, 1);
    const malicious = '<script>alert(1)</script>';
    const search = await (await app.request(`/admin/pastes?q=${encodeURIComponent(malicious)}`, { jar: 'admin' })).text();
    assert.ok(!search.includes(malicious));
    await act(app, token, 'delete_paste', 'page0000', { reason: malicious });
    const log = await (await app.request('/admin/audit', { jar: 'admin' })).text();
    assert.ok(!log.includes(malicious));
    assert.match(log, /&lt;script&gt;/);
  } finally { await app.close(); }
});

test('existing account schemas migrate without losing data or suspending users', async () => {
  const db = createNodeDb(':memory:');
  try {
    await db.run('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at INTEGER NOT NULL)');
    await db.run("INSERT INTO users (username, username_key, password, created_at) VALUES ('oldusr', 'oldusr', 'hash', 1)");
    await ensureSchema(db);
    await ensureSchema(db);
    const row = await db.get('SELECT * FROM users');
    assert.equal(row.username, 'oldusr');
    assert.equal(row.suspended_at, null);
    assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_audit'"));
  } finally { await db.close(); }
});


test('cleanup rechecks eligibility inside the transaction if expiration changes after selection', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  try {
    const id = await makePaste(app);
    await app.db.run('UPDATE pastes SET expires_at = 1 WHERE id = ?', [id]);
    await app.db.run("INSERT INTO paste_views (paste_id, visitor, created_at) VALUES (?, 'visitor', 1)", [id]);
    const { token } = await signIn(app);
    const batch = app.db.batch;
    app.db.batch = async (statements) => {
      await app.db.run('UPDATE pastes SET expires_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) + 3600, id]);
      return batch(statements);
    };
    assert.equal((await act(app, token, 'cleanup', 'expired')).status, 303);
    assert.ok(await app.db.get('SELECT id FROM pastes WHERE id = ?', [id]));
    assert.ok(await app.db.get('SELECT paste_id FROM paste_views WHERE paste_id = ?', [id]));
  } finally { await app.close(); }
});
