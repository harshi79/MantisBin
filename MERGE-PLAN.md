# Merging VibeBin into MantisBin — Decisions & Plan

**Short answer: yes, this is doable — and your constraints decide almost all of the design.**
Cloudflare-only, Turso (already in place), **no new environment variables**, Giphy included, no
account recovery.

---

## 0. Decisions locked (your answers) and Phase 0 status

| # | Decision | Locked choice | Consequence |
|---|---|---|---|
| 1 | Data | **Keep MantisBin users/pastes** | Append-only migrations only; PBKDF2 hashes stay; no renames; no import script |
| 2 | Rich text | **Line-level formatting + shortcode stickers** | `content` stays the exact text; formatting lives in a nullable column; `/raw` stays byte-exact; CSS-class palette (CSP-safe) |
| 3 | Usernames | **Hybrid: legacy names kept, new rule for new signups** | One widened validator (3–20, `[A-Za-z0-9_]`) — every old 4–6 handle still passes; reserved names fenced off |
| 4 | Visibility | **Unlisted by default + prominent publish toggle** | Social events (follows/notifications) fire **only** for public, unprotected pastes |
| 5 | GIFs | **Nekos.best (keyless) + Giphy public beta key** | Works with zero new env vars; `GIPHY_API_KEY` optional for higher limits |

### Phase 0 — ✅ shipped and verified

- `src/db/schema.js`: 8 new tables (`profiles`, `follows`, `bookmarks`, `reactions`,
  `notifications`, `stickers`, `tags`, `user_tags`) + 3 new `pastes` columns (`formatting`,
  `title_color`, `pinned`) + the indexes, all **append-only** and nullable — no existing row
  changes meaning.
- `src/lib/social.js` (new): owns the social data lifecycle — `userGraphStatements()` (erases an
  account's graph in the *same* transaction as the account deletion), `profileCounts()`,
  `listPinnedPublicPastes()`.
- Account deletion (`/me/delete` **and** the admin `delete_user` action) now clears the graph.
- Username policy: `validateUsername` widened to 3–20 with underscores, `RESERVED_USERNAMES`
  added (`admin`, `api`, `support`, `mantisbin`, …).
- Tests: `tests/social-schema.test.js` (8 tests) proves a **pre-merge database migrates in
  place** — new tables appear, old rows stay byte-identical, the legacy paste still renders
  through the real router, and `ensureSchema` is idempotent.
- Verified on the actual local database that predates this change: 8 tables added, 3 columns
  added, both existing pastes untouched (`formatting=null`, `pinned=0`, `visibility=unlisted`)
  and `/p/PdNfVeXl/raw` still byte-exact.
- **192/192 tests pass · typecheck clean · Worker bundle 107.6 KiB gzip.**

### Phase 1 — ✅ shipped and verified (line formatting + shortcodes)

**The contract.** `pastes.content` is still *the exact text*. Styling rides beside it in
`pastes.formatting` as `{"v":1,"lines":[{"line":3,"font":"sans","size":"lg","color":"red"}]}` —
**ids only, 1-based line numbers, never CSS**. `/raw`, download, QR, fork, expiry, burn and the
password gate all read `content` alone and stay byte-exact. Shortcodes (`:fire:` or `;fire;`) are
resolved **at render time**, never stored, so the pack can change under existing pastes.

- `src/config.js`: `FORMAT_FONTS` (reuses `FONTS`), `FORMAT_SIZES` (sm…xxl), 9 `FORMAT_COLORS`,
  `FORMAT` (`maxLines: 2000`, `maxBytes: 64 KiB`), `EMOJI_SHORTCODES` (53 tokens).
- `src/lib/formatting.js` (new, 360 lines): the only module that knows the overlay shape —
  `normalizeFormatting` / `parseFormatting` / `lineClasses` / `lineClassMap` / `formattingSummary`
  / `stickerIndex` / `substituteShortcodes` / `renderStickers` / `loadStickers`. Stickers ride as
  U+E000-range placeholders and are swapped **after** escaping/highlighting, and **only in text
  segments** — a shortcode typed inside a URL stays inert instead of injecting markup into `href`.
- `src/lib/highlight.js`: `addLineAnchors(html, { classes })` puts `fmt-*` classes on `code-line`;
  the tag balancer now knows **void elements**, so an `<img>` is not re-opened on every line.
- Routes: create/edit/duplicate all carry the overlay; the web reader resolves shortcodes →
  highlights → swaps stickers → applies line classes. Oversized pastes skip formatting entirely.
- Editor: a formatbar that appears only when JS is on (`hidden` otherwise), font/size selects,
  9 swatches, Clear, and a Preview panel that renders the styled lines locally; a hidden
  `name="formatting"` field carries the JSON, and the help line documents `:fire:` / `:wave:`.
  Editing a paste without submitting the field **keeps** the stored styling; submitting it empty
  clears it.
- API: `formatting` accepted on create (`POST /api/pastes`), on `PATCH` (tri-state: absent =
  keep, `null` = clear, object = replace) and carried through fork; it is returned **with**
  `content` on reads; `/api/meta` publishes the whole vocabulary plus the two limits.
- **Degrade, never fail a save:** unknown ids, out-of-range lines, unparseable payloads and
  overlays from a future version render plain. Only a raw payload bigger than the byte budget is
  refused, and an overlay that would not fit is trimmed from the tail so the paste still saves.
- `/docs` gained a **Formatting** section (field table row, the accepted ids, the degrade rules,
  the PATCH tri-state and the shortcode note) plus a one-line fix to a pre-existing escaping bug in
  the `burnAfter` row.
- Tests: `tests/formatting.test.js` (25 tests) — normalisation, caps/trimming, sticker URL
  safety, placeholder-in-attribute safety, a curated sticker rendering **once per shortcode** in
  the served page, web create/edit/duplicate round-trips, and `/raw` byte-exactness.
- **217/217 tests pass · typecheck clean · Worker bundle 465 KiB / 113.0 KiB gzip** (was 107.6
  before this phase). Verified live on the dev server: a 4-line paste with a Giphy sticker, an
  emoji fallback and two styled lines renders correctly (2 images, 0 stray `</img>`, correct
  `fmt-*` classes, "2 formatted lines" badge) while `/raw` stays byte-identical, and the legacy
  pre-merge paste is untouched.

Two real bugs the tests caught (both fixed): a **non-global placeholder regex** left every sticker
after the first one unresolved, and the per-line tag balancer **treated `<img>` as a container**,
re-opening it on every following line and closing it with a bogus `</img>`.


### Phase 2 — ✅ shipped and verified (profiles: banner, accent, effect, status, links, badges, tags, pins, view counter)

**The contract.** VibeBin applied a profile's colour and animation with **inline styles**, and
MantisBin has no inline styles anywhere (`style-src 'self'`). So every profile choice is stored as a
**validated id, a number, or a strict `#rrggbb`** — never CSS — and rendered by a **generated,
same-origin stylesheet**: `GET /u/:username/theme.css` emits `--accent`, `--accent-soft`,
`--accent-line`, `--name-speed`, `--name-strength` and (optionally) a `.profile-banner` rule. The
profile links that sheet with `?v=<first 10 hex of sha256(theme)>`, so it is
`immutable`-cacheable and changes exactly when the CSS would; the owner's `?preview=1` (unsaved
customiser values) is answered `private, no-store` and never for anyone else. A hostile banner URL
cannot inject CSS: it must first pass the https-only validator, and the WHATWG URL parser
percent-encodes quotes and braces. Video banners were dropped — they would need `media-src`.

