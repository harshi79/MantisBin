# Deploying the thumbnail feature to Cloudflare

Notes for shipping the thumbnail feature. Uploads are forwarded to a public
image host — **catbox.moe** first, **0x0.st** as the fallback — and authors can
also paste any `https` image URL by hand. The database stores only the returned
link — never image bytes.

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
| `CATBOX_USERHASH` | **secret** | *(unset)* | Authenticate catbox uploads, so catbox accepts them from the Worker's datacenter IPs and you can delete them later. Optional — the fallback covers an unauthenticated catbox. |
| `THUMBNAIL_PROVIDERS` | var | `catbox,nullpointer` | Ordered upload chain (comma/space separated ids). `catbox` = catbox.moe, `nullpointer` = 0x0.st. An unknown id is ignored; a list of only unknown ids falls back to this default. |
| `THUMBNAIL_HOSTS` | var | *(unset)* | Extra hosts to list explicitly in the page's `img-src` (comma/space separated). Not required — any `https` image URL is already allowed. |
| `THUMBNAIL_UPLOADS` | var | *(unset)* | Set to `off` to disable uploading entirely; a hand-entered URL field remains. |

Rule of thumb: **anything secret → secret. Anything public → var.**
A userhash is a credential; a hostname is not.

### Why there are two hosts

catbox explicitly filters uploads from datacenter / non-residential IPs (see
<https://blog.catbox.moe/post/809324731954266112/missing-files-blank-uploads-commercial>),
and Cloudflare Workers egress *is* datacenter IPs. In practice that means
**anonymous** catbox uploads from a Worker are refused (`200 OK` with an error
sentence such as `Invalid Uploader`) while the same upload from your laptop works
fine — which is the failure this feature shipped with.

So `POST /p/thumbnail` tries catbox first and, if catbox refuses, sends the same
image to **0x0.st** — anonymous, no key, nothing to configure — and stores that
link instead. One request per host, never a retry. Uploading therefore works on
a fresh deploy with no secrets at all; narrowing `THUMBNAIL_PROVIDERS` to
`catbox` restores single-host behaviour if you would rather fail loudly than
store a file on a host with a shorter retention.

| Host | Keeps a file | Notes |
| --- | --- | --- |
| catbox.moe | indefinitely | Anonymous files with no hit in over two years may be removed. |
| 0x0.st | 30 days to a year | Smaller files live longer; a thumbnail card lands near the top of that range. The empty `secret` field buys the longer, hard-to-guess URL. |

Either way the thumbnail is public, so the trade-off is retention, not secrecy —
the editor says so before the author uploads anything.

### Add your catbox userhash (recommended)

An account **userhash** authenticates the upload, so catbox stops filtering it,
and it makes the file deletable from your catbox account. It is optional: the
0x0.st fallback already keeps uploading working without it.

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
# → { "uploads": true, "provider": "catbox", "providers": ["catbox","nullpointer"],
#     "allowedHosts": ["files.catbox.moe","0x0.st", ...], ... }

curl -sSI https://<your-domain>/ | grep -i content-security-policy
# → img-src includes `https:` (any image host) plus the default hosts

curl -sS -X POST https://<your-domain>/p/thumbnail -F "image=@card.jpg"
# → {"url":"https://files.catbox.moe/....jpg"}
```

`wrangler tail` streams live logs if an upload misbehaves. Every failed
*attempt* logs one structured line — the host, its status and a sanitized
fragment:

```text
[mantisbin] thumbnail upload failed { provider: 'catbox', status: 502, detail: 'catbox refused the upload: Invalid Uploader', fellBackTo: 'nullpointer' }
[mantisbin] thumbnail upload failed { provider: 'nullpointer', status: 502, detail: 'nullpointer refused the upload: …' }
```

The `fellBackTo` field names the host that got the image next, so one pair of
lines tells the whole story: which host refused, why, and whether the fallback
was reached at all.

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `502` + `refused the upload ("…")` | **Every** host in the chain rejected the bytes (filtering, policy, bad file). | The sentence comes from the first host: `Invalid Uploader` means catbox's datacenter-IP filtering, and 0x0.st refused too. Add a `CATBOX_USERHASH`, or check the tail log for what the fallback said. |
| `502` + `could not be reached` | No host in the chain could be reached (DNS/TLS/down). | Wait and retry; check the hosts' status. Pastes are unaffected. |
| `502` + `timed out` | A host took longer than 20 s, and so did the rest. | Retry; usually transient. |
| `429` + `rate-limiting` | Every host that was reached throttled the upload. | Back off per `Retry-After`. |
| `413` + `too large` | A host's own size cap bit. | Shrink the image; the client already resizes to 1200×630. |
| `501` + `not configured` | `THUMBNAIL_UPLOADS=off`. | Intended: the editor offers only the URL field. |

Authors can always paste an image URL by hand instead of uploading, so a host
outage never blocks attaching a thumbnail — and because the chain moves on by
itself, a single host refusing is not an outage for the author at all.

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
  later from your catbox account; 0x0.st hands back an `X-Token` per upload that
  would do the same, if a future version wants to keep it.
- **No storage cost or new binding.** No R2, no KV, no Durable Objects — the
  database stores a URL and the bytes are somebody else's problem.
- **If the hosts fail**, uploading returns a specific error — usually a `502`
  naming the refusal, a `429` with `Retry-After` when throttled, or a `413` when
  a host's own size cap bites — and the editor tells the user to paste a URL
  instead. Pastes, including ones that already have thumbnails, are entirely
  unaffected.
- **A refusal is a chain, not an error.** `Invalid Uploader` from catbox is
  expected from a Worker, so the upload quietly continues on 0x0.st; the reader
  only ever hears about it when *both* hosts say no.
