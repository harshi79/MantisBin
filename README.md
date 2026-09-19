# MantisBin

**Stay sharp. Paste faster.**

A fast, minimal paste-sharing utility for plain text and code.
**PASTE → SAVE → SHARE → COPY** — nothing else.

- No accounts required (optional accounts raise the limit and unlock edit/delete)
- Optional public profiles: accounts can publish pastes to an opt-in `/u/name` page with a generated avatar; everything else stays unlisted
- Account settings: change password, manage sessions, delete account (pastes are kept but anonymised)
- Unlisted pastes only: no feeds, no search, no discovery, `noindex` everywhere it matters
- Filename-first editor: new pastes start as `untitled.txt`, and the extension picks the language (`app.py` → Python) unless you choose one explicitly
- Manual syntax highlighting for 27 languages, rendered server-side (zero client JS needed to read a paste)
- Optional password protection: a paste stays locked — title and content both hidden — until the passphrase is verified
- Burn after reading: a one-time paste is deleted the moment it is first viewed (or first read, including `raw`/API)
- Duplicate any paste you can read: a copy gets its own URL, expiration and owner, and the original is untouched
- Auto language detection reads the filename extension first, then bounded content fingerprints, and resolves once; optional dependency-free QR sharing uses only the canonical URL
- Dark + light themes, system fonts only, no webfont/CDN requests
- Public JSON API with key-gated writes
- Built for **Cloudflare Workers + Cloudflare Assets**, backed by **Turso (libSQL/SQLite)**

---

## Quick start (local, zero credentials)

```bash
npm install
npm run dev        # http://localhost:8787
```

The dev server runs the *exact same* application code as the production Worker,
using Node 22's built-in SQLite (`.data/mantisbin.db`). No cloud account needed.

```bash
npm test           # 98 end-to-end + unit tests (node:test)
npm run typecheck  # tsc --noEmit over JSDoc-typed JS
npm run build      # wrangler deploy --dry-run (bundles the Worker + assets)
npm run clean-expired   # manual expiration sweep
```

## Deploy to Cloudflare

1. Create a Turso database and note the URL + auth token:

   ```bash
   turso db create mantisbin
   turso db show mantisbin --url     # libsql://….turso.io
   turso db tokens create mantisbin
   ```

2. Configure secrets (never commit them):

   ```bash
   wrangler secret put TURSO_DATABASE_URL
   wrangler secret put TURSO_AUTH_TOKEN
   wrangler secret put APP_SECRET      # random string; pseudonymises IPs for view counts
   ```

3. Point `vars.SITE_URL` in `wrangler.jsonc` at your domain, then:

   ```bash
   npm run deploy
   ```

The schema is created automatically on first request. A cron trigger
(`13 * * * *`) deletes expired pastes and prunes sessions, view-dedupe rows and
rate-limit buckets; creation also sweeps opportunistically, so expired content
never lingers.

Local dev *with* Turso: copy `.dev.vars.example` to `.dev.vars` and fill in the
values — `npm run dev` then uses the real database.

---

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | The editor. Filename (starts as `untitled.txt`; the extension picks the language), language, font, size, expiration, paste, save. |
| `POST /p` | Create a paste (form-encoded; works without JS) |
| `GET /p/:id` | View a paste (public, unlisted, `noindex`). Shows the unlock screen when the paste is protected; consumes a burn-after-reading paste |
| `POST /p/:id/unlock` | Verify a protected paste's passphrase, set the signed unlock cookie, redirect back to the paste |
| `GET /p/:id/fork` | "Duplicate" — a pre-filled editor for a copy. Saving posts to the ordinary `POST /p`, so create limits and validation apply unchanged |
| `GET /p/:id/raw` | Exact bytes as `text/plain` — for `curl`, scripts, terminals (`?download=1` forces attachment) |
| `GET /p/:id/qr` | Server-rendered QR share page; encodes only the canonical paste URL |
| `GET /p/:id/qr.svg` | Dependency-free QR image (`?line=N&download=1` saves it) |
| `GET/POST /p/:id/edit` | Edit **your own** paste (account required) |
| `POST /p/:id/delete` | Delete **your own** paste |
| `GET/POST /login`, `GET/POST /register`, `POST /logout` | Accounts (username + password only) |
| `GET /me` | My pastes + API keys |
| `GET /me/settings` | Account settings: profile link, password, sessions, delete |
| `POST /me/password` | Change password (revokes other sessions) |
| `POST /me/sessions/revoke` | Revoke one session |
| `POST /me/delete` | Delete account, anonymise owned pastes |
| `GET /u/:username` | Public profile: avatar, stats, public pastes (indexable, opt-in) |
| `GET /u/:username/avatar.svg` | Deterministic avatar image (immutable) |
| `GET /api/users/:username` | Profile metadata as JSON (public) |
| `GET /docs` | API documentation |
| `GET /api/health`, `GET /api/meta` | Liveness + vocabularies/limits (public) |
| `POST /api/pastes` | Create via API (**API key required**) |
| `GET /api/pastes/:id`, `GET /api/pastes/:id/raw` | Fetch via API (public, no key). `401` while a protected paste is locked |
| `POST /api/pastes/:id/unlock` | Scriptable unlock: verifies the passphrase, returns the same `HttpOnly` cookie (`401` on a wrong passphrase, `429` when rate limited) |
| `POST /api/pastes/:id/fork` | Copy a paste: a key makes the copy owned by that account, no key makes it anonymous (public) |
| `GET /api/pastes/mine`, `PATCH /api/pastes/:id`, `DELETE /api/pastes/:id` | Key-gated management |
| `/app.css`, `/app.js`, `/robots.txt` | Static files served by Cloudflare Assets |
| `/favicon.svg`, `/logo.svg`, `/mark.svg` | Brand assets, generated from one source (`src/assets/mark.js`) |