- `src/lib/profiles.js` (new, 577 lines): limits, 10 accent presets, banner types, tag palette,
  `normalizeHex`, grapheme-aware `normalizeStatusEmoji` (≤3 graphemes, no URLs/controls),
  `safeProfileLink` (https only, no credentials), host-based `detectPlatform` (12 platforms,
  lookalikes fall through to *Website*), `parseProfileLinks` (dedupe/label/cap), `profileView`
  (re-validates stored rows on the way out, so a hand-edited row still renders safely),
  `resolveStatus` (pack → built-in emoji → literal), `themeHash`/`themeCss`, derived `badgesFor`,
  all-or-nothing `readProfileInput`, tag helpers.
- `src/lib/nameEffects.js` (new): **41** curated CSS-only effects in 9 categories, speed/intensity
  driven by the two variables above; VibeBin's removed `wave` and its JS typewriter are excluded,
  unknown ids render plain. The catalogue and `public/app.css` are a two-sided contract, asserted
  in both directions (`fx <class>` on the element *and* a `.fx.<class>` rule, with no orphan
  rules).
- `src/db/schema.js`: `profiles`, `tags`, `user_tags`, `profile_views` (+ unique dedupe index),
  `pastes.pinned` — append-only migrations, no existing entry touched.
- `src/lib/social.js` phase-2 layer: `ensureProfile` (`INSERT OR IGNORE`), `get`/`saveProfile`,
  `recordProfileView` (delete→insert→increment, one row per visitor per `VIEW_DEDUPE_SECONDS`),
  `listTags`/`listUserTags`/`upsertTag`/`awardTag`/`revokeTag`/`deleteTag`, `accountRank`.
- `src/lib/pastes.js`: pinned-first listing, `setPastePinned` (public pastes only) /
  `countPinnedPastes`; `pruneViewLog` now trims `profile_views` too.
- Routes: `GET /u/:username`, `/u/:username/theme.css`, `/u/:username/avatar.svg`,
  `GET /api/users/:username`, `GET|POST /me/profile`, `POST /me/pastes/:id/pin`, and admin
  `GET|POST /admin/tags` (award/revoke, audited as `tag_award`/`tag_revoke`, behind `adminForm` —
  exact same-origin request + CSRF token — and rate-limited).
