/**
 * Schema migrations.
 *
 * Production already holds a `pastes` table from the 2.0/2.1 code, and
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table — so a missing
 * migration fails loudly in production and silently in tests. These tests build
 * the *old* table shape first, then run `ensureSchema` on top of it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureSchema } from '../src/db/schema.js';
import { createNodeDb } from '../src/db/node-sqlite.js';

/** The `pastes` table exactly as deployed before 2.2 §1. */
const PRE_22_PASTES = `CREATE TABLE pastes (
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
)`;

async function columns(db, table) {
  const rows = await db.all(`SELECT name FROM pragma_table_info('${table}')`);
  return rows.map((row) => String(row.name));
}

test('a fresh database has every column the app expects', async () => {
  const db = createNodeDb(':memory:');
  await ensureSchema(db);
  for (const column of ['password_hash', 'burn_mode', 'burned', 'visibility']) {
    assert.ok((await columns(db, 'pastes')).includes(column), `pastes.${column}`);
  }
  await db.close();
});

test('an existing pre-2.2 database is migrated in place, idempotently', async () => {
  const db = createNodeDb(':memory:');
  await db.run(PRE_22_PASTES);
  await db.run(
    "INSERT INTO pastes (id, title, content, language, font, font_size, size, views, created_at, updated_at) VALUES ('oldRow01', 'pre-2.2 paste', 'old body', 'python', 'mono', 14, 8, 3, 1, 1)",
  );

  await ensureSchema(db);
  for (const column of ['password_hash', 'burn_mode', 'burned', 'visibility']) {
    assert.ok((await columns(db, 'pastes')).includes(column), `pastes.${column} is added`);
  }
  const row = await db.get('SELECT title, content, views, password_hash, burn_mode, burned FROM pastes WHERE id = ?', ['oldRow01']);
  assert.equal(row.title, 'pre-2.2 paste', 'existing rows survive the migration');
  assert.equal(row.views, 3);
  assert.equal(row.password_hash, null, 'unprotected by default');
  assert.equal(row.burn_mode, 'never', 'existing pastes do not start burning');
  assert.equal(row.burned, 0);

  // Every later cold start repeats the run: it must stay a no-op.
  await ensureSchema(db);
  await ensureSchema(db);
  for (const column of ['password_hash', 'burn_mode', 'burned', 'visibility']) {
    assert.equal((await columns(db, 'pastes')).filter((name) => name === column).length, 1, `${column} is never duplicated`);
  }

  // The migrated table accepts a protected paste.
  await db.run(
    'INSERT INTO pastes (id, title, content, created_at, updated_at, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
    ['newRow02', 'protected', 'new body', 2, 2, 'pbkdf2-sha256$100000$c2FsdA$aGFzaA'],
  );
  assert.match(
    String((await db.get('SELECT password_hash FROM pastes WHERE id = ?', ['newRow02'])).password_hash),
    /^pbkdf2-sha256\$/,
  );
  await db.close();
});
