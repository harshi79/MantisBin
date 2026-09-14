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
npm test           # 34 end-to-end + unit tests (node:test)
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
| `GET /p/:id/raw` | Exact bytes as `text/plain` — for `curl`, scripts, terminals |
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
- Titles: required, ≤ 120 chars. Usernames: 4–6 letters/digits. Passwords: ≥ 8 chars, PBKDF2-SHA256 (210k).
- View counts dedupe repeat visitors per paste for 6 hours (IPs stored only as HMAC hashes).
- Reads via API: 3000/hour per IP. Auth endpoints: 40/15 min per IP. All limits are abuse guards, not quotas.
- Highlighting + linkification are skipped above 256 KB so huge pastes render instantly; `/raw` always returns exact bytes.

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
  only adds niceties (theme switch without reload, byte counter, copy buttons, Tab handling).
- **Strict CSP** (`default-src 'none'; script-src 'self'; style-src 'self'`) — no inline
  scripts/styles anywhere, pasted content is escaped at render time and never executed.
- **One source of truth** for validation (config + `lib/validate.js`) shared by the HTML
  and JSON paths, enforced server-side.
- **No Node-only APIs in the Worker path**: WebCrypto, fetch, and libSQL over WebSocket/HTTP.

## Security notes

- Passwords: PBKDF2-HMAC-SHA256, 210 000 iterations, per-user salt; constant-time compares.
- Sessions: 256-bit random tokens in `HttpOnly; SameSite=Lax` cookies; only SHA-256 hashes stored.
- API keys: `mb_` + 32 random chars, stored hashed, shown once, max 3 per account.
- Paste pages send `X-Robots-Tag: noindex, nofollow` + `<meta name="robots">`; `robots.txt`
  disallows `/p/`, `/me`, `/login`, `/register`, `/api/` while keeping `/` and `/docs` indexable.
- Raw endpoint sends `nosniff` + `Content-Disposition` so pastes cannot spoof content types.
- Request bodies are size-capped before parsing; oversized inputs never echo back into forms.

## License

MIT