## Limits & behaviour

### Duplicating a paste (2.2 §3)

"Duplicate" on a paste view opens a pre-filled editor; saving creates a normal
paste from the create endpoint, so nothing about the copy bypasses validation,
limits or ownership rules.

- The copy gets a new random id, its own expiration (the source's remaining
  lifetime, rounded up to the next preset — or `never` for a `never` source), its
  own view count and its own password/burn settings. The source keeps its URL,
  content, expiration, view count and owner.
- Ownership follows the actor: anonymous → anonymous copy, signed-in → copy owned
  by that account, API key → copy owned by that account's team (`user_id`).
- Limits are the actor's limits: 5 MB / 60 per hour per IP for anonymous copies,
  10 MB / 300 per hour per key for API copies.
- A protected source must be unlocked first; the API answer is `401` and the web
  screen is the unlock page, which returns to the duplicate screen afterwards.
  Owners (session or their own API key) never need the passphrase.
- A one-time source is **consumed** by duplicating it — copying hands the content
  over exactly like a view does — so a `read`/`view` paste yields one copy and
  then 404s for everyone.
- Passwords are never copied (the server cannot read them back): the copy starts
  unprotected and may be given a new one.

### Burn after reading (2.2 §2)

`expiration` and *burning* are separate: expiry is a deadline, burning is
consumption. The creator picks one of three modes (`after reading` on the editor,
`burnAfter` in the API):

| Mode | Consumed by |
| --- | --- |
| `never` (default) | nothing — the paste lives until it expires |
| `view` | the first successful HTML view (`GET /p/:id`) |
| `read` | the first successful content read of any kind: HTML view, `/p/:id/raw`, `GET /api/pastes/:id`, `GET /api/pastes/:id/raw` |

- Consumption is claimed with one atomic statement —
  `UPDATE pastes SET burned = 1 WHERE id = ? AND burned = 0 AND burn_mode <> 'never'` —
  so of any number of concurrent requests **exactly one** is served and every
  other one gets the standard `404`. The winner deletes the row as it answers;
  `runMaintenance` sweeps anything a crashed request left behind.
- Only *successful* reads consume a paste: a lock screen, a wrong passphrase, a
  `401`, a `404`, an expired paste, a rate-limited request or a failed unlock
  never burns one.
- A one-time paste is one-time for its owner too — the metadata badge warns about
  it before the read.
- The chosen mode is shown in the creator form, on the paste metadata, in the
  unlock screen and as `burnAfter` in API responses — never together with content
  that has not been unlocked.

| | Anonymous | Account / API key |
| --- | --- | --- |
| Max paste size | 5 MB | 10 MB |
| Edit / delete | via expiration only | yes, own pastes |
| Public profile | — | yes, per paste (opt-in) |
| Create rate limit | 60/hour per IP | 60/hour per account (web), 300/hour per key (API) |

