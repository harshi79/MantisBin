# VibeBin vs MantisBin — Full Analysis of Both Repos

*Both repos read end-to-end, both built and tested locally, both smoke-tested live.
Analysis-only: no source files in either repo were modified.*

| | **VibeBin** | **MantisBin** |
|---|---|---|
| Repo | `harshi79/vibebin` (public, MIT) | `harshi79/MantisBin` (public, MIT) |
| Clone point | `3d64d44` (main, PR #65) | `a939789` (main, PR #19) |
| Last push | 2026-09-10 | 2026-09-27 |
| Merged PRs | **64** | **19** |
| Product sentence | "A free PasteView alternative" — a *social* pastebin | "Stay sharp. Paste faster." — a *minimal* pastebin |

---

# PART 1 — VibeBin

## 1.1 What it is

VibeBin is a **PasteView-style social paste service**. The paste is the excuse; the product is
the *profile and social layer* around it: animated name effects, video banners, custom links,
badges, emoji status, follows, bookmarks, reactions, notifications, stickers and anime GIFs,
plus an admin panel that curates stickers and awards profile tags.

**Stack:** Next.js 15 (App Router, React 19, TypeScript) · Tailwind 4 · Drizzle ORM over
**Turso/libSQL** (SQLite locally) · `jose` JWTs · `bcryptjs` · `nanoid` · `highlight.js`.
Deployed on **Vercel** (`vercel.json`, `TURSO_DATABASE_URL` mandatory in production).

| Metric | Value |
|---|---|
| App code (no tests) | **20,316** lines — `components/` 9,537 · `lib/` 5,715 · `app/` 5,064 |
| Tests | **11,708 lines · 556 tests · 43 files** (Vitest, jsdom + real SQLite) |
| API route handlers | **38** |
| Pages | **20** |
| React components | **49** |
| DB tables | **17** |
| Runtime dependencies | **11** |
| Schema definitions | **4 copies** (see §1.4) |
| CI | **none** (no `.github/`) |
| Docs | **8** top-level markdown files |

## 1.2 Architecture

```
middleware.ts          edge guard: JWT verify for /dashboard /settings /account /admin
src/app/*              Next.js App Router: 20 pages + 38 route handlers (server + client components)
src/components/        49 client components — editor, viewers, name effects, admin, notifications
src/lib/*.ts           31 domain modules: auth, secret, ip, passwordReset, emailOtp, email,
                       pastes, pasteFormat, pasteLimits, expiry, highlight, languages, reactions,
                       likes, bookmarks, follows, notifications, badges, nameEffects, stickers,
                       stickerImport, neko, gifs, socialPlatform, statusEmoji, cursorTrail,
                       editorLineOps, editorSelection, usernameReservations, format
src/lib/db/            gateway (driver switch + inline DDL migrations + seed), schema.ts, seed.ts,
                       migrateReactions.ts
scripts/               one-off tooling: create-sqlite-file, create-upload-db, export-neon,
                       import-turso, validate-migration
```

**Database access:** `getDb()` is a per-process cached promise that creates the client, sets
`PRAGMA foreign_keys = ON`, then either creates all tables (fresh DB) or re-runs an idempotent
`MIGRATION_STATEMENTS` list (existing DB), runs a marker-guarded one-time reaction migration,
then seeds if empty. No migration tool, no version table — just `CREATE … IF NOT EXISTS` on
every cold start.

**Data model (17 tables):** `users`, `profiles`, `pastes`, `password_resets`, `signup_ips`,
`likes`, `tags`, `user_tags`, `stickers`, `email_verifications`, `rate_limits`, `app_meta`,
`username_reservations`, `follows`, `bookmarks`, `reactions`, `notifications`.

Notable modelling: one row per `(user_id, paste_id)` for both `bookmarks` and `reactions`
(composite PK = dedupe for free), a `dedupe_key` unique index to collapse repeated
notifications, a denormalised `pastes.likes_count`, and a one-time migration that folded the
legacy `likes` table into the unified `reactions` table so a like is just `❤️`.

**Editor model:** one unified `contentEditable` editor. Every new paste is stored as
`format='rich'` with a JSON `RichDoc` (per-line text + optional marks: font, size, colour,
link, sticker); legacy `format='plain'` rows still render byte-identically and their URLs never
change. Raw/Download flattens a RichDoc back to readable text.

## 1.3 What it does that MantisBin doesn't

Password reset (one-time 30-minute code, single-use, hashed at rest) · email OTP flows via
Resend · email-less recovery delivered to the requesting device · **follows + follower counts**
· **bookmarks** · **notifications** (follow / like / new post / admin broadcast, with an unread
badge, a full notification centre and polling) · **reactions with a picker** and optimistic UI ·
**admin broadcast messages + sticker picker** · **admin-awarded profile tags** with effects ·
**sticker pack** curated by the admin, with shortcode auto-conversion (`:wave:`, `;fire;`) ·
**anime GIF search** (Nekos.best, keyless) · **rich text** (per-line font/size/colour/links) ·
**profile customisation** (9 animated name effects, speed/intensity, link colours, accent,
avatar/banner URLs — image or `.mp4` video) · **emoji status** · **badges** · profile view
counter · username reservations for the owner · account rename window (one rename in 24 h) ·
admin user management (search, tag assignment) · ready-made SQLite DB export/upload scripts.

## 1.4 Verified health

| Check | Result |
|---|---|
| `npm ci` | clean (150 packages) |
| `npx vitest run` | **556 pass / 0 fail**, 43 files, ~39 s |
| `npx tsc --noEmit` | **clean** (no `typecheck` script exists, though) |
| `npx next build` | **success** — 20 pages + 38 handlers, 103 kB shared JS; `/p/[id]` 7.0 kB / 119 kB |
| Live smoke test (Next dev on :3000) | home 200 (43 KB) · `/api/ping` ok · guest paste created · view + raw work · `javascript:` link in a RichDoc → **400** · 20,001-line doc → **400** · malicious/expired handling correct · protected paste: raw 403, wrong password 401, right password returns content |

Tests are genuinely DB-backed (`createClient({url:'file::memory:'})` + Drizzle + real inserts),
and include React component regression suites (`nameEffects`, `reactionUi`, `followUi`,
`notificationsItem`) rendered with Vite's built-in Oxc JSX transform — no extra plugin. The
paste-link-security suite pins `isSafeLinkValue` **and** proves the API rejects a hostile doc
with 400.

## 1.5 Findings — ordered by severity

### 🔴 Critical

**1. Seeded `demo`/`demo1234` and `nova`/`novapass1` accounts are created on *every* fresh
database — including the first request of a production deploy.** `seedIfEmpty()` in
`src/lib/db/seed.ts` has no `NODE_ENV`/`VERCEL` guard; it fires whenever `users` is empty
(`src/lib/db/index.ts` calls it on both the fresh and existing paths). On a brand-new Turso
database the first visitor can sign in as `demo`, and the seeded paste literally prints the
credentials. Verified: the dev DB contains those accounts, and `POST /api/auth/login`
`{"username":"demo","password":"demo1234"}` returns 200 with a valid cookie.

**2. No rate limiting on authentication, admin login, or paste creation.** The `rate_limits`
table is used *only* by the email-OTP flows. Measured live:
`12 × wrong /api/auth/login → 401 401 … 401` (no 429) · `8 × wrong /api/admin/login → 401 × 8`
(no 429) · `25 × guest POST /api/pastes → 200 × 25`. The only throttle of any kind is
"3 accounts per IP" at registration.

**3. Cookies are `SameSite=None; Partitioned` on HTTPS, with no CSRF defence anywhere.**
`getCookieOptions()` in `src/lib/auth.ts` sets `sameSite:'none'`, `secure`, `partitioned`
whenever the request is HTTPS/production — verified on the wire with `x-forwarded-proto: https`:
`vb_session=…; Secure; HttpOnly; SameSite=none; Partitioned`. There is **no CSRF token and no
Origin/Referer check on any mutating route** (verified: a login POST with
`Origin: https://evil.example` returns 200). CHIPS (partitioned) neutralises this in modern
Chrome, but Firefox and non-CHIPS engines will attach the cookie to a cross-site request, so
every state-changing endpoint — including `/api/admin/*` — is CSRF-reachable there. The
`Partitioned` attribute was clearly added for embedded/preview contexts, but SameSite=None is
the wrong lever for that when the API has no CSRF layer.

### 🟠 High

**4. No security headers at all.** The only header in the entire app is
`X-Content-Type-Options: nosniff` on the raw route. No CSP, no `X-Frame-Options`/`frame-ancestors`
(so the app is clickjackable), no `Referrer-Policy`, no HSTS, no `Permissions-Policy`. In a
React app the XSS surface is smaller, but `dangerouslySetInnerHTML` *is* used in
`HighlightedCode.tsx`, and the missing CSP removes the second line of defence entirely.

**5. Sessions are stateless JWTs — they cannot be revoked.** There is no `sessions` table;
logout only expires the cookie, `/account` lists nothing, and **changing the password does not
invalidate outstanding tokens**. A stolen `vb_session` (or a leaked `AUTH_SECRET`) is valid for
the full 30 days (admin: 8 h) with no kill switch.

**6. No byte cap on paste content — only ≤20,000 lines.** Verified: a **2 MB single-line guest
paste returned 200**. `src/lib/pasteLimits.ts` states this explicitly ("No application-level
character limit"). With no creation rate limit (#2), this is an unauthenticated storage-filling
vector against the Turso quota — and the abuse is invisible to the admin panel, which has no
"largest pastes" view.

**7. A password-protected paste can never be raw-copied or downloaded.** `/p/:id/raw` returns
`403 this paste is password protected` unconditionally and ignores any unlock state, because
unlocking is per-request (`POST /api/pastes/:id/unlock`) and never recorded. Verified: after a
correct unlock, the Raw URL still answers **403**. The UI still offers Raw/Download buttons,
so this reads as a bug, not a policy.

### 🟡 Medium

**8. The compromised fallback secret is still live in `likes.ts`.** `src/lib/secret.ts`
blacklists `'vibebin-dev-secret-do-not-use-in-production-change-me'` and refuses to sign tokens
with it — but `src/lib/likes.ts:42` still uses exactly that string as the anonymous-like IP-hash
salt when `AUTH_SECRET` is unset. The auth module fails closed; the privacy salt quietly fails
open, so IP hashes become trivially reversible (rainbow table over IPv4 space).

**9. Admin password compared with `!==`** in `src/app/api/admin/login/route.ts` (not
constant-time) **and unlimited attempts** (#2). `ADMIN_PASSWORD` strength is the only defence.

**10. Four copies of the schema, and they have already drifted.** `schema.ts` (Drizzle),
`db/index.ts` (17 `CREATE TABLE` strings), `scripts/create-sqlite-file.ts` and
`scripts/create-upload-db.ts` (9 tables each). The two script copies **omit `reactions`,
`notifications` and `email_verifications`** — so the documented "create a DB file and upload it
to Turso" path produces a database missing three tables. Also: those scripts have a
`#!/usr/bin/env tsx` shebang but **`tsx` is not a declared dependency**, so they don't run.

**11. Dead / misplaced dependencies.** `@electric-sql/pglite` is a prod dependency referenced
only in `next.config.mjs`'s `serverExternalPackages` (no import anywhere) — leftover from the
Neon era. `postgres` is a prod dependency imported only by `scripts/export-neon.ts`.
Next.js + React account for the rest.

**12. Best-effort counters on a multi-instance serverless runtime.** View dedupe is a
3-second in-process `Map` and the expiry purge is throttled by a `globalThis` timestamp — per
serverless instance, not global. Under concurrency view counts inflate and purges run more often
than the "once per 5 min" comment implies.

### 🔵 Hygiene / process

**13. No CI, no lint, no typecheck script.** No `.github/` at all; `npm test` is the only check
(`tsc` passes today — I ran it — but nothing enforces it). MantisBin runs tests + typecheck +
bundle on Node 22/24 in CI; VibeBin merged 64 PRs with zero automated gate.

**14. Documentation sprawl with stale/oversold claims.** Eight top-level markdown files
(`README`, `HOSTING`, `MIGRATION`, `MIGRATION-SUMMARY`, `COMPLETION-SUMMARY`,
`README-TURSO`, `STEP-BY-STEP-GUIDE`, `TASKS`) overlap heavily; `COMPLETION-SUMMARY.md` claims
"✅ Zero breaking changes · ✅ Zero data loss · 10x faster cold starts" — the kind of line that
rots. Meanwhile the README's "Quick start" advertises the demo login as a *feature*, which is
finding #1.

---

# PART 2 — Head-to-head

## 2.1 Same author, opposite products

| Dimension | **VibeBin** | **MantisBin** |
|---|---|---|
| Product model | Social network around pastes (profiles, feeds, follows, reactions) | Private utility: paste → save → share → copy |
| Discovery | Public profiles, follows, notifications, trending-ish surfaces | **No** discovery: unlisted by default, opt-in `/u/` profiles only |
| Runtime | Vercel serverless (Next.js Node runtime) + edge middleware | Cloudflare Workers (edge) + static assets |
| Framework | Next.js 15 / React 19 / Tailwind 4 | Zero-framework: server-rendered HTML, tagged-template views |
| Language | TypeScript | JavaScript + JSDoc (typechecked with `checkJs`) |
| DB | Turso/libSQL + Drizzle (17 tables) | Turso/libSQL + hand-written SQL (8 tables) |
| Runtime deps | **11** (next, react, react-dom, drizzle, libsql, jose, bcryptjs, nanoid, highlight.js, pglite†, postgres†) | **1** (`@libsql/client`) |
| App LOC (no tests) | 20,316 | 8,878 |
| Tests | 556 tests / 43 files / 11.7k lines | 185 tests / 14 files / 4.9k lines |
| CI | ❌ none | ✅ GitHub Actions (Node 22 + 24: test + typecheck + bundle) |
| Typecheck | passes, not enforced | `npm run typecheck` in CI |
| Works without JS | ❌ React app; editor/viewer are client components | ✅ forms + reading work with JS disabled |
| Auth | JWT cookies (stateless), bcrypt(10) | DB-hashed sessions, PBKDF2 100k, API keys |
| Session revocation | ❌ (logout = cookie clear) | ✅ session list, revoke, revoke-others on password change |
| Password recovery | ✅ one-time 30-min code + email OTP | ❌ none (a forgotten password loses the account) |
| Admin | Shared password, **no rate limit**, no audit log | Shared password, **5/15 min + global throttle**, CSRF token, 1 h TTL, **audit log in the same transaction** |
| Rate limiting | ❌ auth/admin/create unlimited; signup 3/IP; email OTP only | ✅ every mutation class (create, API, auth, unlock, thumbnail, admin) |
| CSRF | ❌ no token, no Origin check, `SameSite=None` on HTTPS | ✅ SameSite=Lax cookies + exact-origin + CSRF token on admin |
| Security headers / CSP | ❌ none (nosniff on raw only) | ✅ strict CSP (`default-src 'none'`), frame-ancestors, Permissions-Policy, Referrer-Policy, nosniff |
| Content limits | ≤20,000 lines, **no byte cap** (2 MB single line accepted) | 5 MB anon / 10 MB account, body cap before parse, 256 KB highlight cutoff |
| Password-protected pastes | ✅ gate, ❌ raw/download permanently 403 | ✅ gate with 30-min unlock cookie, raw/API honour it |
| Burn after reading | ❌ | ✅ atomic exactly-once `view`/`read` claims |
| Duplicate/fork, QR | ❌ | ✅ both (QR encoder is local, dependency-free) |
| Thumbnails / media | ✅ avatars, banners (image/`.mp4`), stickers, GIFs — URLs only | ✅ one optional thumbnail, resized client-side, URL only |
| Syntax highlighting | highlight.js, 18 languages, server-side | hand-written highlighter, 27 languages, server-side |
| Rich text | ✅ per-line font/size/colour/links/stickers | ❌ plain text + code (by design) |
| Social features | ✅ follows, bookmarks, reactions, notifications, tags, badges, name effects | ❌ none (deliberate) |
| Public JSON API | implicit route handlers, no versioning/docs page | documented `/api/*` + `/docs` page + `/api/meta` contract |
| Schema evolution | idempotent DDL re-run every boot, 4 copies (drifted) | 6 append-only `ALTER TABLE` migrations, 1 source of truth |
| Perf work | PR #64/#65: indexes, `UPDATE … RETURNING`, flat fan-out | opportunistic cleanup, `no-store`, per-isolate schema cache |
| Docs | 8 overlapping files, some stale claims | 1 README (900 lines) + `/docs` + deploy notes, all accurate |

† unused in production code.

## 2.2 Where each one genuinely wins

**VibeBin wins on:** scope and product surface (it does ~3× the features); perceived
"alive-ness" (profiles, notifications, reactions); **password recovery**, which MantisBin lacks
entirely; the rich editor; a much larger test suite measured in raw cases; admin tooling for
users/tags/stickers/broadcasts; and honest observability of its own perf work (PR #64/#65 are
real, index-backed fixes).

**MantisBin wins on:** deployment cost and latency (edge worker, 106 kB gzip, 1 dependency);
**security engineering** — strict CSP, CSRF, session revocation, rate limits everywhere, and a
fail-closed, audited admin; **data integrity** (one schema source, append-only migrations,
atomic exactly-once burn claims); a documented API contract; and the discipline of shipping far
fewer features at a much higher standard (185 tests cover nearly every route end-to-end, versus
VibeBin's 556 mostly unit/component cases with no route-level integration harness).

## 2.3 What each should steal from the other

**VibeBin should adopt from MantisBin (roughly in this order):**
1. Guard the seed behind `NODE_ENV !== 'production'` **and** delete the seeded accounts from any
   existing production DB (rotating `AUTH_SECRET` does not remove them).
2. Add a `rate_limits`-table throttle to `login`, `admin/login`, `pastes` create and `unlock` —
   the table and the `rateLimitAllow()` helper already exist; it's wiring, not design.
3. Add a CSRF layer (double-submit token or strict Origin/Host check on every mutating route),
   then reconsider `SameSite=None` — keep `Partitioned` for embeddings and drop back to `Lax`
   with an explicit preview exception, exactly as MantisBin gates its preview mode behind
   `DEV_PREVIEW`.
4. Add security headers in `next.config.mjs` (`headers()`): CSP, frame-ancestors, HSTS,
   Referrer-Policy, Permissions-Policy.
5. A `sessions` table (hashed tokens) so logout, password change and admin action can revoke.
6. A byte ceiling on paste content, plus a "largest pastes" admin view.
7. Make `/p/:id/raw` honour the unlock state, or hide Raw/Download on locked pastes.
8. One schema source: generate the scripts' DDL from `db/index.ts`, or delete the scripts'
   copies; drop `pglite`/`postgres` from prod deps and declare `tsx` (or drop the scripts).
9. CI: `npm ci && npx tsc --noEmit && npx vitest run && npx next build`.

**MantisBin should adopt from VibeBin:**
1. **Password recovery** — the single biggest product gap in MantisBin. VibeBin's design
   (hashed, single-use, 30-minute token) ports directly; MantisBin already has the crypto and
   rate-limit primitives plus an admin audit trail to log resets.
2. A **break-glass admin action** to reset/delete an account whose hash can't be verified on the
   edge (the PBKDF2-ceiling case it warns about).
3. VibeBin's **view-dedupe/purge throttling idea** (MantisBin currently pays a DB write per
   limited request; a cheap in-isolate gate in front of the DB check would cut hot-path writes).
4. Component-level regression tests for its client script (`public/app.js` is 35 KB with no
   direct test coverage — VibeBin's jsdom component suites are a good model).
5. An explicit "largest pastes / storage" view for the instance operator.

## 2.4 Shared risks (both repos)

- **Turso is a single point of failure and an abuse magnet.** Neither caches anything in front
  of it, and both write on the hot path (MantisBin: rate-limit buckets and view dedupe;
  VibeBin: view counters). VibeBin's unlimited guest creation and MantisBin's 5 MB anon paste
  both spend a metered resource with no per-account quota.
- **IP trust is header trust.** Both read `x-forwarded-for`/`cf-connecting-ip` and use it for
  limits, dedupe and (in VibeBin's case) signup caps. Correct behind their own platform, spoofable
  anywhere else — and both bind dev servers to `0.0.0.0`.
- **Third-party egress**: VibeBin pulls Nekos.best/Giphy/Resend; MantisBin forwards uploads to
  catbox/0x0.st. Each outbound dependency is a privacy note and an availability cliff that the
  feature description understates.
- **No dependency-audit step** in either CI (MantisBin has CI but doesn't run `npm audit`).
- **Both are effectively single-operator services**, and neither offers per-operator admin
  accounts or 2FA.

---

# PART 3 — Verdict

Both are genuinely mature, but they are mature in **opposite directions**, and that is what
makes the comparison useful.

**VibeBin is a breadth-first product with a security-debt tail.** It ships a real social
platform — profiles, follows, reactions, notifications, stickers, email/password recovery,
rich text — on a modern stack, and its test culture is real (556 tests, DB-backed, JSX
regression suites). But three of its defaults would be dangerous in public production — the
**seeded demo credentials on every fresh database**, **unlimited login/admin/create attempts**,
and **`SameSite=None` cookies with no CSRF layer and no security headers** — and there are two
outright functional gaps (**no byte cap** on content; **raw/download permanently blocked** for
protected pastes). All of these are a few days of focused work, not a rewrite. It has no CI to
catch regressions in the meantime.

**MantisBin is a depth-first product with a feature tail.** Its engineering is the better of the
two by a clear margin: one dependency, strict CSP, CSRF, revocable hashed sessions, rate limits
on every mutation class, audited fail-closed admin, append-only migrations, atomic exactly-once
burn semantics, and CI that runs tests + typecheck + bundle. What it lacks is what VibeBin is
rich in — most importantly **password recovery**, without which a forgotten password means a
permanently lost account.

If I were deploying one tomorrow under real abuse pressure, I'd deploy **MantisBin** and spend
the next sprint porting VibeBin's recovery flow into it. If I were building for engagement and
growth, I'd deploy **VibeBin** — after fixing findings #1–#4, which are the difference between a
demo with a known password and a service. Neither needs new features; each needs the other's
strongest habit.
