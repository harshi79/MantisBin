/**
 * Merge phase 0 — schema, migration safety and the widened username policy.
 *
 * These tests exist to prove that adding the VibeBin social/profile layer
 * cannot disturb anything MantisBin already guarantees:
 *
 *   - a database created before this change migrates in place: new tables
 *     appear, the new `pastes` columns are added, and every existing row is
 *     byte-identical afterwards (with `formatting` NULL, `pinned` 0);
 *   - `ensureSchema` stays idempotent, so a second boot changes nothing;
 *   - a paste written before the merge still renders through the real router;
 *   - deleting an account removes its social graph in the same transaction;
 *   - the widened username rule accepts every historic handle, accepts the
 *     new 3–20 form, and still rejects separators, over-length names and the
 *     reserved service names.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRequest } from '../src/app.js';
import { ensureSchema, SCHEMA } from '../src/db/schema.js';
import { createNodeDb } from '../src/db/node-sqlite.js';
import { destroyUser } from '../src/lib/auth.js';
import { profileCounts, listPinnedPublicPastes } from '../src/lib/social.js';
import { validateUsername } from '../src/lib/validate.js';
import { createApp, form, registerUser } from './helpers.js';

/** The tables the merged app adds on top of the original eight. */
const NEW_TABLES = [
  'profiles',
  'follows',
  'bookmarks',
  'reactions',
  'notifications',
  'stickers',
  'tags',
  'user_tags',
];

/** Pre-merge shape of the two tables a real deployment already has. */
const LEGACY_DDL = [
  `CREATE TABLE users (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     username     TEXT    NOT NULL,
     username_key TEXT    NOT NULL UNIQUE,
     password     TEXT    NOT NULL,
     created_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE pastes (
     id         TEXT    PRIMARY KEY,
     title      TEXT    NOT NULL,
     content    TEXT    NOT NULL,
     language   TEXT    NOT NULL DEFAULT 'plaintext',
     font       TEXT    NOT NULL DEFAULT 'mono',
     font_size  INTEGER NOT NULL DEFAULT 14,
     size       INTEGER NOT NULL DEFAULT 0,
     views      INTEGER NOT NULL DEFAULT 0,
     user_id    INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     expires_at INTEGER
   )`,
];

async function tableNames(db) {
  const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(rows.map((row) => String(row.name)));
}

async function columnNames(db, table) {
  const rows = await db.all(`SELECT name FROM pragma_table_info('${table}')`);
  return new Set(rows.map((row) => String(row.name)));
}

test('a fresh database has every original and merged table', async () => {
  const db = createNodeDb(':memory:');
  await ensureSchema(db);
  const tables = await tableNames(db);
  for (const name of [
    'users', 'sessions', 'pastes', 'api_keys', 'paste_views',
    'admin_sessions', 'admin_audit', 'rate_limits', ...NEW_TABLES,
  ]) {
    assert.ok(tables.has(name), `missing table ${name}`);
  }
  await db.close();
});