- Paste IDs: 8 random base62 characters (`/p/a8Kx92Lm`) — no sequential ids, no custom slugs.
- Expirations: 10 min, 1 h, 6 h, 1 day, 1 week, 30 days, 1 year, **never**. Expired rows are deleted.
- Titles: required, ≤ 120 chars. Usernames: 4–6 letters/digits. Passwords: ≥ 8 chars, PBKDF2-SHA256 (100k — the Cloudflare Workers ceiling).
- Paste passphrases (optional): ≥ 6 chars, ≤ 256, stored only as a PBKDF2-SHA256 hash with a per-paste salt. Unlocking lasts 30 minutes in an `HttpOnly; SameSite=Lax` cookie, and is capped at 10 attempts / 15 min per paste + IP (`429` + `Retry-After`).
- Burn modes: `never` (default), `view`, `read`. A burned paste is deleted, not archived — the winning read is the only read.
- Duplicating counts as a content read: the copy follows the actor's limits (5 MB / 60 per hour per IP anonymous, 10 MB / 300 per hour per key), and duplicating a one-time paste consumes it.
- View counts dedupe repeat visitors per paste for 6 hours (IPs stored only as HMAC hashes).
- Reads via API: 3000/hour per IP. Auth endpoints: 40/15 min per IP. All limits are abuse guards, not quotas.
- Highlighting + linkification are skipped above 256 KB so huge pastes render instantly; `/raw` always returns exact bytes. Auto language detection examines at most a 64 KiB prefix and resolves a paste over the 256 KiB heavy-work threshold to plaintext.

## Release roadmap

### MantisBin 2.1.0 — shipped in this branch

MantisBin 2.1 keeps the minimal, unlisted-paste model while improving the daily editor and viewer workflow:

- **Local draft recovery:** the new-paste form autosaves a browser-local draft after a short pause, restores it only when the user chooses, and clears it after a successful save or by explicit action. Draft content is never sent to the server by the autosave feature. For responsiveness and browser quota safety, drafts over 1 MB are not autosaved.
- **Line numbers and anchors:** normal-sized highlighted paste views render clickable line numbers with stable `#line-N` anchors. The “Copy line link” control copies the current paste URL, including the selected line when present. Large-paste rendering intentionally skips line wrappers along with highlighting to preserve the fast path.
- **Download:** paste views provide a download action and `/p/:id/raw?download=1` returns an attachment using a safe title-derived filename. The normal `/raw` route remains inline and continues to return exact text bytes.
- **Native sharing:** the Share control uses the browser Web Share API when available and falls back to copying the canonical paste URL. It never sends content to a third-party sharing service.
- **CSP cleanup:** share/key inputs use `public/app.js` event listeners instead of inline `onclick` handlers, preserving the strict Content Security Policy.

The 2.1 test suite contains 39 end-to-end and unit tests (89 after the 2.2 §1–§3 work). Run `npm test`, `npm run typecheck`, and `npm run build` before deployment.

### MantisBin 2.2 — shipped one feature at a time

This is the source of truth for the 2.2 work. Keep the product private, unlisted, dependency-light, and usable without JavaScript wherever practical. Do not add a public feed, global search, trending page, comments, or social discovery as part of 2.2.

| # | Feature | Status |
| --- | --- | --- |
| 1 | Password-protected pastes | **shipped** |
| 2 | Burn-after-reading pastes | **shipped** |
| 3 | Fork / duplicate paste | **shipped** |
| 4 | Optional automatic language detection | **shipped** |
| 5 | QR sharing | **shipped** |

#### 1. Password-protected pastes — shipped

Implementation notes:

- Stored as `pastes.password_hash` (`ALTER TABLE` migration, appended to `MIGRATIONS`
  in `src/db/schema.js`, so existing databases upgrade on the next cold start).
- Policy (documented in `/docs` too): before unlock a visitor only sees
  "this paste is password-protected" plus safe metadata — paste id, created/expiry
  timestamps and the view count. The title counts as content and is hidden.
  The web view answers `200` with the unlock screen; `/p/:id/raw`, the API JSON
  and the API raw endpoint answer `401` and never include a paste object.
- Unlock proof is a stateless `HMAC-SHA256(APP_SECRET)` token over
  `pasteId | expiry` in an `mb_unlock` `HttpOnly; SameSite=Lax` cookie
  (30 minutes, up to 3 pastes at once) — no new table, no session row.
- `POST /p/:id/unlock` (HTML form, no JS needed) and `POST /api/pastes/:id/unlock`
  (JSON, returns the cookie for `curl -c`) share one rate-limit bucket:
  `unlock:<pasteId>:<ip>`, 10 attempts / 15 min, `429` + `Retry-After`.
- Views are only counted after a successful unlock; ownership and expiry rules are
  unchanged, and owners (session or their own API key) never need the passphrase.