- Views + CSS + JS: profile page, customiser (`/me/profile`), admin **Tags** panel, a
  *Customize profile* button in settings, pin toggles on *My pastes*; the Phase 2 CSS block
  (hero, banner, badges, status pill, link chips, 10 tag colours, 40 `.fx.name-*` effects,
  customiser) with a `prefers-reduced-motion` block that disables every animation; and one
  `initProfileCustomiser` island — the live preview works by re-pointing the generated sheet at
  `?preview=1`, and the form itself works with JS off.
- `/docs`: “Profiles & visibility” extended with customisation, badges, tags, pins and view
  counting, plus a `GET /api/users/:username` response example and a profile-limits bullet.

Three real bugs the tests caught (all fixed): the customiser called `alertBox('error', errors)`,
producing a red box that said only “error” and never listed the messages; `parseForm` keeps only
the **last** value of a repeated key, so a second link row silently vanished (added
`parseFormValues` with array support, and a guard that refuses a repeated single field rather than
guessing); and `publicProfile` read `ctx.env.APP_SECRET` directly, which 500s on any deployment
that sets no secret (now the shared `appSecret(ctx)` fallback, with a regression test).

- Tests: `tests/profile-custom.test.js` (30 tests) — validators and the theme sheet, the
  owner-only preview, escaping, view dedupe, the pin rules, admin tags, account deletion, and the
  three regressions above.
- **247/247 tests pass · typecheck clean · Worker bundle 526.3 KiB / 129.0 KiB gzip** (Phase 1:
  465 / 113.0). Verified live on the dev server: `theme.css` serves the saved accent/effect/banner,
  both link chips render, an invalid save lists its messages, a fresh formatted paste keeps
  `/raw` byte-identical, and the sticker/emoji degrade paths hold.

### Phase 3 — ✅ shipped and verified (follows, bookmarks, reactions, notifications)

**The rule that shapes it.** VibeBin let anyone react, keying anonymous likes by an IP hash. The
merged app has **no anonymous actors**: every social action requires an account, and every social
action is an ordinary HTML form post — no fetch, no client state, works with JS off, keeps the
strict CSP and the zero-third-party-JS rule. The second rule is *discovery stays opt-in*: a reaction
is a published signal, so it exists only on `public` pastes; a bookmark is a private one, so it
works on anything the visitor may already read (a public paste, an unlisted link they hold, or a
protected paste they have unlocked). Counts are always computed from indexed rows, never stored.

- `src/routes/social.js` (new): `follow`, `followers`, `following`, `notifications`,
  `readNotifications`, `bookmarks`, `toggleBookmark`, `react` — sign-in gate first
  (`/login?next=…`), shared `RATE_LIMITS.social` bucket (240/hour per account), allow-listed
  `?notice=` flags, same-site-only redirect targets.
- `src/views/social.js` (new): notifications feed, saved-pastes list, follower/following grid with
  per-row follow state.
- `src/lib/social.js` phase-3 layer (+~300 lines): `followUser`/`unfollowUser` (idempotent,
  self-follow refused, one notice per follower per day, unfollow withdraws an unread one),
  `listFollows`/`countFollows`, `setBookmark` (cap 2000) / `listBookmarks` / `countBookmarks`,
  `setReaction` (upsert, `ON CONFLICT(user_id, paste_id)`) / `reactionState` (per-glyph counts +
  this account's own), `normalizeReaction` (glyph, stable id, or `:token:`), `notify` (drops
  self-notifications, dedupes on `dedupe_key`), `notifyReaction`/`clearReactionNotice`,
  `announcePublish` (public + unprotected + owned only, capped at `SOCIAL.fanout` = 500
  recipients, chunked 100 statements per batch, dedupe key `new:<paste>:<user>`),
  `listNotifications`/`unreadNotificationCount`/`markNotificationRead`/`markAllNotificationsRead`
  (all scoped to the recipient), `deleteNotificationsForPaste`, `pruneNotifications`.
- `src/lib/auth.js` `resolveSession` now returns the unread count with the session (one correlated
  subquery, no extra round trip); `src/views/layout.js` renders the bell with a **9+**-saturating
  badge; `/me` shows an unread banner.
- `src/app.js`: 8 route rows (`POST /u/:username/follow`, `GET /u/:username/followers|following`,
  `GET /notifications`, `POST /notifications/read`, `GET /me/bookmarks`, `POST /p/:id/bookmark`,
  `POST /p/:id/react`).
- Cascades: `pasteChildStatements()` in `src/lib/pastes.js` now clears `bookmarks`, `reactions`,
  `notifications` and `paste_views` whenever a paste is deleted, burned or pruned (used by
  `deletePaste`, `deletePasteRows`, `pruneExpired`, `pruneBurned`); account deletion already
  cleared the graph in Phase 0.
- Fanout hooks: `src/routes/web.js` create + edit-into-public, `src/lib/maintenance.js` now sweeps
  `pruneNotifications` (read rows older than 30 days; an unread notice is never deleted).
