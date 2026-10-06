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
    created_at   INTEGER NOT NULL,
    suspended_at INTEGER
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
    visibility    TEXT    NOT NULL DEFAULT 'unlisted',
    -- Optional thumbnail (2.4): a URL on an allowed image host, never bytes.
    -- The image is public even when the paste is protected — see lib/thumbnail.js.
    thumbnail_url TEXT
  )`,
  // Listing a user's pastes, newest first.
  `CREATE INDEX IF NOT EXISTS idx_pastes_user_created ON pastes (user_id, created_at DESC)`,
  // Administrator metadata pagination and retained-paste date summaries.
  `CREATE INDEX IF NOT EXISTS idx_pastes_created ON pastes (created_at DESC, id DESC)`,
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

  // Admin access is separate from ordinary accounts. Only session hashes persist.
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    credential_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket   TEXT    PRIMARY KEY,
    count    INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits (reset_at)`,

  // -------------------------------------------------------------------------
  // Social + profile layer (merged from VibeBin).
  //
  // Same conventions as everything above: unix seconds, no foreign-key
  // cascades (Turso/libSQL does not guarantee `PRAGMA foreign_keys`, so
  // related rows are deleted explicitly — see deleteUserGraph() in
  // lib/social.js and destroyUser() in lib/auth.js), and every list query
  // backed by an index.
  // -------------------------------------------------------------------------

  // Opt-in profile customisation. One row per account, created lazily on the
  // first edit, so accounts that never customise anything cost nothing. All
  // media is a remote URL — the database never stores image bytes.
  `CREATE TABLE IF NOT EXISTS profiles (
    user_id          INTEGER PRIMARY KEY,
    display_name     TEXT,
    bio              TEXT    NOT NULL DEFAULT '',
    bio_enabled      INTEGER NOT NULL DEFAULT 1,
    banner_url       TEXT,
    banner_type      TEXT    NOT NULL DEFAULT 'image',
    accent           TEXT    NOT NULL DEFAULT '#8b5cf6',
    name_effect      TEXT    NOT NULL DEFAULT 'none',
    effect_speed     INTEGER NOT NULL DEFAULT 50,
    effect_intensity INTEGER NOT NULL DEFAULT 60,
    status_emoji     TEXT    NOT NULL DEFAULT '',
    status_text      TEXT    NOT NULL DEFAULT '',
    links            TEXT    NOT NULL DEFAULT '[]',
    views            INTEGER NOT NULL DEFAULT 0
  )`,

  // Directed follow graph. The composite primary key makes a duplicate follow
  // impossible; self-follows are rejected in the library layer.
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id  INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (follower_id, following_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_follows_following ON follows (following_id)`,
  `CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id)`,

  // Saved pastes. One row per (account, paste): the composite primary key is
  // the dedupe, and deleting a paste removes its bookmarks explicitly.
  `CREATE TABLE IF NOT EXISTS bookmarks (
    user_id    INTEGER NOT NULL,
    paste_id   TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, paste_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_paste ON bookmarks (paste_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_user_created ON bookmarks (user_id, created_at DESC)`,

  // ONE reaction per account per paste (composite primary key). `reaction`
  // holds the canonical value only — a unicode emoji or a sticker token such
  // as ':wave:' — never rendered HTML.
  `CREATE TABLE IF NOT EXISTS reactions (
    user_id    INTEGER NOT NULL,
    paste_id   TEXT    NOT NULL,
    reaction   TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, paste_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reactions_paste ON reactions (paste_id, reaction)`,
  `CREATE INDEX IF NOT EXISTS idx_reactions_paste_user ON reactions (paste_id, user_id)`,

  // One row per recipient per event. `dedupe_key` is the idempotency handle:
  // the unique index collapses a repeated event into one notification (SQLite
  // treats NULLs as distinct, so rows without a key are never collapsed).
  `CREATE TABLE IF NOT EXISTS notifications (
    id                TEXT    PRIMARY KEY,
    recipient_user_id INTEGER NOT NULL,
    type              TEXT    NOT NULL,
    actor_user_id     INTEGER,
    paste_id          TEXT,
    title             TEXT    NOT NULL DEFAULT '',
    message           TEXT    NOT NULL DEFAULT '',
    link              TEXT,
    dedupe_key        TEXT,
    is_read           INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications (recipient_user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (recipient_user_id, is_read, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_paste ON notifications (paste_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications (dedupe_key)`,

  // The curated sticker pack shown by the editor. `token` is what an author
  // types (`:wave:`), `url` is a remote image (or NULL), `emoji` is the
  // offline fallback rendered when no url is set or the host is unreachable.
  `CREATE TABLE IF NOT EXISTS stickers (
    id         TEXT PRIMARY KEY,
    token      TEXT NOT NULL UNIQUE,
    url        TEXT,
    emoji      TEXT,
    label      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,

  // Administrator-awarded profile tags.
  `CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#a78bfa',
    effect     TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_tags (
    user_id    INTEGER NOT NULL,
    tag_id     TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_tags_tag ON user_tags (tag_id)`,

  // Profile view log, the same shape and dedupe window as `paste_views`: one
  // row per (profile, visitor hash) inside the window keeps a refresh from
  // inflating the counter, and `pruneViewLog` trims old rows.
  `CREATE TABLE IF NOT EXISTS profile_views (
    user_id    INTEGER NOT NULL,
    visitor    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_views_unique ON profile_views (user_id, visitor)`,
  // Pruning walks this table by age; mirrors `idx_paste_views_created`.
  `CREATE INDEX IF NOT EXISTS idx_profile_views_created ON profile_views (created_at)`,
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
  // 2.4 — optional thumbnail. Nullable: every existing paste has none.
  { table: 'pastes', column: 'thumbnail_url', sql: 'ALTER TABLE pastes ADD COLUMN thumbnail_url TEXT' },
  { table: 'users', column: 'suspended_at', sql: 'ALTER TABLE users ADD COLUMN suspended_at INTEGER' },
  // Merge phase 0 — line-level rich formatting for rich pastes.
  //
  // `content` STAYS the exact text (source of truth): /raw, download, QR,
  // fork, expiry, burn and the password gate all keep working on a plain
  // string. `formatting` is an optional JSON overlay of *display* hints keyed
  // by line number ({ v: 1, lines: [{ line, font, size, color, stickerUrls }] })
  // so a paste without it renders byte-identically to today. NULL = plain.
  { table: 'pastes', column: 'formatting', sql: 'ALTER TABLE pastes ADD COLUMN formatting TEXT' },
  // Merge phase 2 — per-paste title colour + profile pinning.
  { table: 'pastes', column: 'title_color', sql: 'ALTER TABLE pastes ADD COLUMN title_color TEXT' },
  { table: 'pastes', column: 'pinned', sql: 'ALTER TABLE pastes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0' },
  // Merge phase 2 — tag awards need an order (oldest first) so the profile can
  // show them the way they were granted.
  { table: 'user_tags', column: 'created_at', sql: 'ALTER TABLE user_tags ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0' },
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
  // Pinned-first ordering on a profile (pinned is added by MIGRATIONS above,
  // so this index can only be created after the column exists).
  `CREATE INDEX IF NOT EXISTS idx_pastes_profile_order ON pastes (user_id, visibility, pinned DESC, created_at DESC)`,
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