- Anonymous users can optionally set a passphrase while creating a paste; accounts and API clients can use it too. _Shipped: optional `password` field on the editor, `POST /api/pastes` and `PATCH /api/pastes/:id` (owners can add, replace or remove it while editing)._
- Store only a secure password hash, never the passphrase or a passphrase in the URL.
- The HTML view, normal raw endpoint, API JSON endpoint, and API raw endpoint must all require successful password verification before returning content.
- Metadata that does not reveal content may be shown before unlock, but the title/content policy must be decided consistently across web and API responses.
- Preserve normal expiration, unlisted/noindex behavior, safe headers, rate limits, and ownership rules.
- Define a short-lived, HttpOnly unlock session/cookie so users do not re-enter the passphrase on every request; never expose the passphrase to client JavaScript.
- Add brute-force protection and tests for correct password, wrong password, expired password-protected paste, raw/API access, and owner management. _Shipped: `tests/password.test.js` (14 end-to-end tests) + `tests/unlock.test.js` (9 unit tests)._

#### 2. Burn-after-reading pastes — shipped

Implementation notes:

- Two columns on `pastes` (`burn_mode`, `burned`), added through the same
  append-only migration list; existing rows default to `never`/`0`, so nothing
  starts burning on upgrade.
- `src/lib/burn.js` owns the rules: `shouldBurn()` decides per read kind
  (`view` vs `read`), `claimBurn()` is the atomic exactly-once claim, and
  `claimBurnForRead()` is called *after* the password/ownership gate in each of
  the four read routes, so nothing that fails can consume a paste.
- The winner deletes the row before the response is built (the response comes
  from the row it already holds), so a one-time paste is unreachable in the
  database the moment it is served. Losers get the standard `404`.
- `pruneBurned()` runs inside the existing hourly `runMaintenance` — no new cron
  — and `getPaste()` self-heals a stranded burned row on sight.
- `tests/burn.test.js`: 13 tests covering the mode matrix, first-view burn,
  five concurrent readers (exactly one `200` + one body), raw/API burning,
  wrong passwords, lock screens, 429s, expired/missing ids, owner reads, edits,
  the database-level claim and the maintenance sweep.

Add explicit expiration modes for temporary handoffs:

- Delete after the first successful unlocked HTML view.
- Optionally delete after the first successful raw/API content fetch, depending on the selected mode.
- A failed request, wrong password, rate-limited request, or 404 must not burn the paste.
- Deletion and view delivery must be coordinated so concurrent requests cannot both receive a supposed one-time paste.
- Show the selected burn behavior in the creator form and paste metadata without exposing secret content.
- Add database, concurrency, web, raw, API, and maintenance tests. _Shipped: `tests/burn.test.js`._

#### 3. Fork / duplicate paste — shipped

Implementation notes:

- `GET /p/:id/fork` renders the ordinary editor (new `fork` mode) pre-filled from
  the source and posting to the ordinary `POST /p`: no second create pipeline, so
  validation, size limits, rate limits and ownership rules are shared by
  construction. `public/app.js` keeps drafts out of the duplicate screen.
- `POST /api/pastes/:id/fork` performs the copy server-side (201 + the new paste
  object) with optional `title`, `language`, `font`, `fontSize`, `expiresIn`,
  `password` and `burnAfter` overrides; `content` is refused because the copy
  always comes from the source.
- The source is read through the same authorisation gate as a view
  (`canReadPaste` + ownership/API-key ownership), then claimed with
  `claimBurnForRead(..., 'view')`, so a locked source can only be copied after a
  successful unlock and a one-time source is consumed rather than left behind.
- `expirationPresetFor()` (moved into `lib/validate.js`) gives the copy the
  source's remaining lifetime; `tests/fork.test.js` (11 tests) covers
  pre-filling, independence of copies, ownership per actor, overrides, size and
  rate limits, protected-source gating, owner bypass and one-time consumption.

- Add a “Create a copy” action on paste views.
- The source paste remains unchanged and keeps its original URL, expiration, view count, and owner.
- The copy receives a new random ID and its own metadata, expiration, and view count.
- Anonymous users can create anonymous copies; signed-in users/API-key clients create owned copies.
- Copy the title, content, language, font, and font size by default, with an obvious way to edit before saving.
- Do not let duplication bypass size limits, rate limits, password protection, or burn-after-reading rules.
- Decide and document whether protected/burn-on-read sources require unlocking before copying; default should be to require unlock and never copy content from a failed/partial read. _Shipped: both require it — a locked source answers `401` (API) or the unlock screen (web), and a one-time source is consumed by the copy._

