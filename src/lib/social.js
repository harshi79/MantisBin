/**
 * Social + profile layer (merged from VibeBin).
 *
 * Phase 0 owns the *data lifecycle* rules that must hold from the moment the
 * new tables exist, before any feature writes to them:
 *
 *  - Deleting an account removes everything that pointed at it. MantisBin
 *    deliberately avoids `ON DELETE CASCADE` (Turso/libSQL does not guarantee
 *    `PRAGMA foreign_keys`), so cleanup is explicit and lives here — one
 *    place, called from both the self-service path (`destroyUser`) and the
 *    administrator path.
 *
 * Feature code (follows, bookmarks, reactions, notifications, stickers,
 * tags, profile customisation) is added to this module as each merge phase
 * lands, so there is exactly one owner for the social tables.
 */

import { REACTIONS, REACTION_EMOJIS, SOCIAL } from '../config.js';
import { randomToken } from './crypto.js';
import { PASTE_META_COLUMNS, pasteMetaColumns } from './pastes.js';

/** @typedef {import('../db/turso.js').Db} Db */
/** @typedef {{ sql: string, params?: unknown[] }} Statement */

/**
 * Statements that erase every social row belonging to one account.
 *
 * `user_id` is the account being deleted. Follows, bookmarks, reactions,
 * tags, profile customisation and notifications (both as recipient and as
 * actor) all go. Pastes are *not* touched here — the caller decides whether
 * they are deleted or anonymised.
 *
 * @param {number} userId
 * @returns {Statement[]}
 */
export function userGraphStatements(userId) {
  const id = Number(userId);
  return [
    { sql: 'DELETE FROM follows WHERE follower_id = ? OR following_id = ?', params: [id, id] },
    { sql: 'DELETE FROM bookmarks WHERE user_id = ?', params: [id] },
    { sql: 'DELETE FROM reactions WHERE user_id = ?', params: [id] },
    { sql: 'DELETE FROM notifications WHERE recipient_user_id = ? OR actor_user_id = ?', params: [id, id] },
    { sql: 'DELETE FROM user_tags WHERE user_id = ?', params: [id] },
    { sql: 'DELETE FROM profiles WHERE user_id = ?', params: [id] },
  ];
}

/**
 * Live counters shown beside a profile.
 *
 * `views` is the profile's own counter; the rest are read live so a follower
 * count can never drift from the rows it is derived from.
 * @param {Db} db
 * @param {number} userId
 * @returns {Promise<{ followers: number, following: number, pastes: number, reactions: number }>}
 */
export async function profileCounts(db, userId) {
  const id = Number(userId);
  const [followers, following, pastes, reactions] = await Promise.all([
    db.get('SELECT COUNT(*) AS n FROM follows WHERE following_id = ?', [id]),
    db.get('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', [id]),
    db.get(`SELECT COUNT(*) AS n FROM pastes WHERE user_id = ? AND visibility = 'public'`, [id]),
    db.get('SELECT COUNT(*) AS n FROM reactions WHERE user_id = ?', [id]),
  ]);
  return {
    followers: Number(followers?.n ?? 0),
    following: Number(following?.n ?? 0),
    pastes: Number(pastes?.n ?? 0),
    reactions: Number(reactions?.n ?? 0),
  };
}

/**
 * Public pastes for a profile, pinned first then newest first.
 *
 * Deliberately metadata-only (never `content`) and identical in shape to the
 * existing `listPublicPastes`, so the current profile page and `/api/users/…`
 * keep working unchanged while gaining pinning.
 * @param {Db} db
 * @param {number} userId
 * @param {number} limit
 * @param {number} now
 */