- Views/CSS: reaction bar + Save button on the paste page (static counts for guests),
  `/notifications`, `/me/bookmarks`, follower lists, `public/app.css` social block (no animations:
  unread is an accent border, never motion). `/docs` gains a “Following, reactions & bookmarks”
  section.
- Tests: `tests/social.test.js` (24 tests) — guest gates, idempotent follow, per-day dedupe,
  follower-list state, bookmark round-trip + privacy + cap, unlock-gated bookmarking, reaction
  storage/counts/change/clear, public-only reactions, one notice per reactor, fanout rules,
  mark-one/mark-all scoping, bell saturation, cascade deletes, prune retention, rate limiting, and
  the dev-fallback render path with no `APP_SECRET`.

Four real bugs the tests caught (all fixed): `/me/bookmarks` **500'd** — the bookmark query joined
`pastes` and `users`, so the shared column list made `id` ambiguous (new `pasteMetaColumns(alias)`
helper); **reaction notifications were never written** — `setReaction` only wrote the row, so
`notifyReaction`/`clearReactionNotice` were added; `normalizeReaction` accepted only glyphs, so a
`reaction=fire` post 400'd (ids and `:tokens:` now resolve too); and the follower-list cross-link
was labelled “Following”, which read like a button state (relabelled “Who @x follows”).

- **271/271 tests pass · typecheck clean · Worker bundle 566.6 KiB / 138.0 KiB gzip** (Phase 2:
  526.3 / 129.0). Verified live on the dev server: follow → `notice=followed`, react → `notice=reacted`
  with the chip marked `is-mine`/`aria-pressed`, bookmark → `notice=saved` and the paste appearing on
  `/me/bookmarks` with its author, a guest seeing counts but no buttons, and the follower page
  showing the right follow state per viewer.

### Phase 4 — ✅ shipped and verified (sticker pack, GIF search, media lines, broadcasts)

**The rules that shape it.** Three constraints decide this whole phase:

1. **`connect-src 'self'`** — the browser may never call Giphy or Nekos.best directly, so every GIF
   search is proxied through the Worker (`GET /api/gifs`) and no key ever leaves the server.
2. **`content` is the author's bytes** — so a GIF is inserted as *text*: either a `:token:` shortcode
   or an image URL alone on its own line, resolved at render time exactly like the Phase 1 overlay.
   `/raw`, downloads, forks and the API stay byte-exact.
3. **A provider outage is not an error** — `/api/gifs` answers `200` with `{ gifs: [], degraded: true }`
   when the provider does not answer, and the picker says "nothing found". The editor never breaks
   because Giphy is down, and Nekos needs no key at all.

- `src/lib/media.js` (new): the two provider clients, normalised to one shape
  (`{ id, url, preview, label, provider, emoji }`). `fetchJson` is an 8 s `AbortController` GET that
  returns `null` for **every** failure (non-2xx, timeout, DNS, unparseable body) instead of throwing;
  `searchGiphyResult` separates "answered with nothing" (`ok: true`) from "did not answer"
  (`ok: false`) so `degraded` is honest; `isTrustedMediaUrl` gates imports to the provider's own hosts;
  `NEKO_CATEGORIES` is a curated 24 (VibeBin resolved ~70 in one request — one category per request is
  cheaper, cacheable and always degrades); `giphyKey(env)` prefers `GIPHY_API_KEY` and otherwise uses
  Giphy's published beta key, so **no new environment variable is required to deploy**.
- `src/lib/stickers.js` (new): token/label/emoji/url normalisers, all-or-nothing `readStickerInput`,
  pack CRUD (`addSticker`/`removeSticker`/`countStickers`), `importSticker` (the URL is re-resolved
  **from the provider**, never taken from the form, and must land on that provider's hosts — a hosted
  form cannot plant a tracking pixel in front of every reader), and `listStickerPack`, which
  re-validates every row on the way out exactly like `profileView` re-validates a profile: a
  hand-edited `javascript:` URL is dropped and the row falls back to its emoji. One cap
  (`PACK_LIMIT = STICKER_LIMITS.pack = 400`) that the code, the admin view and `/docs` all quote.
- `src/lib/formatting.js`: `substituteMediaLines` (the whole line must be an `https` image URL —
  `.gif/.png/.jpg/.jpeg/.webp`, optional surrounding whitespace, no query string, so prose is never
  re-interpreted) + `resolveStickers` (shortcodes **then** media lines, sharing one placeholder array,
  so a paste can mix `:wave:` and a GIF with both rendering). `src/routes/web.js` now calls
  `resolveStickers`.
- `src/routes/media.js` (new): `GET /api/stickers` (pack, 60 s cache + `stale-while-revalidate`) and
  `GET /api/gifs` (`?q=` Giphy search/trending with `rating=g` and a clamped `limit`, `?category=`
  one Nekos reaction GIF, 30 s/300 s/60 s caches). One shared per-IP `media` bucket.
