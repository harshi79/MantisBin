# MantisBin — Full Repository Analysis

*Read-only analysis of commit `a939789` (branch `arena/58abb780-mantisbin`). No source files were modified.*

---

## 1. What it is

**MantisBin** ("Stay sharp. Paste faster.") is a minimal, privacy-first pastebin for plain
text and code, built as a **single Cloudflare Worker + Cloudflare Assets** app backed by
**Turso (libSQL/SQLite)**.

Its product identity is deliberately narrow: *paste → save → share → copy*. No feed, no
search, no comments, no tracking, no webfonts, no third-party scripts. Reading a paste
requires zero client JavaScript — the site is server-rendered and works with JS disabled.

| | |
|---|---|
| Version / license | `2.3.0`, MIT, private package |
| Language | JavaScript (ESM, JSDoc-typed) — no build step for app code |
| Runtime | Cloudflare Workers (`compatibility_date` 2026-01-01), Node ≥ 22.5 for dev/tests |
| Database | Turso / libSQL in prod; Node's built-in `node:sqlite` in dev & tests (same SQL) |
| Runtime deps | exactly **one**: `@libsql/client` |
| Dev deps | `wrangler ^4.142`, `typescript ^7.0.2` |
| Source size | `src/` 8,878 lines · `public/` 1,813 · `tests/` 4,928 · 70 tracked files |
| Routes | **51** (29 GET, 20 POST, 1 PATCH, 1 DELETE) |
| Tests | **185 passing** across 14 `node:test` suites |
| Build | 438.30 KiB worker (105.65 KiB gzip) + 3 static assets |
| Repo state | `HEAD == origin/main`, working tree clean; 19 merged PRs, all from prior agent sessions |

---

## 2. Architecture

### Request lifecycle

```
Cloudflare Assets ──(app.css, app.js, robots.txt)──► served at edge, never hits the Worker
        │ unmatched
        ▼
src/worker.js   fetch()  : create libSQL client → ensureSchemaOnce → handleRequest
                scheduled: same + runMaintenance (cron "13 * * * *")
        ▼
src/app.js      parseCookies → theme → resolve session (skipped for /admin) → dispatch
                → tiny regex router (51 routes) → CSP + security headers → error handling
        ▼
src/routes/     web.js (HTML forms, 25 routes) · api.js (JSON, 10) · admin.js (9) · profile.js (7)
        ▼
src/views/      escaping-by-construction tagged templates (SafeHtml) → full HTML pages
src/lib/        auth, crypto, pastes, access, unlock, burn, ratelimit, detect,
                highlight, qr, avatar, thumbnail, validate, http, html, maintenance
src/db/         schema.js (DDL + append-only migrations) · turso.js · node-sqlite.js
public/         app.css (49 KB) · app.js (35 KB, progressive enhancement only)
```

The same `handleRequest()` powers production, the local dev server (`scripts/dev.js`), and
every test — a genuinely strong design choice: tests exercise the real request path, not a
re-implementation.

### Data model (8 tables, 11 indexes)

| Table | Purpose | Notable columns |
|---|---|---|
| `users` | Accounts | `username_key` (UNIQUE, lowercased), PBKDF2 `password`, `suspended_at` |
| `sessions` | Account sessions | PK = SHA-256 `token_hash`; raw tokens never stored |
| `pastes` | The product | `content` inline; `password_hash`, `burn_mode`/`burned`, `visibility`, `thumbnail_url`, `size`, `views`, `expires_at` |
| `api_keys` | API auth | `key_hash` (SHA-256), display `prefix`, `last_used_at` |
| `paste_views` | View dedupe | PK `(paste_id, visitor)` where visitor = HMAC(APP_SECRET, ip+pasteId) |
| `admin_sessions` | Separate admin auth | `credential_version` = HMAC(APP_SECRET, ADMIN_PASSWORD) |
| `admin_audit` | Moderation log | actor, action, target, reason, timestamp |
| `rate_limits` | Abuse guards | one upserted row per bucket |

Migrations are an **append-only** list of `ALTER TABLE` statements, guarded by a
`pragma_table_info` probe, tolerant of two isolates racing ("duplicate column name"), with a
post-migration index step. Six migrations so far; nothing is ever edited or removed.

### Configuration discipline

`src/config.js` (419 lines) is the single source of truth: limits, 27 languages, 8 expiry
presets, 3 burn modes, 4 themes, 4 font stacks, 7 font sizes, rate limits, cookie names,
thumbnail providers, filename→language maps. The HTML forms and the JSON API validate
against the same constants, so they cannot drift.

---

## 3. Feature inventory

