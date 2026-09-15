# MantisBin

**Stay sharp. Paste faster.**

A fast, minimal paste-sharing utility for plain text and code.
**PASTE → SAVE → SHARE → COPY** — nothing else.

- No accounts required (optional accounts raise the limit and unlock edit/delete)
- Unlisted pastes only: no feeds, no search, no discovery, `noindex` everywhere it matters
- Manual syntax highlighting for 27 languages, rendered server-side (zero client JS needed to read a paste)
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
npm test           # 39 end-to-end + unit tests (node:test)
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
| `GET /` | The editor. Title, language, font, size, expiration, paste, save. |
| `POST /p` | Create a paste (form-encoded; works without JS) |
| `GET /p/:id` | View a paste (public, unlisted, `noindex`) |
| `GET /p/:id/raw` | Exact bytes as `text/plain` — for `curl`, scripts, terminals (`?download=1` forces attachment) |
| `GET/POST /p/:id/edit` | Edit **your own** paste (account required) |
| `POST /p/:id/delete` | Delete **your own** paste |
| `GET/POST /login`, `GET/POST /register`, `POST /logout` | Accounts (username + password only) |
| `GET /me` | My pastes + API keys |
| `GET /docs` | API documentation |
| `GET /api/health`, `GET /api/meta` | Liveness + vocabularies/limits (public) |
| `POST /api/pastes` | Create via API (**API key required**) |
| `GET /api/pastes/:id`, `GET /api/pastes/:id/raw` | Fetch via API (public, no key) |
| `GET /api/pastes/mine`, `PATCH /api/pastes/:id`, `DELETE /api/pastes/:id` | Key-gated management |
| `/app.css`, `/app.js`, `/robots.txt` | Static files served by Cloudflare Assets |
| `/favicon.svg`, `/logo.svg`, `/mark.svg` | Brand assets, generated from one source (`src/assets/mark.js`) |

## Limits & behaviour

| | Anonymous | Account / API key |
| --- | --- | --- |
| Max paste size | 5 MB | 10 MB |
| Edit / delete | via expiration only | yes, own pastes |
| Create rate limit | 60/hour per IP | 60/hour per account (web), 300/hour per key (API) |

- Paste IDs: 8 random base62 characters (`/p/a8Kx92Lm`) — no sequential ids, no custom slugs.
- Expirations: 10 min, 1 h, 6 h, 1 day, 1 week, 30 days, 1 year, **never**. Expired rows are deleted.
- Titles: required, ≤ 120 chars. Usernames: 4–6 letters/digits. Passwords: ≥ 8 chars, PBKDF2-SHA256 (100k — the Cloudflare Workers ceiling).
- View counts dedupe repeat visitors per paste for 6 hours (IPs stored only as HMAC hashes).
- Reads via API: 3000/hour per IP. Auth endpoints: 40/15 min per IP. All limits are abuse guards, not quotas.
- Highlighting + linkification are skipped above 256 KB so huge pastes render instantly; `/raw` always returns exact bytes.

## Release roadmap

### MantisBin 2.1.0 — shipped in this branch

MantisBin 2.1 keeps the minimal, unlisted-paste model while improving the daily editor and viewer workflow:

- **Local draft recovery:** the new-paste form autosaves a browser-local draft after a short pause, restores it only when the user chooses, and clears it after a successful save or by explicit action. Draft content is never sent to the server by the autosave feature. For responsiveness and browser quota safety, drafts over 1 MB are not autosaved.
- **Line numbers and anchors:** normal-sized highlighted paste views render clickable line numbers with stable `#line-N` anchors. The “Copy line link” control copies the current paste URL, including the selected line when present. Large-paste rendering intentionally skips line wrappers along with highlighting to preserve the fast path.
- **Download:** paste views provide a download action and `/p/:id/raw?download=1` returns an attachment using a safe title-derived filename. The normal `/raw` route remains inline and continues to return exact text bytes.
- **Native sharing:** the Share control uses the browser Web Share API when available and falls back to copying the canonical paste URL. It never sends content to a third-party sharing service.
- **CSP cleanup:** share/key inputs use `public/app.js` event listeners instead of inline `onclick` handlers, preserving the strict Content Security Policy.

