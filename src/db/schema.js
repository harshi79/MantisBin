/**
 * Database schema (SQLite / libSQL).
 *
 * Notes:
 *  - All timestamps are unix epoch seconds (INTEGER). No strftime in queries, so
 *    the same SQL works on Turso, libSQL and Node's built-in SQLite.
 *  - No foreign-key cascades: Turso/libSQL does not guarantee `PRAGMA foreign_keys`,
 *    so related rows are deleted explicitly.
 *  - Content is stored inline. Pastes are read by primary key, which keeps the
 *    hot path to a single indexed lookup.
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT    NOT NULL,
    username_key TEXT    NOT NULL UNIQUE,
    password     TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip_hash    TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at)`,

  `CREATE TABLE IF NOT EXISTS pastes (
    id            TEXT    PRIMARY KEY,
    title         TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    language      TEXT    NOT NULL DEFAULT 'plaintext',
    font          TEXT    NOT NULL DEFAULT 'mono',
    font_size     INTEGER NOT NULL DEFAULT 14,
    size          INTEGER NOT NULL DEFAULT 0,
    views         INTEGER NOT NULL DEFAULT 0,
    user_id       INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    expires_at    INTEGER,
    -- Optional passphrase: only ever the PBKDF2 hash, never the passphrase.
    password_hash TEXT,
    -- Burn after reading (2.2 §2): 'never' | 'view' | 'read', plus the flag that
    -- arbitrates the single allowed read between concurrent requests.
    burn_mode     TEXT    NOT NULL DEFAULT 'never',
    burned        INTEGER NOT NULL DEFAULT 0,
    -- Visibility: 'unlisted' (link-only, the default) or 'public' (listed on
    -- the owner's opt-in profile page). Anonymous pastes are always unlisted.
    visibility    TEXT    NOT NULL DEFAULT 'unlisted'
  )`,
  // Listing a user's pastes, newest first.
  `CREATE INDEX IF NOT EXISTS idx_pastes_user_created ON pastes (user_id, created_at DESC)`,
  // Expiration sweeps.
  `CREATE INDEX IF NOT EXISTS idx_pastes_expires ON pastes (expires_at)`,

  `CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    key_hash     TEXT    NOT NULL UNIQUE,
    prefix       TEXT    NOT NULL,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`,

  // One row per (paste, pseudonymous visitor) inside the dedupe window.
  `CREATE TABLE IF NOT EXISTS paste_views (
    paste_id   TEXT    NOT NULL,
    visitor    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (paste_id, visitor)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_paste_views_created ON paste_views (created_at)`,

  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket   TEXT    PRIMARY KEY,
    count    INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits (reset_at)`,
];

/**
 * Additive migrations for databases that already exist in production.
 * `CREATE TABLE IF NOT EXISTS` never touches an existing table, so every new
 * column needs its own `ALTER TABLE`. The column list is read first, so a
 * migrated database costs one cheap PRAGMA per cold start and nothing else.
 *
 * Keep this list append-only: migrations are never edited or removed.
 */
const MIGRATIONS = [
  // 2.2 §1 — optional per-paste passphrase.
  { table: 'pastes', column: 'password_hash', sql: 'ALTER TABLE pastes ADD COLUMN password_hash TEXT' },
  // 2.2 §2 — burn after reading.
  { table: 'pastes', column: 'burn_mode', sql: "ALTER TABLE pastes ADD COLUMN burn_mode TEXT NOT NULL DEFAULT 'never'" },
  { table: 'pastes', column: 'burned', sql: 'ALTER TABLE pastes ADD COLUMN burned INTEGER NOT NULL DEFAULT 0' },
  // Profiles — per-paste visibility. Existing pastes stay unlisted.
  { table: 'pastes', column: 'visibility', sql: "ALTER TABLE pastes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'unlisted'" },
];

function isDuplicateColumn(error) {
  return /duplicate column name/i.test(String(error?.message || error || ''));
}

/** Column names of a table, or an empty set when the table does not exist yet. */
async function tableColumns(db, table) {
  const rows = await db.all(`SELECT name FROM pragma_table_info('${table}')`);
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * Indexes on migrated columns. These must run *after* MIGRATIONS: a pre-2.2
 * table has no `visibility` column yet, so creating this index up front in
 * SCHEMA would fail the migration it is meant to serve.
 */
const POST_MIGRATION_SCHEMA = [
  // Public profile pages: one owner's public pastes, newest first.
  `CREATE INDEX IF NOT EXISTS idx_pastes_public ON pastes (user_id, visibility, created_at DESC)`,
];

/** Idempotent — safe to run on every cold start / dev boot. */
export async function ensureSchema(db) {
  await db.batch(SCHEMA.map((sql) => ({ sql })));
  /** @type {Map<string, Set<string>>} */
  const columns = new Map();
  for (const migration of MIGRATIONS) {
    if (!columns.has(migration.table)) columns.set(migration.table, await tableColumns(db, migration.table));
    if (columns.get(migration.table)?.has(migration.column)) continue;
    try {
      await db.run(migration.sql);
    } catch (error) {
      // Two isolates cold-starting at once: the loser sees "duplicate column name".
      if (!isDuplicateColumn(error)) throw error;
    }
  }
  await db.batch(POST_MIGRATION_SCHEMA.map((sql) => ({ sql })));
}
