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

> **Production caveat:** catbox explicitly filters uploads from datacenter /
> non-residential IPs (see <https://blog.catbox.moe/post/809324731954266112/missing-files-blank-uploads-commercial>),
> and Cloudflare Workers egress *is* datacenter IPs. In practice that means
> anonymous catbox uploads from a Worker can be refused (`200 OK` with an error
> sentence such as `Invalid Uploader`) while the same upload from your laptop
> works fine. The route now surfaces the host's sentence instead of a generic
> `502`, so check `wrangler tail` — if you see `catbox refused the upload`,
> that is what is happening. For a production deployment that must just work,
> use **Option B** (imgtree): it is a Bearer-key API designed for server-side
> uploads, with none of that filtering.

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
# → { "uploads": true, "provider": "catbox", "allowedHosts": ["files.catbox.moe", "imgtree.co", ...], ... }

curl -sSI https://<your-domain>/ | grep -i content-security-policy
# → img-src must list exactly your hosts, never a bare `https:`

curl -sS -X POST https://<your-domain>/p/thumbnail -F "image=@card.jpg"
# → {"url":"https://.../card.jpg"}
```

`wrangler tail` streams live logs if an upload misbehaves. Every failed upload
logs one structured line — provider, upstream status and a sanitized fragment:

```text
[mantisbin] thumbnail upload failed { provider: 'catbox', status: 502, detail: 'catbox refused the upload: Invalid Uploader' }
```

`thumbnail.provider` in `/api/meta` tells you which back end is live
(`imgtree`, `catbox`, or `null` when uploads are off) without leaking any
secret, so "which host is actually failing?" is one `curl` away.

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `502` + `refused the upload ("…")` | The host explicitly rejected the bytes (filtering, policy, bad file). | Read the sentence: `Invalid Uploader` from catbox means datacenter-IP filtering → switch to imgtree (Option B). |
| `502` + `could not be reached` | Network failure between the Worker and the host (DNS/TLS/down). | Wait and retry; check the host's status. Pastes are unaffected. |
| `502` + `temporarily unavailable` | imgtree rejected the API key (`401`/`403`). | The log names `IMGTREE_API_KEY`: re-issue it at <https://imgtree.co/api-keys> and `wrangler secret put IMGTREE_API_KEY` again. |
| `502` + `timed out` | The host took longer than 20 s. | Retry; usually transient. |
| `429` + `rate-limiting` | The host throttled uploads (shared egress IPs share the quota). | Back off per `Retry-After`; an imgtree key has its own quota. |
| `413` + `too large` | The host's own size cap bit. | Shrink the image; the client already resizes to 1200×630. |
| `501` + `not configured` | `THUMBNAIL_UPLOADS=off` and no imgtree key. | Intended: the editor offers only the URL field. |

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
- **If the image host fails**, uploading returns a specific error — usually a
  `502` naming the refusal, a `429` with `Retry-After` when throttled, or a
  `413` when the host's own size cap bites — and the editor tells the user to
  paste a URL instead. Pastes, including ones that already have thumbnails,
  are entirely unaffected.
