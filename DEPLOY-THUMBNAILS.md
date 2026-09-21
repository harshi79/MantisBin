# Deploying the thumbnail feature to Cloudflare

Scratch notes for shipping `main` (commit `5c41bc7`) — the thumbnail work is
already merged. **Nothing here is mandatory:** deploy as-is and thumbnails work
immediately via catbox.moe, anonymously. Everything below is opt-in.

---

## 1. Deploy (nothing new required)

```bash
git checkout main
git pull
npm install
npm run deploy        # wrangler deploy
```

The `thumbnail_url` column is added automatically on the first request after
deploy — the migration is append-only and nullable, so existing pastes are
untouched and keep rendering exactly as before. No manual SQL, no downtime.

Smoke test:

```bash
curl -sS https://<your-domain>/api/health
curl -sS https://<your-domain>/api/meta | jq .thumbnail
```

`/api/meta` reports the live config: allowed hosts, size cap, accepted types,
and whether uploading is enabled. If that block looks right, you're done.

---

## 2. New variables (all optional)

| Variable | Type | Default | What it does |
| --- | --- | --- | --- |
| `IMGTREE_API_KEY` | **secret** | *(unset)* | Use imgtree instead of catbox. Setting this is the *only* switch needed. |
| `IMGTREE_BASE_URL` | var | `https://imgtree.co` | Point at your own imgtree deployment. Its host is auto-allowlisted. |
| `IMGTREE_ALBUM_ID` | var | *(unset)* | File uploads under one imgtree album. |
| `CATBOX_USERHASH` | **secret** | *(unset)* | Attach catbox uploads to your account so you can delete them later. |
| `THUMBNAIL_HOSTS` | var | *(unset)* | Extra allowed image hosts, comma/space separated. **Also extends `img-src`.** |
| `THUMBNAIL_UPLOADS` | var | *(unset)* | Set to `off` to disable uploading; a hand-entered URL field remains. |

Rule of thumb: **anything secret → secret. Anything public → var.**
An API key or userhash is a credential; a hostname or album id is not.

### Option A — keep catbox (zero config)

Do nothing. Uploads go to catbox.moe anonymously.
Optionally add `CATBOX_USERHASH` so uploads stay deletable from your account.

### Option B — use imgtree

1. Create a key at <https://imgtree.co/api-keys> (shown once — copy it).
2. Set it:

```bash
wrangler secret put IMGTREE_API_KEY      # paste the key when prompted
```

Or in the **Cloudflare dashboard**:
**Workers & Pages → `mantisbin` → Settings → Variables and Secrets →
Add → type `Secret` → name `IMGTREE_API_KEY` → paste value → Save**
(the Worker redeploys automatically).

Self-hosted imgtree? Add `IMGTREE_BASE_URL` as a **plain var** (dashboard:
same screen, type `Text`; or `vars` in `wrangler.jsonc`) — its host is then
allowlisted for you, no second variable needed.

### Option C — your own image host / CDN

```jsonc
// wrangler.jsonc
"vars": {
  "SITE_URL": "https://mantisbin.example.com",
  "THUMBNAIL_HOSTS": "img.example.com, cdn.example.org"
}
```

> **`THUMBNAIL_HOSTS` is a security control, not a convenience setting.**
> It is also the page's `img-src`. Adding a host is the only way images from it
> can load; removing one hides existing images immediately, with no migration
> and no bad rows left behind. Never widen it to a host you don't trust — a
> remote `<img>` logs the IP of everyone who opens that paste.

### Option D — turn uploading off

```jsonc
"vars": { "THUMBNAIL_UPLOADS": "off" }
```

`POST /p/thumbnail` then returns `501` and the editor offers only the URL field.

---

## 3. Verify after changing variables

```bash
curl -sS https://<your-domain>/api/meta | jq .thumbnail
# → { "uploads": true, "allowedHosts": ["files.catbox.moe", "imgtree.co", ...], ... }

curl -sSI https://<your-domain>/ | grep -i content-security-policy
# → img-src must list exactly your hosts, never a bare `https:`

curl -sS -X POST https://<your-domain>/p/thumbnail -F "image=@card.jpg"
# → {"url":"https://.../card.jpg"}
```

`wrangler tail` streams live logs if an upload misbehaves.

---

## 4. Worth knowing

- **A thumbnail is public.** It lives on a host that does no authentication, so
  it is visible to anyone with its URL — including on a password-protected or
  burn-after-reading paste, where it deliberately stays on the lock screen
  rather than pretending to be secret. The editor warns authors; the lock
  screen tells readers.
- **A one-time paste's picture is not one-time.** Deleting, expiring or burning
  a paste drops the row and the link, but MantisBin cannot delete a file from a
  host it does not own. `CATBOX_USERHASH` (or an imgtree key) at least lets *you*
  delete them later from that account.
- **No storage cost or new binding.** No R2, no KV, no Durable Objects — the
  database stores a URL and the bytes are somebody else's problem.
- **If the image host is down**, uploading returns a clean `502` with a readable
  message and the editor tells the user to paste a URL instead. Pastes,
  including ones that already have thumbnails, are entirely unaffected.