test('an existing pre-merge database migrates in place without touching its rows', async () => {
  const db = createNodeDb(':memory:');
  for (const sql of LEGACY_DDL) await db.run(sql);
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    'INSERT INTO users (username, username_key, password, created_at) VALUES (?, ?, ?, ?)',
    ['legacy1', 'legacy1', 'pbkdf2-sha256$1000$x$y', now],
  );
  await db.run(
    `INSERT INTO pastes (id, title, content, language, font, font_size, size, views, user_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['AAAAAAAA', 'before-merge.txt', 'old content\nline two\n', 'plaintext', 'mono', 14, 22, 7, 1, now, now, null],
  );

  await ensureSchema(db);
  // Idempotent: a second cold start must be a no-op, not an error.
  await ensureSchema(db);

  const tables = await tableNames(db);
  for (const name of NEW_TABLES) assert.ok(tables.has(name), `migration did not create ${name}`);

  const pasteColumns = await columnNames(db, 'pastes');
  for (const column of ['password_hash', 'burn_mode', 'burned', 'visibility', 'thumbnail_url', 'formatting', 'title_color', 'pinned']) {
    assert.ok(pasteColumns.has(column), `migration did not add pastes.${column}`);
  }
  assert.ok((await columnNames(db, 'users')).has('suspended_at'));

  const row = await db.get('SELECT * FROM pastes WHERE id = ?', ['AAAAAAAA']);
  assert.equal(row.content, 'old content\nline two\n', 'legacy content must be byte-identical');
  assert.equal(row.title, 'before-merge.txt');
  assert.equal(Number(row.views), 7, 'existing counters must survive');
  assert.equal(Number(row.size), 22);
  assert.equal(row.formatting, null, 'a paste with no formatting stays plain');
  assert.equal(row.title_color, null);
  assert.equal(Number(row.pinned), 0);
  assert.equal(row.password_hash, null);
  assert.equal(row.burn_mode, 'never');
  assert.equal(Number(row.burned), 0);
  assert.equal(row.visibility, 'unlisted');

  // The row still renders through the real router, unchanged.
  const response = await handleRequest({
    request: new Request('https://mantisbin.test/p/AAAAAAAA'),
    env: { APP_SECRET: 'test-secret-value' },
    db,
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /before-merge\.txt/);
  assert.match(html, /old content/);
  await db.close();
});

test('the schema array itself stays append-only and free of duplicate tables', async () => {
  const names = SCHEMA
    .map((sql) => /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql)?.[1])
    .filter(Boolean);
  assert.equal(new Set(names).size, names.length, 'a table is declared twice');
  // Every index must belong to a table declared in the same array, otherwise a
  // fresh database would fail on `CREATE INDEX` before its table exists.
  for (const sql of SCHEMA) {
    const match = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [a-z_]+ ON ([a-z_]+)/.exec(sql);
    if (match) assert.ok(names.includes(match[1]), `index on unknown table ${match[1]}`);
  }
});

test('deleting an account erases its social graph but leaves other accounts alone', async () => {
  const app = await createApp();
  await registerUser(app, 'gone1', 'correct-horse-1', 'gone');
  await registerUser(app, 'stay1', 'correct-horse-1', 'stay');
  await registerUser(app, 'third', 'correct-horse-1', 'third');
  const gone = Number((await app.db.get('SELECT id FROM users WHERE username_key = ?', ['gone1'])).id);
  const stay = Number((await app.db.get('SELECT id FROM users WHERE username_key = ?', ['stay1'])).id);
  const third = Number((await app.db.get('SELECT id FROM users WHERE username_key = ?', ['third'])).id);
  const now = Math.floor(Date.now() / 1000);

  await app.db.batch([
    { sql: 'INSERT INTO profiles (user_id, display_name) VALUES (?, ?)', params: [gone, 'Gone'] },
    { sql: 'INSERT INTO profiles (user_id, display_name) VALUES (?, ?)', params: [stay, 'Stay'] },
    { sql: 'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)', params: [gone, stay, now] },
    { sql: 'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)', params: [stay, gone, now] },
    // A follow that involves nobody deleted must survive untouched.
    { sql: 'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)', params: [stay, third, now] },
    { sql: 'INSERT INTO bookmarks (user_id, paste_id, created_at) VALUES (?, ?, ?)', params: [gone, 'AAAAAAAA', now] },
    { sql: 'INSERT INTO reactions (user_id, paste_id, reaction, created_at) VALUES (?, ?, ?, ?)', params: [gone, 'AAAAAAAA', '❤️', now] },
    { sql: 'INSERT INTO notifications (id, recipient_user_id, type, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?)', params: ['n1', gone, 'follow', stay, now] },
    { sql: 'INSERT INTO notifications (id, recipient_user_id, type, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?)', params: ['n2', stay, 'follow', gone, now] },
    { sql: 'INSERT INTO tags (id, label, created_at) VALUES (?, ?, ?)', params: ['t1', 'Founder', now] },
    { sql: 'INSERT INTO user_tags (user_id, tag_id) VALUES (?, ?)', params: [gone, 't1'] },
  ]);

  const result = await destroyUser(app.db, gone);
  assert.equal(result.pastes, 0);

  /** @type {Array<[string, string, number[]]>} */
  const cleanupChecks = [
    ['profiles', 'user_id = ?', [gone]],
    ['follows', 'follower_id = ? OR following_id = ?', [gone, gone]],
    ['bookmarks', 'user_id = ?', [gone]],
    ['reactions', 'user_id = ?', [gone]],
    ['notifications', 'recipient_user_id = ? OR actor_user_id = ?', [gone, gone]],
    ['user_tags', 'user_id = ?', [gone]],
  ];
  for (const [table, clause, params] of cleanupChecks) {
    const row = await app.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${clause}`, params);
    assert.equal(Number(row.n), 0, `${table} still references the deleted account`);
  }

  // The surviving account keeps its own rows, and the tag itself survives as
  // an admin-curated object (only the assignment is deleted).
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?', [stay])).n), 1);
  // stay → third survives; stay → gone (and gone → stay) do not.
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', [stay])).n), 1);
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ? AND following_id = ?', [stay, third])).n), 1);
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM follows')).n), 1);
  // The follow notification where `stay` is only the actor is gone too: the
  // actor is part of the graph.
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ?', [stay])).n), 0);
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM notifications')).n), 0);
  assert.equal(Number((await app.db.get('SELECT COUNT(*) AS n FROM tags')).n), 1);
  await app.close();
});