#### 4. Optional automatic language detection — shipped

Implementation notes:

- The editor adds an `Auto detect` choice and the API accepts `language: "auto"`.
  Manual language ids always win; `auto` is an input instruction and is never
  stored in `pastes.language`. Since the filename-first refresh, `auto` reads
  the title's extension first (`app.py` → `python`, `Dockerfile` →
  `dockerfile`), then the content fingerprints below; the create form starts as
  `untitled.txt` with `auto` selected.
- `src/lib/detect.js` uses bounded, dependency-free fingerprints for JSON, YAML,
  Markdown, shell, SQL, HTML/XML, CSS, diff and common programming languages.
  It parses at most a 64 KiB prefix, never executes or imports paste content, and
  reuses the existing 256 KiB highlight fast-path by resolving very large pastes
  to `plaintext`.
- The resolved language is written at creation/update time, so every later view
  and API response is deterministic. Ties and weak signals deliberately fall
  back to `plaintext`.
- `tests/detect.test.js` covers clear formats, ambiguous input, manual overrides,
  the web form, API responses, large-input bounds and deterministic storage.

#### 5. QR sharing — shipped

Implementation notes:

- Paste views add a no-JS `QR` link to `/p/:id/qr`. `public/app.js` only enhances
  that link when the current URL has a valid `#line-N` anchor, passing the numeric
  line to the server; the server reconstructs the canonical URL before encoding.
- `src/lib/qr.js` is a local byte-mode QR encoder (level L, versions 1–40) with
  no dependency or CDN. Its API accepts one canonical URL string, so content and
  passphrases cannot become QR payload fields by accident.
- The QR page renders an inline SVG, an accessible read-only URL fallback, copy
  action and a `/p/:id/qr.svg?download=1` save link. Protected QR pages do not
  reveal the protected title/content and opening the encoded URL still requires
  its passphrase; expired sources return the normal `404`.
- `tests/qr.test.js` covers canonical URLs/anchors, SVG escaping, expiry links,
  protected behavior, downloads and the no-content/no-secret contract.

#### 2.2 completion checklist

Before calling 2.2 complete, update the API docs and README, add migration notes if the schema changes, add end-to-end and unit coverage for every new security-sensitive path, verify no secrets appear in URLs/logs/HTML, and run the full test, typecheck, and Worker dry-run build commands. Preserve the existing promise: **paste → save → share → copy**, with no noisy discovery layer.

| Feature | Tests | README + `/docs` | Migration | Clean runs |
| --- | --- | --- | --- | --- |
| 1. Password-protected pastes | ✅ `tests/password.test.js`, `tests/unlock.test.js` | ✅ | ✅ `pastes.password_hash` | ✅ test / typecheck / build |
| 2. Burn after reading | ✅ `tests/burn.test.js` (13) | ✅ | ✅ `pastes.burn_mode`, `pastes.burned` | ✅ test / typecheck / build |
| 3. Fork / duplicate | ✅ `tests/fork.test.js` (11) | ✅ | none (no schema change) | ✅ test / typecheck / build |
| 4. Auto language detection | ✅ `tests/detect.test.js` | ✅ | none | ✅ test / typecheck / build |
| 5. QR sharing | ✅ `tests/qr.test.js` | ✅ | none | ✅ test / typecheck / build |

## Architecture

```
src/
  worker.js          Cloudflare entry: fetch + scheduled(cron)
  app.js             routing, request context, sessions, security headers, errors
  config.js          every limit/option in one place
  db/
    schema.js        SQLite schema (users, sessions, pastes, api_keys, paste_views, rate_limits)
    turso.js         libSQL adapter (Workers) — the only runtime dependency (@libsql/client)
    node-sqlite.js   Node built-in SQLite adapter (dev + tests), same SQL
  lib/               crypto, auth/sessions/keys, pastes, access (read authorisation),
                     unlock (passphrase + signed unlock cookie), ratelimit, detect, qr, avatar, highlighter, html, http, maintenance
  routes/            web.js (HTML forms) + api.js (JSON) + profile.js (profiles/settings)
  views/             server-rendered pages (escaping-by-construction tagged templates)
  assets/mark.js     the mantis mark: one geometry, reused as inline SVG, favicon, logo
public/              app.css, app.js (progressive enhancement only), robots.txt
scripts/             dev.js (local server), cleanup.js (manual sweep)
tests/               node:test suites against in-memory SQLite
```