**Core:** anonymous pastes (5 MB) · accounts (10 MB, edit/delete) · server-side syntax
highlighting for 27 languages · raw endpoint with exact bytes and safe download filename ·
filename-first editor (`untitled.txt`; `.py` → Python) · auto language detection (extension
first, then bounded 64 KiB content fingerprints, deterministic) · line numbers + `#line-N`
anchors · QR sharing via a **local** dependency-free encoder · duplicate/fork · expiry
presets from 10 minutes to never · view counter with 6-hour per-visitor dedupe · 4 themes.

**Security features (2.2 roadmap, all shipped):** optional per-paste passphrase (PBKDF2,
signed `HttpOnly` unlock cookie, 30-min TTL, up to 3 pastes per browser, 10 attempts/15 min
per paste+IP) · burn-after-reading in `view` and `read` modes with an atomic exactly-once
claim · opt-in public profiles at `/u/:username` with deterministic avatars, the only
indexable discovery surface · account settings (password change revokes other sessions,
session list/revoke, password-confirmed account deletion that anonymises pastes).

**Public JSON API:** `POST /api/pastes` (key) · `GET/PATCH/DELETE /api/pastes/:id` ·
`/raw`, `/fork`, `/unlock` · `GET /api/pastes/mine` · `GET /api/meta` (full vocabulary &
limits) · `GET /api/health` · `GET /api/users/:username`. Keys are `mb_` + 32 random chars,
stored hashed, shown once, max 3 per account, usable as `Authorization: Bearer` or
`X-API-Key`.

**Thumbnails (2.4):** browser resizes to 1200×630 JPEG → one bounded, timeout-guarded,
no-redirect request per provider → catbox.moe first, 0x0.st as fallback (because catbox
filters datacenter IPs, which is what Workers egress from) → only the URL is stored. Any
`https:` image URL may be hand-entered. Public by design, and the UI says so.

**Admin (opt-in):** `/admin` is disabled until `ADMIN_PASSWORD` (16–256 chars) **and**
`APP_SECRET` (≥16) are set — verified locally: it answers `503` with a clear message. Separate
credential space from user accounts, hashed sessions bound to a credential version (rotating
either secret invalidates them), 1-hour TTL, `SameSite=Strict` cookie scoped to `/admin`,
exact-origin + CSRF token on every POST, rate-limited login (5/15 min per hashed IP, 50
global), allowlisted actions with mandatory reason (5–300 chars), and **audit rows committed
in the same transaction as the action** so an action can never be unlogged. Dashboard:
overview stats + 14-day creation chart, paste search/filter (metadata only — never titles,
content, thumbnails or hashes), account suspend/restore/revoke/delete, bounded manual
cleanup of ≤200 expired/consumed pastes with eligibility rechecked inside the transaction.

---

## 4. Verified health (I ran everything)

| Check | Result |
|---|---|
| `npm ci` | clean install |
| `npm test` | **185 pass / 0 fail**, ~8.6 s |
| `npm run typecheck` (`tsc --noEmit`, `checkJs`) | clean, no errors |
| `npm run build` (`wrangler deploy --dry-run`) | success — 438.30 KiB / 105.65 KiB gzip |
| `TODO/FIXME/HACK` sweep | none anywhere in `src`, `public`, `tests`, `scripts` |
| Live smoke test (`npm run dev`) | homepage 200 · create→view→raw round trip 303→200 · auto-detection stored `python` from `analysis-check.py` · raw headers correct (`text/plain`, nosniff, `Content-Disposition`, noindex) · QR SVG 200, 4.4 KB · 404 for bad id, 405 for wrong method · register/login/`/me`/settings/profile/avatar/API-key flow all green · `/api/meta` complete · `POST /api/pastes` without key → 401 · password paste → 401 locked on API and raw, lock screen leaks nothing, unlock → read → second read 404 (burned) |

The security-relevant CSP is exactly as documented on the wire:
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https: …; font-src 'none'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`.

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run check` (tests + typecheck + dry-run
build) on Node 22 and 24, with SHA-pinned actions and a 10-minute timeout. Local dev gets a
browser-embeddable preview only when `DEV_PREVIEW=1` widens `frame-ancestors` — production
keeps `'none'`.

---

## 5. Findings, gaps and risks

Ordered by how much they matter. Nothing here is a broken feature; the shipped behaviour
matches the documentation, which is unusually thorough (a 900-line README, `/docs`, deploy
notes, `.dev.vars.example` annotation).

**Correctness / hygiene**

1. **Dead config: `SITE_URL`.** It is declared in `wrangler.jsonc` (pointing at
   `mantisbin.yoriloveall.workers.dev`) and set in `tests/helpers.js`, but **no file in
   `src/` ever reads it** — verified by grep. Either wire it in (canonical URLs, `og:url`,
   docs examples) or drop it so operators don't think it matters.