The 2.1 test suite contains 39 end-to-end and unit tests. Run `npm test`, `npm run typecheck`, and `npm run build` before deployment.

### MantisBin 2.2 — planned scope for the next development chat

This is the source of truth for the planned 2.2 work. Keep the product private, unlisted, dependency-light, and usable without JavaScript wherever practical. Do not add a public feed, global search, trending page, comments, or social discovery as part of 2.2.

#### 1. Password-protected pastes

- Anonymous users can optionally set a passphrase while creating a paste; accounts and API clients can use it too.
- Store only a secure password hash, never the passphrase or a passphrase in the URL.
- The HTML view, normal raw endpoint, API JSON endpoint, and API raw endpoint must all require successful password verification before returning content.
- Metadata that does not reveal content may be shown before unlock, but the title/content policy must be decided consistently across web and API responses.
- Preserve normal expiration, unlisted/noindex behavior, safe headers, rate limits, and ownership rules.
- Define a short-lived, HttpOnly unlock session/cookie so users do not re-enter the passphrase on every request; never expose the passphrase to client JavaScript.
- Add brute-force protection and tests for correct password, wrong password, expired password-protected paste, raw/API access, and owner management.

#### 2. Burn-after-reading pastes

Add explicit expiration modes for temporary handoffs:

- Delete after the first successful unlocked HTML view.
- Optionally delete after the first successful raw/API content fetch, depending on the selected mode.
- A failed request, wrong password, rate-limited request, or 404 must not burn the paste.
- Deletion and view delivery must be coordinated so concurrent requests cannot both receive a supposed one-time paste.
- Show the selected burn behavior in the creator form and paste metadata without exposing secret content.
- Add database, concurrency, web, raw, API, and maintenance tests.

#### 3. Fork / duplicate paste

- Add a “Create a copy” action on paste views.
- The source paste remains unchanged and keeps its original URL, expiration, view count, and owner.
- The copy receives a new random ID and its own metadata, expiration, and view count.
- Anonymous users can create anonymous copies; signed-in users/API-key clients create owned copies.
- Copy the title, content, language, font, and font size by default, with an obvious way to edit before saving.
- Do not let duplication bypass size limits, rate limits, password protection, or burn-after-reading rules.
- Decide and document whether protected/burn-on-read sources require unlocking before copying; default should be to require unlock and never copy content from a failed/partial read.

#### 4. Optional automatic language detection

- Add an `Auto detect` option while retaining manual language selection and the current safe plaintext fallback.
- Detect common formats such as JSON, YAML, Markdown, JavaScript/TypeScript, Python, shell, SQL, HTML/XML, CSS, and diff without executing or importing untrusted code.
- Store the resolved language with the paste so later views are deterministic.
- Manual selection always wins over detection.
- API clients can request auto detection explicitly and receive the resolved language in the response.
- Detection must be bounded by the existing size/performance limits and covered by ambiguous-input tests.

#### 5. QR sharing

- Add a QR action that encodes only the canonical paste URL, never the paste content or password.
- Keep generation dependency-free or use a carefully reviewed local implementation; do not call an external QR/CDN service.
- Provide accessible text fallback and a way to save/download the QR image.
- Respect line anchors when generating a QR after a line has been selected.
- Keep QR UI progressive-enhancement only: the paste must remain fully usable without JavaScript.
- Add tests for canonical URL generation, escaping, expiration links, and protected-paste behavior.

#### 2.2 completion checklist

Before calling 2.2 complete, update the API docs and README, add migration notes if the schema changes, add end-to-end and unit coverage for every new security-sensitive path, verify no secrets appear in URLs/logs/HTML, and run the full test, typecheck, and Worker dry-run build commands. Preserve the existing promise: **paste → save → share → copy**, with no noisy discovery layer.

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
  lib/               crypto, auth/sessions/keys, pastes, ratelimit, highlighter, html, http, maintenance
  routes/            web.js (HTML forms) + api.js (JSON)
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