Design rules the codebase follows:

- **Server-rendered everything.** Reading a paste needs no JavaScript; `public/app.js`
  only adds niceties (theme switch without reload, byte counter, local draft recovery,
  copy/share buttons, line-link copying, Tab handling and delete confirmations).
- **Strict CSP** (`default-src 'none'; script-src 'self'; style-src 'self'`) — no inline
  scripts/styles or event handlers anywhere, pasted content is escaped at render time and never executed.
- **One source of truth** for validation (config + `lib/validate.js`) shared by the HTML
  and JSON paths, enforced server-side.
- **No Node-only APIs in the Worker path**: WebCrypto, fetch, and libSQL over WebSocket/HTTP.

## Security notes

- Paste passphrases: never stored, never echoed and never put in a URL — the
  database keeps a PBKDF2-SHA256 hash (`pbkdf2-sha256$<iters>$<salt>$<hash>`)
  with a per-paste salt, using the same 100 000-iteration ceiling as accounts.
  The HTML view, `/p/:id/raw`, `/api/pastes/:id` and `/api/pastes/:id/raw` all
  refuse to serve anything before verification; a wrong passphrase, a `401`, a
  `404` or a rate-limited attempt never counts as a view and never unlocks.
- Unlock sessions: an HMAC-SHA256 (`APP_SECRET`) signed token in an `HttpOnly;
  SameSite=Lax` cookie, valid for 30 minutes and bound to one paste id, so a
  token cannot be moved to another paste or forged. Up to 3 pastes stay
  unlocked at once; no extra table is involved.
- What a locked paste shows: the paste id, its created/expiry timestamps and
  its view count — never the title, language, font, size or content (a
  protected paste's title is content). The API returns `401` with an error
  message and no paste object at all.
- Owners (the signed-in account that created the paste, or that account's API
  key) read, edit and delete their own protected pastes without the passphrase.
- One-time pastes: the claim is a single conditional `UPDATE`, so concurrent
  readers cannot both be served; the row is then deleted, and a burned row is
  unreadable even before the delete (both paths are covered by tests).
- Duplication never reads around the gates: the fork routes authorise (and claim
  a burn) exactly like a view before any content is copied, and a copy is stored
  as a brand-new paste owned by the actor — the source row is not touched.
- Automatic language detection is bounded to a 64 KiB prefix and skips the
  existing 256 KiB heavy-render path. It uses only inert fingerprints and a
  capped JSON parse; pasted text is never executed or imported, and ambiguous
  input resolves to stored `plaintext`.
- QR sharing is local and dependency-free. The QR encoder receives only the
  canonical `/p/:id` URL plus an optional validated `#line-N` fragment; it never
  receives content, title or passphrase. Locked QR pages hide the title/content,
  and the encoded link still opens the normal password gate.
- Public profiles are strictly opt-in: only pastes their owner marks `public` appear on `/u/:username` (and in `GET /api/users/:username`), and flipping a paste back to unlisted removes it immediately. Anonymous pastes can never be public. Profile pages are the only indexed discovery surface; paste pages stay `noindex` and `robots.txt` still disallows `/p/`.
- Account deletion is password-confirmed and anonymises rather than orphans: sessions, API keys and the user row are deleted, while owned pastes keep working with the owner cleared and visibility reset to unlisted. Changing a password revokes every other session.
- Passwords: PBKDF2-HMAC-SHA256, 100 000 iterations (the Cloudflare Workers ceiling —
  `deriveBits` throws `NotSupportedError` above it), per-user salt; constant-time compares.
  The iteration count is stored inside every hash, so it can be tuned without locking anyone out.
  Hashes written with more than 100 000 iterations (only possible off-Workers, e.g. `npm run dev`
  against the same database) cannot be recomputed on the edge: those accounts need a password reset.
- Sessions: 256-bit random tokens in `HttpOnly; SameSite=Lax` cookies; only SHA-256 hashes stored.
- API keys: `mb_` + 32 random chars, stored hashed, shown once, max 3 per account.
- Paste pages send `X-Robots-Tag: noindex, nofollow` + `<meta name="robots">`; `robots.txt`
  disallows `/p/`, `/me`, `/login`, `/register`, `/api/` while keeping `/` and `/docs` indexable.
- Raw endpoint sends `nosniff` + `Content-Disposition` so pastes cannot spoof content types.
- Request bodies are size-capped before parsing; oversized inputs never echo back into forms.

## License

MIT