2. **Two unused exports:** `isBurned()` (`src/lib/burn.js:63`) and `joinFragments()`
   (`src/lib/html.js:73`). Tiny, but the codebase is otherwise tight enough that these stand out.
3. **`robots.txt` ends with `Sitemap: none`**, which is not a valid value — the directive
   expects an absolute URL. Harmless (crawlers ignore it), but it should be a real sitemap or
   removed.
4. **No password-recovery path.** There is no email field, no reset flow, and no username
   change (usernames are 4–6 characters — a very tight namespace that can also exhaust). A
   user who forgets a password loses the account permanently; so does an account whose hash was
   written above the Workers PBKDF2 ceiling (`verifyPassword` warns and fails closed — reachable
   only by pointing local dev at the production database, but there is no operator escape hatch
   beyond deleting the account via SQL).

**Design trade-offs worth knowing about**

5. **All rate limiting and view dedupe is database writes.** Every limited request performs an
   upsert against a shared Turso database, so abuse traffic costs write throughput and latency
   on the same store as the product. This is a legitimate "no extra infrastructure" choice and
   limits are generous (60/hr create, 3000/hr API read, 40/15 min auth), but it is the first
   thing that would strain under load. There is no caching layer anywhere (`Cache-Control:
   no-store` on most HTML), and `ensureSchemaOnce` is per-isolate only.
6. **IP trust follows Cloudflare headers.** `cf-connecting-ip` / `x-forwarded-for` are trusted
   verbatim. Behind the Worker that is correct; on the Node dev server (or any non-Cloudflare
   deployment) those headers are client-controlled, so rate limits, view dedupe and admin login
   throttling can be spoofed. The dev server binds `0.0.0.0` by default, which matters if it is
   ever exposed beyond a laptop/preview.
7. **`img-src https:` widens the CSP on purpose** — any remote thumbnail can act as a beacon
   that logs the IP of every paste reader. It is documented, reasoned about, and warned about in
   the editor, but it is the single largest privacy compromise in an otherwise strict posture.
8. **Thumbnails are not permanent and not private.** catbox routinely refuses Worker IPs, so the
   common path is 0x0.st, which expires files in 30 days–1 year. Deleting/burning a paste
   removes the link, never the file: a one-time paste's picture is not one-time. Again documented.
9. **Admin is one shared password** with no per-operator identity, no 2FA and no session UI —
   the audit log records a random per-session actor, so "who did this" is unanswerable by design.
   Fine for a solo instance; a blocker for a team.
10. **Inline, awaited housekeeping.** `POST /p` awaits up to 500 expiration deletes before
    redirecting; view counting and `last_used_at` touches also sit on the request path. No
    `ctx.waitUntil` anywhere, so p99 latency absorbs backlog work that could be dropped into the
    background.

**Test coverage**

11. **Tests run on Node's SQLite, not workerd/libSQL.** The harness is excellent (real DB, real
    router, real crypto with a hand-rolled PBKDF2 cap simulation), but it cannot catch
    runtime-only behaviour of the deployed Worker or Turso-specific semantics. There is no
    `wrangler dev`/Miniflare integration job and no CI job that actually builds against a real
    libSQL endpoint — the `withWorkersPbkdf2Cap` helper exists precisely because an over-cap
    factor once "tested green locally and 500'd on the edge".
12. Coverage is feature-dense (thumbnail tests alone are 40 cases) and the security-sensitive
    paths — password, burn, fork, admin, unlock, schema migration — all have dedicated suites.
    What is *not* covered: load/perf characteristics, concurrent maintenance against live writes,
    and the Node dev server's static-file path.

---

## 6. Verdict

This is a mature, unusually well-documented small application. The standout qualities are
architectural rather than feature-level: one router shared by prod/dev/tests, one config module
feeding both HTML and JSON validation, escaping-by-construction templates, an append-only
migration list, exactly-once semantics implemented as a single conditional `UPDATE`, fail-closed
admin auth, and security headers/CSP that survive an on-the-wire check. 185 green tests,
a clean typecheck, a successful Worker bundle, and a live end-to-end smoke test all confirm the
documentation is honest.

The weaknesses are the flip side of its minimalism: no password recovery, DB-backed rate
limiting on the hot path, a privacy-widening `img-src`, third-party thumbnail dependencies, and
a test suite that stops short of the real edge runtime. None of them are defects — they are the
places where the next round of work would pay off.

*Highest-value follow-ups, cheapest first:* remove or wire `SITE_URL`; delete the two unused
exports; fix the `Sitemap:` line; add a Miniflare/`wrangler dev` smoke test to CI; then decide
whether password recovery, per-operator admin accounts, or an edge-cache layer is the next real
feature.
