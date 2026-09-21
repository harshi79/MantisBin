# Deploying the thumbnail feature to Cloudflare

Notes for shipping the thumbnail feature. Uploads always go to **catbox.moe**,
and authors can also paste any `https` image URL by hand. The database stores
only the returned link — never image bytes.

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

`/api/meta` reports the live config: size cap, accepted types, and whether
uploading is enabled. If that block looks right, you're done.

---

## 2. Configuration

| Variable | Type | Default | What it does |
| --- | --- | --- | --- |
| `CATBOX_USERHASH` | **secret** | *(unset)* | Authenticate catbox uploads. **Strongly recommended in production** — see below. Also makes uploads deletable from your catbox account. |
| `THUMBNAIL_HOSTS` | var | *(unset)* | Extra hosts to list explicitly in the page's `img-src` (comma/space separated). Not required — any `https` image URL is already allowed. |
| `THUMBNAIL_UPLOADS` | var | *(unset)* | Set to `off` to disable uploading; a hand-entered URL field remains. |

Rule of thumb: **anything secret → secret. Anything public → var.**
A userhash is a credential; a hostname is not.

### Add your catbox userhash (recommended)

catbox explicitly filters uploads from datacenter / non-residential IPs (see
<https://blog.catbox.moe/post/809324731954266112/missing-files-blank-uploads-commercial>),
and Cloudflare Workers egress *is* datacenter IPs. In practice that means
**anonymous** catbox uploads from a Worker can be refused (`200 OK` with an error
sentence such as `Invalid Uploader`) while the same upload from your laptop works
fine. An account **userhash** authenticates the upload and avoids that filtering.

1. Sign in at <https://catbox.moe> and copy your **user hash** from your account
   settings.
2. Set it:

```bash
wrangler secret put CATBOX_USERHASH      # paste the hash when prompted
```

Or in the **Cloudflare dashboard**:
**Workers & Pages → `mantisbin` → Settings → Variables and Secrets →
Add → type `Secret` → name `CATBOX_USERHASH` → paste value → Save**
(the Worker redeploys automatically).

### Paste any image URL by hand

No configuration is needed for this: the editor accepts any `https` image URL,
on any host. Only `http:`, `data:` payloads and URLs carrying credentials are
refused.

> **Any `https` image is embeddable, which widens `img-src` to `https:`.**
> A remote `<img>` logs the IP of everyone who opens that paste — the editor
> warns authors about this. `THUMBNAIL_HOSTS` only names extra hosts explicitly
> (useful documentation); it is no longer a hard allowlist.

### Turn uploading off

```jsonc
"vars": { "THUMBNAIL_UPLOADS": "off" }
```

`POST /p/thumbnail` then returns `501` and the editor offers only the URL field
(which still accepts any `https` image URL).

---

## 3. Verify after changing variables

```bash
curl -sS https://<your-domain>/api/meta | jq .thumbnail
# → { "uploads": true, "provider": "catbox", "allowedHosts": ["files.catbox.moe", ...], ... }

curl -sSI https://<your-domain>/ | grep -i content-security-policy
# → img-src includes `https:` (any image host) plus the default hosts

curl -sS -X POST https://<your-domain>/p/thumbnail -F "image=@card.jpg"
# → {"url":"https://files.catbox.moe/....jpg"}
```

`wrangler tail` streams live logs if an upload misbehaves. Every failed upload
logs one structured line — status and a sanitized fragment:

```text
[mantisbin] thumbnail upload failed { provider: 'catbox', status: 502, detail: 'catbox refused the upload: Invalid Uploader' }
```

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `502` + `refused the upload ("…")` | catbox explicitly rejected the bytes (filtering, policy, bad file). | Read the sentence: `Invalid Uploader` means datacenter-IP filtering → add a `CATBOX_USERHASH`. |
| `502` + `could not be reached` | Network failure between the Worker and catbox (DNS/TLS/down). | Wait and retry; check catbox's status. Pastes are unaffected. |
| `502` + `timed out` | catbox took longer than 20 s. | Retry; usually transient. |
| `429` + `rate-limiting` | catbox throttled uploads. | Back off per `Retry-After`. |
| `413` + `too large` | catbox's own size cap bit. | Shrink the image; the client already resizes to 1200×630. |
| `501` + `not configured` | `THUMBNAIL_UPLOADS=off`. | Intended: the editor offers only the URL field. |

Authors can always paste an image URL by hand instead of uploading, so a catbox
outage never blocks attaching a thumbnail.

---

## 4. Worth knowing

- **A thumbnail is public.** It lives on a host that does no authentication, so
  it is visible to anyone with its URL — including on a password-protected or
  burn-after-reading paste, where it deliberately stays on the lock screen
  rather than pretending to be secret. The editor warns authors; the lock
  screen tells readers.
- **A one-time paste's picture is not one-time.** Deleting, expiring or burning
  a paste drops the row and the link, but MantisBin cannot delete a file from a
  host it does not own. A `CATBOX_USERHASH` at least lets *you* delete uploads
  later from your catbox account.
- **No storage cost or new binding.** No R2, no KV, no Durable Objects — the
  database stores a URL and the bytes are somebody else's problem.
- **If catbox fails**, uploading returns a specific error — usually a `502`
  naming the refusal, a `429` with `Retry-After` when throttled, or a `413` when
  the host's own size cap bites — and the editor tells the user to paste a URL
  instead. Pastes, including ones that already have thumbnails, are entirely
  unaffected.