test('profile counters and pinned-first listings read the new tables', async () => {
  const app = await createApp();
  await registerUser(app, 'prof1', 'correct-horse-1', 'prof');
  const id = Number((await app.db.get('SELECT id FROM users WHERE username_key = ?', ['prof1'])).id);
  const now = Math.floor(Date.now() / 1000);

  await app.db.batch([
    { sql: 'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)', params: [id, id + 1, now] },
    { sql: 'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)', params: [id + 1, id, now] },
    { sql: 'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)', params: [id + 2, id, now] },
    { sql: 'INSERT INTO reactions (user_id, paste_id, reaction, created_at) VALUES (?, ?, ?, ?)', params: [id, 'AAAAAAAA', '🔥', now] },
  ]);
  const counts = await profileCounts(app.db, id);
  assert.deepEqual(counts, { followers: 2, following: 1, pastes: 0, reactions: 1 });

  await app.db.batch([
    { sql: `INSERT INTO pastes (id, title, content, size, created_at, updated_at, visibility, pinned, user_id) VALUES (?, ?, ?, ?, ?, ?, 'public', 0, ?)`,
      params: ['BBBBBBBB', 'newer.txt', 'b', 1, now, now, id] },
    { sql: `INSERT INTO pastes (id, title, content, size, created_at, updated_at, visibility, pinned, user_id) VALUES (?, ?, ?, ?, ?, ?, 'public', 1, ?)`,
      params: ['CCCCCCCC', 'pinned.txt', 'c', 1, now - 3600, now - 3600, id] },
  ]);
  const listed = await listPinnedPublicPastes(app.db, id, 10, now);
  assert.deepEqual(listed.map((paste) => paste.id), ['CCCCCCCC', 'BBBBBBBB'], 'pinned paste comes first');
  assert.equal((await profileCounts(app.db, id)).pastes, 2);
  await app.close();
});

test('username policy: historic handles, the wider rule, and reserved names', () => {
  // Every shape that exists in a pre-merge database stays valid.
  for (const legacy of ['abcd', 'alice1', 'edge42', 'zzzq9', 'owner']) {
    const result = validateUsername(legacy);
    assert.equal(result.ok, true, `legacy handle ${legacy} must remain valid`);
    assert.equal(result.value, legacy);
  }
  // The wider rule: 3–20, letters/digits/underscore.
  assert.equal(validateUsername('abc').ok, true);
  assert.equal(validateUsername('x_9').ok, true);
  assert.equal(validateUsername('a'.repeat(20)).ok, true);
  assert.deepEqual(validateUsername('  spaced  ').value, 'spaced');
  // Rejections.
  assert.equal(validateUsername('ab').ok, false, 'too short');
  assert.equal(validateUsername('a'.repeat(21)).ok, false, 'too long');
  for (const bad of ['ab-cd', 'ab.cd', 'ab cd', 'ab@cd', 'ab/cd', '']) {
    assert.equal(validateUsername(bad).ok, false, `must reject ${JSON.stringify(bad)}`);
  }
  // Reserved names are case-insensitive so `ADMIN` cannot slip through.
  for (const reserved of ['admin', 'Admin', 'ADMIN', 'api', 'support', 'mantisbin', 'profile']) {
    const result = validateUsername(reserved);
    assert.equal(result.ok, false, `must reserve ${reserved}`);
    assert.match(result.error, /reserved/);
  }
  // The 1–2 character route words never reach the reserved list: the minimum
  // length rejects them first, which is why they are not enumerated there.
  for (const short of ['me', 'u', 'p']) {
    const result = validateUsername(short);
    assert.equal(result.ok, false, `must reject ${short}`);
    assert.match(result.error, /3–20/);
  }
});

test('registration rejects a reserved name through the real route', async () => {
  const app = await createApp();
  const res = await app.request('/register', { body: form({ username: 'Admin', password: 'longenough1' }) });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /reserved/);
  await app.close();
});