export async function listPinnedPublicPastes(db, userId, limit = 100, now = Math.floor(Date.now() / 1000)) {
  return db.all(
    `SELECT ${PASTE_META_COLUMNS} FROM pastes
      WHERE user_id = ? AND visibility = 'public'
        AND (expires_at IS NULL OR expires_at > ?) AND burned = 0
      ORDER BY pinned DESC, created_at DESC LIMIT ?`,
    [Number(userId), now, Math.min(Math.max(limit, 1), 500)],
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — profile customisation
// ---------------------------------------------------------------------------

/**
 * Read a profile row. Every account has a profile the moment it needs one —
 * `ensureProfile` creates it with column defaults, so this returns `null` only
 * for an account that does not exist.
 * @param {Db} db
 * @param {number} userId
 */
export async function getProfile(db, userId) {
  const row = await db.get('SELECT * FROM profiles WHERE user_id = ?', [Number(userId)]);
  return row ?? null;
}

/**
 * Create the (empty) profile row if it is missing, then return it. Idempotent:
 * concurrent calls collapse on the primary key and the read that follows always
 * returns the same row.
 * @param {Db} db
 * @param {number} userId
 */
export async function ensureProfile(db, userId) {
  const id = Number(userId);
  const existing = await getProfile(db, id);
  if (existing) return existing;
  // Defaults come from the table definition, so this insert carries only what
  // it must. `INSERT OR IGNORE` makes it safe under concurrency.
  await db.run('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)', [id]);
  return (await getProfile(db, id)) ?? null;
}

/**
 * Store the customiser values. The caller has already validated them
 * (`readProfileInput`), so this writes exactly the columns it is given.
 * @param {Db} db
 * @param {number} userId
 * @param {any} values
 */
export async function saveProfile(db, userId, values) {
  const id = Number(userId);
  await ensureProfile(db, id);
  await db.run(
    `UPDATE profiles SET
        display_name = ?, bio = ?, bio_enabled = ?, banner_url = ?, banner_type = ?,
        accent = ?, name_effect = ?, effect_speed = ?, effect_intensity = ?,
        status_emoji = ?, status_text = ?, links = ?
      WHERE user_id = ?`,
    [
      values.displayName || null,
      values.bio ?? '',
      values.bioEnabled === false ? 0 : 1,
      values.bannerUrl || null,
      values.bannerType ?? 'image',
      values.accent,
      values.nameEffect,
      Number(values.effectSpeed ?? 50),
      Number(values.effectIntensity ?? 60),
      values.statusEmoji ?? '',
      values.statusText ?? '',
      JSON.stringify(values.links ?? []),
      id,
    ],
  );
  return getProfile(db, id);
}

/**
 * Count one profile view per visitor, with the same dedupe window and the same
 * pseudonymised visitor hash as paste views (`visitorHash` in `pastes.js`):
 * `profile_views` holds one row per (profile, visitor) inside the window, so a
 * refresh does not inflate the counter and no raw address is ever stored.
 *
 * The stored counter lives in `profiles.views`; the row is inserted first, so
 * the counter and the log can never disagree about whether a view counted.
 * @param {Db} db
 * @param {number} userId
 * @param {string} visitor
 * @param {number} now
 * @param {number} windowSeconds
 */
export async function recordProfileView(db, userId, visitor, now, windowSeconds) {
  const id = Number(userId);
  await ensureProfile(db, id);
  const since = now - windowSeconds;
  const seen = await db.get(
    'SELECT 1 AS seen FROM profile_views WHERE user_id = ? AND visitor = ? AND created_at > ?',
    [id, visitor, since],
  );
  if (seen) {
    const row = await db.get('SELECT views FROM profiles WHERE user_id = ?', [id]);
    return Number(row?.views ?? 0);
  }
  await db.batch([
    { sql: 'DELETE FROM profile_views WHERE user_id = ? AND visitor = ?', params: [id, visitor] },
    { sql: 'INSERT INTO profile_views (user_id, visitor, created_at) VALUES (?, ?, ?)', params: [id, visitor, now] },
    { sql: 'UPDATE profiles SET views = views + 1 WHERE user_id = ?', params: [id] },
  ]);
  const updated = await db.get('SELECT views FROM profiles WHERE user_id = ?', [id]);
  return Number(updated?.views ?? 0);
}

/** Tags awarded to one account, oldest award first. */
export async function listUserTags(db, userId) {
  try {
    return await db.all(
      `SELECT t.id AS id, t.label AS label, t.color AS color, t.effect AS effect, ut.created_at AS awarded_at
         FROM user_tags ut JOIN tags t ON t.id = ut.tag_id
        WHERE ut.user_id = ?
        ORDER BY ut.created_at ASC`,
      [Number(userId)],
    );
  } catch {
    // A database that predates the tag tables simply shows no tags.
    return [];
  }
}

/** Every tag in the catalogue, for the admin picker. */
export async function listTags(db) {
  try {
    return await db.all('SELECT id, label, color, effect, created_at FROM tags ORDER BY label COLLATE NOCASE ASC');
  } catch {
    return [];
  }
}

/**
 * Award a tag, creating the catalogue row on first use. `label` is the
 * operator's name for it; the id is derived from it, so awarding "Beta tester"
 * twice reuses the same tag.
 * @param {Db} db
 * @param {{ id: string, label: string, color: string, effect?: string }} tag
 * @param {number} now
 */
export async function upsertTag(db, tag, now = Math.floor(Date.now() / 1000)) {
  await db.run(
    `INSERT INTO tags (id, label, color, effect, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, color = excluded.color, effect = excluded.effect`,
    [tag.id, tag.label, tag.color, tag.effect ?? '', now],
  );
}

/** Award a tag to an account (idempotent). */
export async function awardTag(db, userId, tagId, now = Math.floor(Date.now() / 1000)) {
  await db.run('INSERT OR IGNORE INTO user_tags (user_id, tag_id, created_at) VALUES (?, ?, ?)', [
    Number(userId),
    tagId,
    now,
  ]);
}

/** Remove one tag from one account. Returns how many rows were deleted. */
export async function revokeTag(db, userId, tagId) {
  const result = await db.run('DELETE FROM user_tags WHERE user_id = ? AND tag_id = ?', [
    Number(userId),
    String(tagId),
  ]);
  return Number(result?.changes ?? 0);
}

/** Delete a tag everywhere (catalogue row and every award of it). */
export async function deleteTag(db, tagId) {
  await db.run('DELETE FROM user_tags WHERE tag_id = ?', [String(tagId)]);
  await db.run('DELETE FROM tags WHERE id = ?', [String(tagId)]);
}

/**
 * How many accounts exist and where this one sits — the input to the "OG
 * member" badge. Counted rather than stored, so it is always current.
 * @param {Db} db
 * @param {number} userId
 */
export async function accountRank(db, userId) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM users WHERE created_at <= (SELECT created_at FROM users WHERE id = ?)',
    [Number(userId)],
  );
  const n = Number(row?.n ?? 0);
  return n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Phase 3 — follows, bookmarks, reactions, notifications
//
// Ported from VibeBin's follow/bookmark/reaction/notification services, with
// MantisBin's rules applied to every one of them:
//
//  * **Accounts only.** There is no anonymous follow, bookmark or reaction
//    (VibeBin allowed anonymous likes keyed by IP hash). A social action always
//    has an owner who can be held to it, and no raw address is ever stored.
//  * **Discovery stays opt-in.** A reaction is only possible on a *public*
//    paste, and the only notifications an author's followers ever receive are
//    for public, *unprotected* pastes. Unlisted and password-protected pastes
//    never produce a notification, so the feature cannot leak the existence of
//    a private paste.
//  * **One row per relationship.** Follows and bookmarks are keyed by their
//    natural primary key and written with `INSERT OR IGNORE`; a reaction is one
//    row per (account, paste) updated in place. Every write is idempotent, so a
//    double-click is never a double row.
//  * **Counts are computed, never stored.** `follows`/`reactions` are read with
//    indexed COUNT queries, so a counter can never drift from its rows.
//  * **Notifications never break the action.** They are written after the
//    operation they describe has already succeeded, and a failure there is
//    swallowed by the caller (`announcePublish` is always `.catch(() => 0)`),
//    so a notification bug can never roll back a follow or a paste.
//  * **Bounded work.** A fanout writes at most `SOCIAL.fanout` rows in chunked
//    batches, a bookmark list is capped per account, and read notifications are
//    pruned on a schedule.
// ---------------------------------------------------------------------------

/** The canonical reaction for an incoming value, or null when it is not in the palette. */
export function normalizeReaction(value) {
  const raw = String(value ?? '').normalize('NFC').trim();
  if (!raw) return null;
  // The buttons post the glyph; an API caller may post the stable id instead
  // (`fire` / `:fire:`), which is friendlier and cannot be mistyped.
  if (REACTION_EMOJIS.has(raw)) return raw;
  const name = raw.replace(/^[:;]|[:;]$/g, '').toLowerCase();
  return REACTIONS.find((entry) => entry.id === name)?.emoji ?? null;
}

/** Does this account follow that one? One indexed primary-key probe. */
export async function isFollowing(db, followerId, followingId) {
  const row = await db.get('SELECT 1 AS yes FROM follows WHERE follower_id = ? AND following_id = ?', [
    Number(followerId),
    Number(followingId),
  ]);
  return Boolean(row);
}

/**
 * Follow an account. Idempotent.
 *
 * Self-follows are refused with a reason rather than thrown, because the route
 * needs to answer them with a message.
 * @param {Db} db
 * @returns {Promise<{ ok: boolean, reason?: string, created?: boolean, followers?: number }>}
 */
export async function followUser(db, followerId, followingId, now = Math.floor(Date.now() / 1000)) {
  const follower = Number(followerId);
  const target = Number(followingId);
  if (!follower || !target) return { ok: false, reason: 'missing' };
  if (follower === target) return { ok: false, reason: 'self' };
  const result = await db.run('INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)', [
    follower,
    target,
    now,
  ]);
  const created = Number(result?.changes ?? 0) > 0;
  if (created) {
    // One follow notification per follower per account per day: enough to be
    // useful, immune to a follow/unfollow loop.
    const actor = await db.get('SELECT username FROM users WHERE id = ?', [follower]);
    if (actor) {
      await notify(db, {
        recipientUserId: target,
        type: 'follow',
        actorUserId: follower,
        title: `@${actor.username} started following you`,
        message: 'They will see your public pastes in their feed.',
        link: `/u/${actor.username}`,
        dedupeKey: `follow:${follower}:${target}:${Math.floor(now / 86400)}`,
        now,
      });
    }
  }
  return { ok: true, created, followers: await followerCount(db, target) };
}

/** Unfollow an account. Idempotent; unfollowing also clears the pending notification. */
export async function unfollowUser(db, followerId, followingId) {
  const follower = Number(followerId);
  const target = Number(followingId);
  await db.run('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [follower, target]);
  // A follow notification for a relationship that no longer exists is noise.
  await db.run('DELETE FROM notifications WHERE type = ? AND actor_user_id = ? AND recipient_user_id = ?', [
    'follow',
    follower,
    target,
  ]);
  return { ok: true, created: false, followers: await followerCount(db, target) };
}

/** Follower count for one account (indexed COUNT). */
export async function followerCount(db, userId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM follows WHERE following_id = ?', [Number(userId)]);
  return Number(row?.n ?? 0);
}

/**
 * One page of a follower/following list, newest relationship first.
 *
 * `viewerId` adds an `is_following` flag so a list can offer "Follow back"
 * without one query per row.
 * @param {Db} db
 * @param {number} userId
 * @param {'followers' | 'following'} direction
 */
export async function listFollows(db, userId, direction, { viewerId = null, limit = 50, offset = 0 } = {}) {
  const id = Number(userId);
  const viewer = viewerId ? Number(viewerId) : 0;
  const joinColumn = direction === 'followers' ? 'f.follower_id' : 'f.following_id';
  const whereColumn = direction === 'followers' ? 'f.following_id' : 'f.follower_id';
  const rows = await db.all(
    `SELECT u.id, u.username, u.created_at, f.created_at AS followed_at, p.display_name,
        p.accent, p.status_emoji, p.status_text,
        (SELECT COUNT(*) FROM pastes x WHERE x.user_id = u.id AND x.visibility = 'public') AS public_pastes,
        CASE WHEN ? THEN EXISTS(
          SELECT 1 FROM follows v WHERE v.follower_id = ? AND v.following_id = u.id
        ) ELSE 0 END AS is_following
      FROM follows f JOIN users u ON u.id = ${joinColumn}
      LEFT JOIN profiles p ON p.user_id = u.id
      WHERE ${whereColumn} = ?
      ORDER BY f.created_at DESC, u.id DESC LIMIT ? OFFSET ?`,
    [viewer, viewer, id, Math.min(Math.max(Number(limit) || 50, 1), 100), Math.max(0, Number(offset) || 0)],
  );
  return rows.map((row) => ({ ...row, is_following: Number(row.is_following) === 1 }));
}

/** Total rows behind a follower/following page. */
export async function countFollows(db, userId, direction) {
  const column = direction === 'followers' ? 'following_id' : 'follower_id';
  const row = await db.get(`SELECT COUNT(*) AS n FROM follows WHERE ${column} = ?`, [Number(userId)]);
  return Number(row?.n ?? 0);
}

/** Has this account saved that paste? */
export async function isBookmarked(db, userId, pasteId) {
  const row = await db.get('SELECT 1 AS yes FROM bookmarks WHERE user_id = ? AND paste_id = ?', [
    Number(userId),
    String(pasteId),
  ]);
  return Boolean(row);
}

/** How many pastes this account has saved. */
export async function countBookmarks(db, userId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?', [Number(userId)]);
  return Number(row?.n ?? 0);
}

/**
 * Save or unsave a paste. Idempotent, and capped per account.
 * @param {Db} db
 * @returns {Promise<{ ok: boolean, saved?: boolean, reason?: string, count?: number }>}
 */
export async function setBookmark(db, userId, pasteId, saved, now = Math.floor(Date.now() / 1000)) {
  const id = Number(userId);
  if (saved) {
    const count = await countBookmarks(db, id);
    if (count >= SOCIAL.bookmarks) return { ok: false, reason: 'limit' };
    await db.run('INSERT OR IGNORE INTO bookmarks (user_id, paste_id, created_at) VALUES (?, ?, ?)', [
      id,
      String(pasteId),
      now,
    ]);
  } else {
    await db.run('DELETE FROM bookmarks WHERE user_id = ? AND paste_id = ?', [id, String(pasteId)]);
  }
  const after = await countBookmarks(db, id);
  return { ok: true, saved: Boolean(saved), count: after };
}

/**
 * One page of an account's saved pastes, newest save first.
 *
 * Metadata only (never content), expired and burned pastes skipped, and a
 * protected paste keeps its title hidden — the bookmarker may have unlocked it
 * once, but a saved list is not a reason to publish someone's title.
 * @param {Db} db
 */
export async function listBookmarks(db, userId, { limit = 50, offset = 0, now = Math.floor(Date.now() / 1000) } = {}) {
  const rows = await db.all(
    `SELECT ${pasteMetaColumns('p')}, b.created_at AS saved_at,
        CASE WHEN p.password_hash IS NOT NULL AND p.password_hash != '' THEN 1 ELSE 0 END AS locked,
        u.username AS author
      FROM bookmarks b JOIN pastes p ON p.id = b.paste_id
      LEFT JOIN users u ON u.id = p.user_id
      WHERE b.user_id = ?
        AND (p.expires_at IS NULL OR p.expires_at > ?) AND p.burned = 0
      ORDER BY b.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    [
      Number(userId),
      now,
      Math.min(Math.max(Number(limit) || 50, 1), 100),
      Math.max(0, Number(offset) || 0),
    ],
  );
  return rows.map((row) => ({ ...row, locked: Number(row.locked) === 1 }));
}

/**
 * Set, change or clear this account's single reaction on a paste.
 *
 * `reaction` is a glyph from `REACTIONS` (validated by the caller) or null/'' to
 * clear. The composite primary key plus `ON CONFLICT DO UPDATE` makes "change
 * your mind" a single atomic statement, and the returned counts are read back
 * from the rows, so they cannot drift.
 * @param {Db} db
 */
export async function setReaction(db, userId, pasteId, reaction, now = Math.floor(Date.now() / 1000)) {
  const id = Number(userId);
  const value = normalizeReaction(reaction);
  if (!value) {
    await db.run('DELETE FROM reactions WHERE user_id = ? AND paste_id = ?', [id, String(pasteId)]);
  } else {
    await db.run(
      `INSERT INTO reactions (user_id, paste_id, reaction, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, paste_id) DO UPDATE SET reaction = excluded.reaction, created_at = excluded.created_at`,
      [id, String(pasteId), value, now],
    );
  }
  return reactionState(db, pasteId, id);
}

/** Per-reaction totals for a paste, most used first, plus this account's own reaction. */
export async function reactionState(db, pasteId, userId = null) {
  const rows = await db.all(
    'SELECT reaction, COUNT(*) AS n FROM reactions WHERE paste_id = ? GROUP BY reaction ORDER BY n DESC, reaction ASC',
    [String(pasteId)],
  );
  const counts = rows.map((row) => ({ reaction: String(row.reaction), count: Number(row.n ?? 0) }));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  let mine = null;
  if (userId) {
    const row = await db.get('SELECT reaction FROM reactions WHERE user_id = ? AND paste_id = ?', [
      Number(userId),
      String(pasteId),
    ]);
    mine = row ? String(row.reaction) : null;
  }
  return { counts, total, mine };
}

/**
 * Reaction totals for many pastes at once (list pages).
 * @param {Db} db
 * @param {string[]} pasteIds
 * @returns {Promise<Map<string, { counts: Array<{ reaction: string, count: number }>, total: number }>>}
 */
export async function reactionCountsFor(db, pasteIds) {
  const ids = [...new Set((pasteIds || []).map((id) => String(id)))].slice(0, 200);
  const out = new Map();
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT paste_id, reaction, COUNT(*) AS n FROM reactions WHERE paste_id IN (${placeholders})
      GROUP BY paste_id, reaction ORDER BY n DESC`,
    ids,
  );
  for (const row of rows) {
    const key = String(row.paste_id);
    const entry = out.get(key) || { counts: [], total: 0 };
    const count = Number(row.n ?? 0);
    entry.counts.push({ reaction: String(row.reaction), count });
    entry.total += count;
    out.set(key, entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Insert one notification, ignoring a repeat with the same `dedupe_key`.
 *
 * Self-notifications are dropped here rather than at each call site: an author
 * reacting to their own paste, or following themselves, is never news.
 * @param {Db} db
 * @returns {Promise<boolean>} true when a row was actually created
 */
export async function notify(db, input) {
  const recipient = Number(input.recipientUserId);
  if (!recipient) return false;
  const actor = input.actorUserId === undefined || input.actorUserId === null ? null : Number(input.actorUserId);
  if (actor !== null && actor === recipient) return false;
  const result = await db.run(
    `INSERT OR IGNORE INTO notifications
       (id, recipient_user_id, type, actor_user_id, paste_id, title, message, link, dedupe_key, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      randomToken(12),
      recipient,
      String(input.type || 'admin'),
      actor,
      input.pasteId ? String(input.pasteId) : null,
      String(input.title || '').slice(0, 200),
      String(input.message || '').slice(0, 300),
      input.link ? String(input.link).slice(0, 300) : null,
      input.dedupeKey ? String(input.dedupeKey).slice(0, 200) : null,
      Number(input.now ?? Math.floor(Date.now() / 1000)),
    ],
  );
  return Number(result?.changes ?? 0) > 0;
}

/**
 * Tell an author that somebody reacted to their paste.
 *
 * One notice per (paste, reactor) pair: the first reaction is the news, and a
 * later change of glyph would only repeat it — the paste page carries the live
 * count. Only public, unprotected, owned pastes qualify (exactly the publish
 * fanout rule), and `notify` drops a self-reaction.
 *
 * @param {Db} db
 * @param {{ id: string, title?: string, visibility?: string, password_hash?: string | null, user_id?: number | null }} paste
 * @param {{ id: number | string, username?: string }} actor
 * @returns {Promise<boolean>} true when a row was written
 */
export async function notifyReaction(db, paste, actor, emoji, now = Math.floor(Date.now() / 1000)) {
  if (!paste || paste.visibility !== 'public') return false;
  if (paste.password_hash) return false;
  if (!paste.user_id || !actor) return false;
  const actorId = Number(actor.id ?? actor);
  return notify(db, {
    recipientUserId: Number(paste.user_id),
    actorUserId: actorId,
    pasteId: paste.id,
    type: 'reaction',
    title: `@${actor.username || 'someone'} reacted to your paste`,
    message: `${emoji} ${String(paste.title || 'Untitled').slice(0, 160)}`,
    link: `/p/${paste.id}`,
    dedupeKey: `react:${paste.id}:${actorId}`,
    now,
  });
}

/**
 * Taking a reaction back withdraws the unread notice with it — the same
 * courtesy `unfollowUser` extends, and never a notice the author already read.
 * @param {Db} db
 */
export async function clearReactionNotice(db, pasteId, actorId) {
  const result = await db.run('DELETE FROM notifications WHERE dedupe_key = ? AND is_read = 0', [
    `react:${String(pasteId)}:${Number(actorId)}`,
  ]);
  return Number(result?.changes ?? 0) > 0;
}

/**
 * Tell an author's followers that a public paste exists.
 *
 * Never called for unlisted or password-protected pastes, never for anonymous
 * pastes, and always awaited with `.catch(() => 0)` by the caller: a fanout is
 * a courtesy, not part of the write the user asked for. The dedupe key is
 * per-paste per-recipient, so re-publishing (edit → public again) cannot spam.
 *
 * @param {Db} db
 * @param {{ id: string, title: string, visibility?: string, password_hash?: string | null, user_id?: number | null }} paste
 * @returns {Promise<number>} notifications written
 */
export async function announcePublish(db, paste, now = Math.floor(Date.now() / 1000)) {
  if (!paste || paste.visibility !== 'public') return 0;
  if (paste.password_hash) return 0;
  if (!paste.user_id) return 0;
  const authorId = Number(paste.user_id);
  const author = await db.get('SELECT username FROM users WHERE id = ?', [authorId]);
  if (!author) return 0;
  const followers = await db.all('SELECT follower_id FROM follows WHERE following_id = ? ORDER BY created_at DESC LIMIT ?', [
    authorId,
    SOCIAL.fanout,
  ]);
  if (!followers.length) return 0;
  const title = `@${author.username} published a paste`;
  const message = String(paste.title || 'Untitled').slice(0, 200);
  let written = 0;
  // Chunked: a popular account's publish must not become one enormous
  // transaction on Turso.
  for (let index = 0; index < followers.length; index += 100) {
    const chunk = followers.slice(index, index + 100);
    const statements = chunk.map((row) => ({
      sql: `INSERT OR IGNORE INTO notifications
              (id, recipient_user_id, type, actor_user_id, paste_id, title, message, link, dedupe_key, is_read, created_at)
            VALUES (?, ?, 'new_paste', ?, ?, ?, ?, ?, ?, 0, ?)`,
      params: [
        randomToken(12),
        Number(row.follower_id),
        authorId,
        String(paste.id),
        title,
        message,
        `/p/${paste.id}`,
        `new:${paste.id}:${Number(row.follower_id)}`,
        now,
      ],
    }));
    await db.batch(statements);
    written += statements.length;
  }
  return written;
}

/**
 * How many accounts a broadcast would reach (suspended accounts are skipped:
 * they cannot sign in, so a notice for them is only storage).
 */
export async function countBroadcastRecipients(db) {
  const row = await db.get('SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NULL');
  return Number(row?.n ?? 0);
}

/**
 * Send one announcement to every active account.
 *
 * The operator's own words, so the only work here is bounding the blast: the
 * audience is capped (`SOCIAL.broadcastMax`), the writes are chunked 100 rows
 * per batch so a big send does not become one enormous Turso transaction, and
 * every row carries `broadcast:<id>:<account>` as its dedupe key — the same
 * shape as the follow/publish notices, which means a retried send is
 * idempotent and the administration page can list what went out.
 *
 * @returns {Promise<{ broadcastId: string, recipients: number, written: number, capped: boolean }>}
 */
export async function broadcastAll(db, { title, message, link = null, now = Math.floor(Date.now() / 1000) }) {
  const broadcastId = randomToken(10);
  const total = await countBroadcastRecipients(db);
  const capped = total > SOCIAL.broadcastMax;
  const audience = await db.all(
    'SELECT id FROM users WHERE suspended_at IS NULL ORDER BY id ASC LIMIT ?',
    [SOCIAL.broadcastMax],
  );
  for (let index = 0; index < audience.length; index += 100) {
    const chunk = audience.slice(index, index + 100);
    if (!chunk.length) break;
    await db.batch(
      chunk.map((row) => ({
        sql: `INSERT OR IGNORE INTO notifications
                (id, recipient_user_id, type, actor_user_id, paste_id, title, message, link, dedupe_key, is_read, created_at)
              VALUES (?, ?, 'admin', NULL, NULL, ?, ?, ?, ?, 0, ?)`,
        params: [
          randomToken(12),
          Number(row.id),
          String(title || '').slice(0, 200),
          String(message || '').slice(0, 300),
          link ? String(link).slice(0, 300) : null,
          `broadcast:${broadcastId}:${Number(row.id)}`,
          now,
        ],
      })),
    );
  }
  const written = await db.get('SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key LIKE ?', [
    `broadcast:${broadcastId}:%`,
  ]);
  return { broadcastId, recipients: audience.length, written: Number(written?.n ?? 0), capped };
}

/**
 * The last few broadcasts, reconstructed from the notification rows they
 * created — so the composer can show what was already sent without a second
 * table to keep in sync.
 */
export async function listRecentBroadcasts(db, limit = 8) {
  const rows = await db.all(
    `SELECT substr(dedupe_key, 11, 10) AS broadcast_id,
        MIN(created_at) AS sent_at, MAX(title) AS title, MAX(message) AS message,
        MAX(link) AS link, COUNT(*) AS recipients
      FROM notifications
      WHERE type = 'admin' AND dedupe_key LIKE 'broadcast:%'
      GROUP BY broadcast_id
      ORDER BY sent_at DESC, broadcast_id DESC LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 8, 50))],
  );
  return rows.map((row) => ({ ...row, recipients: Number(row.recipients) }));
}

/** One page of an account's notifications, newest first, with the actor joined. */
export async function listNotifications(db, userId, { limit = 20, offset = 0 } = {}) {
  return db.all(
    `SELECT n.id, n.type, n.title, n.message, n.link, n.paste_id, n.is_read, n.created_at,
        a.username AS actor_username, p.title AS paste_title
      FROM notifications n
      LEFT JOIN users a ON a.id = n.actor_user_id
      LEFT JOIN pastes p ON p.id = n.paste_id
      WHERE n.recipient_user_id = ?
      ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
    [
      Number(userId),
      Math.min(Math.max(Number(limit) || 20, 1), 100),
      Math.max(0, Number(offset) || 0),
    ],
  );
}

/** Unread notifications for one account (indexed COUNT). */
export async function unreadNotificationCount(db, userId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ? AND is_read = 0', [
    Number(userId),
  ]);
  return Number(row?.n ?? 0);
}

/** Mark one notification read. Scoped to the recipient, so nobody can mark another's. */
export async function markNotificationRead(db, userId, id) {
  const result = await db.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_user_id = ?', [
    String(id),
    Number(userId),
  ]);
  return Number(result?.changes ?? 0) > 0;
}

/** Mark every notification read for one account. */
export async function markAllNotificationsRead(db, userId) {
  const result = await db.run('UPDATE notifications SET is_read = 1 WHERE recipient_user_id = ? AND is_read = 0', [
    Number(userId),
  ]);
  return Number(result?.changes ?? 0);
}

/**
 * Drop every notification that points at one paste.
 *
 * Called when a paste is deleted, burned or pruned, so a mailbox never fills
 * with links to a 404 — the same reason bookmarks and reactions are swept with
 * it (see `deletePasteRows` in `pastes.js`).
 */
export async function deleteNotificationsForPaste(db, pasteId) {
  await db.run('DELETE FROM notifications WHERE paste_id = ?', [String(pasteId)]);
}

/**
 * Delete read notifications older than the retention window, oldest first.
 * Unread ones are kept: a notification nobody has seen yet is not clutter.
 */
export async function pruneNotifications(db, now = Math.floor(Date.now() / 1000), limit = 500) {
  const cutoff = now - SOCIAL.notificationRetention;
  const result = await db.run(
    'DELETE FROM notifications WHERE rowid IN (SELECT rowid FROM notifications WHERE is_read = 1 AND created_at <= ? LIMIT ?)',
    [cutoff, Math.min(Math.max(Number(limit) || 500, 1), 2000)],
  );
  return Number(result?.changes ?? 0);
}