- `src/routes/social.js`: `GET /api/notifications/unread` — answers from the session (no DB round
  trip), `no-store`, its own generous bucket, and the only endpoint `public/app.js` polls.
- `src/lib/social.js`: `countBroadcastRecipients`, `broadcastAll` (hard-capped audience, 100-row
  `db.batch` chunks, dedupe key `broadcast:<id>:<account>`, suspended accounts skipped, returns
  `{ broadcastId, recipients, written, capped }`) and `listRecentBroadcasts` (rebuilt from the
  notification rows, so there is no second table to keep in sync).
- `src/routes/admin.js`: `/admin/stickers` (add / anime-or-Giphy import / delete, every branch audited,
  failures carried back as short `?error=` codes so nothing an operator typed is echoed into the
  refusal) and `/admin/broadcast` (title/message/link, `normalizeBroadcastLink` accepts a same-origin
  path or an `https` URL and refuses everything else, 10 sends/hour, audited with the recipient count).
- `src/views/admin.js`: two new tabs (the console now has Overview / Pastes / Accounts / Tags /
  **Stickers** / **Broadcast** / Audit log).
- `src/views/editor.js` + `public/app.js` + `public/app.css`: the **Stickers & GIFs** panel. It is a
  server-rendered `<details>` **outside the workspace form** (a nested search form would be invalid
  HTML and its `</form>` would end the paste form early) and works with scripting off — typing
  `:wave:`, or an image URL on its own line, renders the same picture. The island only inserts at the
  caret: 48 emoji chips, the pack's chips (images rendered server-side), and a GIF grid that fetches
  same-origin and inserts the URL padded onto its own line. The unread-bell island polls
  `/api/notifications/unread` every 60 s while the tab is visible, and stops for good on a 401/429.
- `/docs`: a **Stickers & GIFs** section (shortcode + media-line rules, both endpoints, the import
  guarantee, `degraded`, the broadcast, and the rate limits) plus the two endpoints in the API list.
- `src/routes/api.js`: the missing fanout hooks — a public paste created **or edited into public** or
  **forked** through the API now announces itself to followers exactly like the web form.

Bugs the tests and the live run caught: the editor's media panel was first written **inside** the
paste form (invalid HTML that would have ended the form early in a real browser — and it broke the
thumbnail tests, which is how it surfaced); `listStickerPack` returned raw database rows, so a
hand-edited `javascript:` URL reached `/api/stickers` and the editor; `PACK_LIMIT` (384) disagreed
with the enforced cap (400); `importSticker` could return `reason: 'invalid'`, which had no message
in `STICKER_ERRORS`; and `searchGiphy` could not distinguish an empty result set from an outage.

- Tests: `tests/media.test.js` (28) — provider clients under a stubbed `fetch` (search, trending,
  empty, 429, network failure, operator key), token/label/emoji/pack validation, import gating
  (unknown source, unreachable provider, hostile host), the media-line rule and its exclusions, one
  shared placeholder array, the pack re-validating rows on the way out, both JSON endpoints with
  their cache/`noindex` headers, the degraded paths, the editor panel's structure and hooks, admin
  curation, the broadcast (validation, one row per account, dedupe keys, suspended accounts skipped,
  audit), and the bell's polling hooks. `tests/social.test.js` gains the API fanout test (create,
  edit-into-public, fork).
- **300/300 tests pass · typecheck clean · Worker bundle 608.1 KiB / 148.2 KiB gzip** (Phase 3:
  566.6 / 138.0). Verified live on the dev server: `/api/stickers` serving the pack (and dropping a
  hostile hand-written URL to its emoji fallback), `/api/gifs` answering `200 { degraded: true }`
  with no outbound network, the editor panel rendering 3 tabs / 50 chips / 24 categories with the
  search form as a GET to `/api/gifs`, an anonymous paste whose bare GIF URL line rendered as
  `<img class="sticker">` while `/raw` stayed byte-identical, and — with a temporary gitignored
  `.dev.vars` — the full admin flow: add → pack, import refused with `?error=unverified` when the
  provider is unreachable, invalid add → `400`, delete → gone, broadcast → `303` with one
  notification per account, the recent-sends table showing `6 recipients`, and every step in the
  audit log. The admin console fails closed again (`503`) once that temporary password is removed.

### Phase 5 — ✅ shipped and verified (hardening pass, docs, CI, deploy smoke checklist)

**The audit first.** Rate limits, retention, `noindex` coverage, CSP, the single dependency and
the admin audit log were already in place from Phases 0–4, so the hardening pass changed only
what it could prove was wrong:

- **Cache policy was the one real bug.** `/u/:username` was `public, max-age=60` for *every*
  viewer — including a signed-in reader, whose copy carries their own follow state, and the owner,
  whose copy carries manage links. Only the anonymous copy is cacheable now; anything with a
  session is `private, no-store`. The same rule was applied to `/docs` (public for crawlers,
  private when the page chrome carries the viewer's own bell/username).
- `src/routes/api.js`: `/api/health` and `/api/meta` now send `X-Robots-Tag: noindex, nofollow`
  like every other machine endpoint.
- `src/db/schema.js`: `idx_profile_views_created` added — age-based pruning walked that table —
  mirroring `idx_paste_views_created`. Idempotent, and verified applied to the pre-existing dev
  database.
- `public/robots.txt`: disallows `/admin` and `/notifications`, and the bogus `Sitemap: none`
  line is gone.
- `wrangler.jsonc`: the dead `vars.SITE_URL` binding is removed (nothing in `src/` ever read it —
  every URL is built from the request origin), so a deploy now has **no plain vars**: three
  secrets and nothing else. `wrangler` reports `No bindings found`.
- `src/app.js` (admin routes moved into the admin block of `ROUTE_TABLE`), `src/views/profileEdit.js`
  (the one unnecessary `raw()` beside user data), `src/lib/http.js` untouched.
- Dependencies: `wrangler` `^4.142.0` → `^4.147.0` clears the three dev-only advisories
  (`miniflare` → `undici`, one high) — `npm audit` is now **0 vulnerabilities**, and
  `npm audit --omit=dev` was already clean. `.dev.vars.example` documents the optional
  `GIPHY_API_KEY`.

**Docs.** `README.md` 592 → 735 lines: the intro feature list covers the merged set, the
workspace section describes the formatting toolbar, media panel, publish toggle and profile
customiser, the admin section gains Stickers/Broadcast, the limits section gains the merge's
numbers, the route table gains every merged route, the security notes cover social rate limits,
media proxies, sticker re-validation, retention and the new cache/`robots` rules, the architecture
tree lists the new modules, and the roadmap gained a **2.4 — the VibeBin merge** table. The stale
"Usernames: 4–6 letters/digits" line and the deploy step that told operators to edit the deleted
`vars.SITE_URL` are fixed. `/docs` gained the `/api/notifications/unread` endpoint row, the bell's
polling contract, and two privacy paragraphs (indexability; what leaves the server — provider
images with `referrerpolicy="no-referrer"`, the same-origin media proxy, and the retention
windows).

**CI + smoke checklist.** `.github/workflows/ci.yml` keeps its one `check` job and adds a Node-22
step that starts `scripts/dev.js` with `DB_FILE=:memory:`, waits for `/api/health`, runs the smoke
script and kills the server — the deploy checklist rehearsed on every push. `scripts/smoke.js` is
new and dependency-free (`npm run smoke <base-url>`): read-only by default (health, `/api/meta`,
the editor's media panel, the `/docs` sections, the sticker pack plus its cache/`noindex` headers,
Giphy trending and search, the signed-out `401` on the unread endpoint, the `robots.txt` rules, an
unknown profile's `404`, `/admin` redirect-or-503) and `--write --key mb_…` adds create → raw
byte-exact → delete. A provider outage, an empty pack or a disabled admin are warnings, never
failures.

**Verification.** **301/301 tests · `tsc` clean · `npm run check` exit 0 · Worker bundle 609.8 KiB /
148.7 KiB gzip · no bindings** (Phase 4: 300, 608.1 / 148.2). `tests/profile-custom.test.js` gains
the cache-policy regression test (anonymous vs signed-in on `/u/:name` and `/docs`, plus the
`noindex` machine endpoints → 31 tests in that file). `npm audit` 0 vulnerabilities.
Verified live on the restarted dev server: `/api/health` and `/api/meta` carrying
`x-robots-tag: noindex, nofollow`; `/docs` `public, max-age=300` anonymous vs `private, no-store`
with a session; `/u/<name>` `public, max-age=60` anonymous vs `private, no-store` signed in;
`robots.txt` disallowing `/admin` and `/notifications`; the new index present in the existing dev
database; and `npm run smoke --write` → **9 passed, 3 warnings, 0 failed** (the warnings are this
sandbox's absent provider egress, an empty fresh-database pack and admin disabled — all designed
states). The CI rehearsal was rehearsed locally too: a fresh `:memory:` server → 7 passed,
4 warnings, exit 0.

**The merge is complete: every phase in the table above is shipped, tested and deployable.**

---

## 1. The constraint that shapes everything

"Keep it all around Mantis" = the merged app stays a **Cloudflare Worker + Assets** app with
**one runtime dependency** (`@libsql/client`), server-rendered HTML, strict CSP, and reading
that works with JavaScript disabled.

VibeBin is **Next.js + React 19** (20,316 lines of app code). So VibeBin becomes a *reference
implementation*, not code we copy wholesale:

| VibeBin piece | Lines | How it lands in Mantis |
|---|---|---|
| Domain logic (`lib/`: reactions, notifications, follows, bookmarks, stickers, nameEffects, pasteFormat, neko, gifs…) | ~2,950 | **Port near-verbatim** — mostly React-free, plain TS → JS |
| React UI (`components/`: Editor 1,404, ProfileCustomizer 693, NotificationCenter 480…) | 9,537 | **Rewrite as server-rendered views + vanilla JS islands** |
| Next scaffolding (`app/` pages + 38 route handlers, `middleware.ts`) | 5,064 | **Replaced** by Mantis's router/views (no Next, no Vercel) |
| Email OTP + password reset + Resend | ~1,000 | **Dropped** — you said no recovery, and it's the only thing needing an extra secret |

Realistic net new code: **~4,500–6,500 lines** across ~10 new tables, ~12 new routes, ~8 new
views, and a hand-written rich-text editor. That's the honest size of this — it is a project,
not an afternoon.

## 2. Environment variables after the merge

| Variable | Status | Notes |
|---|---|---|
| `TURSO_DATABASE_URL` | **required** (already) | unchanged |
| `TURSO_AUTH_TOKEN` | **required** (already) | unchanged |
| `APP_SECRET` | **required** (already) | covers sessions, unlock tokens, IP hashing |
| `ADMIN_PASSWORD` | optional (already) | admin stays disabled until set |
| `CATBOX_USERHASH`, `THUMBNAIL_*` | optional (already) | thumbnails stay optional |
| `GIPHY_API_KEY` | **optional, never required** | VibeBin already falls back to Giphy's published beta key (`dc6zaTOxFJmzC`) |
| `RESEND_*`, email OTP | **gone entirely** | no recovery, per your call |
| `AUTH_SECRET`, `NEXT_*`, `VERCEL_*` | **not needed** | VibeBin-only concepts |

**Net effect: a fresh deploy needs the same three secrets it needs today.** Nothing new.
Phase 5 closed the loop: the plain `vars.SITE_URL` binding was dead config and is now gone, so
`wrangler.jsonc` declares **no vars at all** — the Worker builds every URL from the request origin.

## 3. What ports, what gets redesigned, what I'd drop

### Ports cleanly (high value, low risk)
- **Reactions** (one per user per paste, composite PK) and the ❤️ count
- **Bookmarks** (saved posts)
- **Follows** + follower/following counts
- **Notifications** (follow / like / new post / admin broadcast, dedupe key, unread count)
- **Sticker pack** (admin-curated tokens, `:wave:` shortcodes, emoji fallback)
- **GIF search** — Nekos.best (keyless) + Giphy (proxied through the Worker, key optional)
- **Admin extras** — tags awarded to users, sticker curation, broadcast composer
- **Profile identity** — display name, bio, avatar/banner URLs, accent colour, custom links
- **Emoji status** + **badges**

### Needs redesign to fit Mantis
1. **Rich formatting.** VibeBin stores a JSON `RichDoc` as the paste *content*, which means
   `/raw` has to reconstruct text. Mantis's promise is that `/raw` returns exact bytes. Fix:
   keep `content` as the exact text (source of truth) and store formatting in a **separate
   nullable `formatting` column**, keyed by line index. Raw, download, QR, fork, burn, expiry,
   password gates and language detection all keep working **untouched**.
2. **CSP is `style-src 'self'` with no inline styles.** VibeBin's per-line arbitrary font/hex
   colour can't be emitted as inline `style="…"`. Options in §4.
3. **Reading without JavaScript.** Paste rendering stays server-side; reactions, bookmarks,
   follows, notifications and the editor become progressive enhancements (forms still work
   without JS, like Mantis's editor does today).
4. **No `contentEditable`-per-line.** VibeBin renders one `contentEditable` per line and caps
   pastes at 20,000 lines for that reason. Under Mantis's model I'd keep the **textarea** and
   apply formatting to *selected line ranges* — far less code, no per-line DOM, and the raw text
   stays a single honest string.
5. **Notifications.** No websockets; a rate-limited `GET /api/notifications/unread-count`
   polled by `public/app.js`, plus server-rendered pages that work without JS.
6. **Admin.** Mantis's hardened admin is the base (separate credential, CSRF token, exact-origin
   check, rate-limited login, audit row committed in the same transaction). VibeBin's admin
   *pages* (tags, stickers, broadcast) get added on top of it — so the merged admin is strictly
   stronger than either one today.
7. **Signup IP cap.** VibeBin stores raw IPs in `signup_ips`. Mantis has no raw-IP column
   anywhere, so I'd enforce "N accounts per IP" with the existing hashed rate-limit buckets
   instead — same limit, no raw addresses stored.

### I'd drop deliberately
- Email OTP / Resend / any recovery flow (your call, and it removes the only extra secret)
- Neon/Postgres migration scripts, `pglite`, `postgres`, Vercel config, Next scaffolding
- VibeBin's in-process 3-second view dedupe (Mantis's DB-backed 6-hour dedupe is better)
- VibeBin's 20,000-line-only limit → keep Mantis's byte caps (5 MB anon / 10 MB account)
- `like` + `reactions` dual system → one reaction per user (VibeBin already unified this)
- Cursor trail, and I'd trim the animated-name-effect set to a handful that are cheap on mobile

## 4. The one real design fork: how rich does "rich text" get?

**Option A — line-level formatting + shortcodes (recommended).**
Textarea with a toolbar: font (Mantis's 4 system stacks), size (7 steps), colour from a
**whitelist palette**; formatting stored as `{line, font, size, color}` per line; stickers and
emoji typed as `:wave:`/`;fire;` and resolved at render time.
✅ CSP-safe via CSS classes · `/raw` stays byte-exact as typed · tiny JS · no offset bookkeeping
· works without JS (the toolbar is the enhancement).
⚠️ No arbitrary hex colours, no per-character marks (bold/italic inside a line).

**Option B — faithful VibeBin RichDoc.**
Store `{text, marks[], font, size, color}` per line with character offsets, arbitrary hex.
✅ Maximum fidelity, closest to what VibeBin users see.
⚠️ `/raw` becomes a reconstruction (not exact bytes) · inline colours need CSP loosening or a
generated stylesheet · marks + offsets are the most bug-prone part of VibeBin (its editor
carries 272 lines of line-ops just to keep them consistent).

My recommendation is **A**, with a fixed 16-colour palette that covers the same visual range.

## 5. Schema plan (append-only, Mantis style)

**New tables (10):** `profiles`, `follows`, `bookmarks`, `reactions`, `notifications`,
`stickers`, `tags`, `user_tags`, `profile_links` (or a JSON column), `gif_cache` (optional).
**New columns (3–4):** `pastes.formatting`, `pastes.title_color`, `pastes.pinned`,
`users.display_name` (or on `profiles`).
**Not created:** `email_verifications`, `password_resets`, `signup_ips` (raw IPs) — all
unnecessary under your constraints.
**Compatibility:** existing MantisBin pastes/accounts keep working untouched — `formatting` is
nullable → renders exactly as today; migrations stay append-only and auto-apply on first request.

## 6. What I will not break (the Mantis invariants)

Exactly-once burn-after-reading · unlock cookie that `/raw` and the API honour · byte-exact
`/raw` · strict CSP with no inline script/style · **zero third-party JS** · one runtime
dependency · IPs only ever as HMACs · API keys + `/api/meta` contract · admin audit log ·
paste pages `noindex` and **unlisted by default**.

Social features must respect that last one: **notifications only ever fire for public,
unprotected pastes** (VibeBin already has this rule) — an unlisted paste stays invisible, and a
follower never learns it exists.

## 7. Phases (each one ends deployable, tested, CI-green)

| Phase | Contents | Rough size |
|---|---|---|
| 0 | ~~Lock decisions, schema migrations, test harness + fixtures~~ — **done** | small |
| 1 | ~~Formatting overlay + editor toolbar/palette/shortcodes + viewer rendering~~ — **done** | largest |
| 2 | ~~Profiles: banner, accent, links, emoji status, badges, tags, view counter~~ — **done** | medium |
| 3 | ~~Social: follows, bookmarks, reactions, notifications + banner UI~~ — **done** | medium |
| 4 | ~~Stickers + GIF search (Nekos/Giphy proxy) + admin curation + broadcast~~ — **done** | medium |
| 5 | ~~Hardening pass, docs (`/docs` + README), CI, deploy smoke checklist~~ — **done** | small |

Roughly **5–8 focused working sessions**. Every phase ships behind the existing CI (tests +
typecheck + wrangler dry-run build), so the app is never in a broken half-merged state.

## 8. Risks / things worth pushing back on

1. **Product identity.** MantisBin's promise is "private, unlisted, no discovery". Follows,
   profiles and notifications are the *opposite* instinct. It works only if discovery stays
   strictly opt-in (public pastes on opt-in profiles) and paste pages stay out of search —
   which is what I'd enforce.
2. **Write volume on Turso.** Reactions, follows, bookmarks and view counts all write on the hot
   path. VibeBin currently has no creation rate limit and let a 2 MB single-line guest paste
   through; the merge must keep Mantis's byte caps **and** its per-IP rate limits, or storage
   abuse becomes a billing problem.
3. **Third-party egress grows**: catbox/0x0.st (thumbnails) + Nekos.best + Giphy. Giphy's public
   beta key is a shared quota — it can be rate-limited or withdrawn at any time, so the feature
   must degrade gracefully (as VibeBin's does: fall back to the emoji).
4. **Two editors' worth of UX in one form.** Rich formatting + code highlighting + expiry +
   password + burn + visibility + thumbnail is a lot of controls; I'd keep Mantis's
   disclosure-based layout so the default view stays calm.
5. **Hand-ported code loses VibeBin's tests.** Mantis's suite is end-to-end against the real
   router, so every ported feature needs its own tests written in Mantis's style — budget for
   that, don't assume VibeBin's 556 tests transfer (they don't; different runtime).
