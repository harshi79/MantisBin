/** Lightweight, single-page API documentation. No portal, no SDKs. */

import { BURN_MODES, EXPIRATIONS, LANGUAGE_OPTIONS, LIMITS, RATE_LIMITS, SITE, THUMBNAIL, UNLOCK_TTL_SECONDS } from '../config.js';
import { html } from '../lib/html.js';
import { formatBytes } from '../lib/validate.js';
import { layout } from './layout.js';

const expirationOptions = EXPIRATIONS.map((e) => (e.seconds ? `${e.id} (${e.label.toLowerCase()})` : e.id)).join(', ');

/**
 * @param {{ theme: string, user: any, path: string, baseUrl: string, thumbnailUploads?: boolean }} options
 */
export function docsPage(options) {
  const base = options.baseUrl.replace(/\/$/, '');
  const body = html`
    <div class="docs">
      <div class="page-head">
        <div>
          <h1>API</h1>
          <p class="tagline">A small JSON API over the same paste store the website uses.</p>
        </div>
      </div>

      <p>
        Base URL: <code>${base}</code>. All request and response bodies are UTF-8 JSON unless stated
        otherwise. Reading pastes requires <b>no authentication</b>; creating, updating and deleting
        through the API requires an <b>API key</b> (created on <a href="/me">My pastes</a>).
      </p>

      <h2 id="auth">Authentication</h2>
      <p>Send your key in either header:</p>
      <pre><code>Authorization: Bearer mb_…
# or
X-API-Key: mb_…</code></pre>
      <p>
        Keys are stored as SHA-256 hashes and shown once at creation time. A key acts as its owner:
        pastes created with it belong to that account (10 MB limit, editable/deletable with the same
        key). Invalid keys return <code>401</code>.
      </p>

      <h2 id="endpoints">Endpoints</h2>

      <div class="endpoint"><span class="method">POST</span> <code>/api/pastes</code> <span class="muted small">— create a paste (API key required)</span></div>
      <table class="spec">
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>title</code></td><td>string</td><td>required, 1–${LIMITS.titleMax} chars</td></tr>
          <tr><td><code>content</code></td><td>string</td><td>required, ≤ ${formatBytes(LIMITS.userMaxBytes)} with a key</td></tr>
          <tr><td><code>language</code></td><td>string</td><td>optional: a stored language id or <code>auto</code> (default when omitted is <code>plaintext</code>); manual selection wins, otherwise the filename extension (<code>app.py</code> → Python) wins over content detection, resolved once at creation</td></tr>
          <tr><td><code>visibility</code></td><td>string</td><td>optional: <code>unlisted</code> (default, link-only) or <code>public</code> (listed on your profile)</td></tr>
          <tr><td><code>font</code> / <code>fontSize</code></td><td>string / number</td><td>optional viewer preferences</td></tr>
          <tr><td><code>expiresIn</code></td><td>string</td><td>optional: ${expirationOptions}; default <code>1w</code></td></tr>
          <tr><td><code>password</code></td><td>string</td><td>optional: ${LIMITS.passphraseMin}–${LIMITS.passphraseMax} chars; the paste is locked until it is entered</td></tr>
          <tr><td><code>burnAfter</code></td><td>string</td><td>optional: ${BURN_MODES.map((mode) => `<code>${mode.id}</code>`).join(', ')}; default <code>never</code></td></tr>
          <tr><td><code>thumbnailUrl</code></td><td>string</td><td>optional: any <code>https</code> image URL (see <a href="#thumbnails">Thumbnails</a>). <b>Public even on a protected paste.</b></td></tr>
        </tbody>
      </table>
      <pre><code>curl -sS -X POST ${base}/api/pastes \\
  -H "Authorization: Bearer $MANTISBIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"build log","content":"ok\\nreally ok","language":"plaintext","expiresIn":"1d"}'</code></pre>
      <p>Responds <code>201</code> with the paste object (see below) plus <code>url</code> and <code>rawUrl</code>.</p>

      <div class="endpoint"><span class="method method-get">GET</span> <code>/api/pastes/:id</code> <span class="muted small">— fetch a paste (public)</span></div>
      <pre><code>curl -sS ${base}/api/pastes/a8Kx92Lm</code></pre>

      <div class="endpoint"><span class="method method-get">GET</span> <code>/api/pastes/:id/raw</code> <span class="muted small">— exact bytes, <code>text/plain</code> (public)</span></div>
      <pre><code>curl -sS ${base}/p/a8Kx92Lm/raw   # same thing, shorter</code></pre>
      <p>
        Both <code>/api/pastes/:id/raw</code> and <code>/p/:id/raw</code> return the raw content with
        <code>Content-Type: text/plain; charset=utf-8</code> and <code>X-Content-Type-Options: nosniff</code>,
        which makes them safe to pipe into scripts and terminals. Add <code>?download=1</code> to the
        web route when you want an attachment with a safe title-derived filename; the API route stays inline.
      </p>

      <h2 id="qr">QR sharing</h2>
      <div class="endpoint"><span class="method method-get">GET</span> <code>/p/:id/qr</code> <span class="muted small">— server-rendered QR share page (public)</span></div>
      <p>
        The QR action is progressive enhancement: without JavaScript it opens this page normally; with a
        selected line anchor, <code>public/app.js</code> adds only that line number to the QR request.
        The generated code and the accessible text fallback contain only the canonical
        <code>https://…/p/:id#(line-N)</code> URL — never the paste title, content or passphrase.
        <code>GET /p/:id/qr.svg</code> is the same dependency-free image for saving; append
        <code>?line=N&amp;download=1</code> for a download. Expired links return <code>404</code>, and a
        protected paste still asks for its passphrase when the QR link is opened.
      </p>

      <h2 id="fork">Duplicating a paste</h2>
      <div class="endpoint"><span class="method">POST</span> <code>/api/pastes/:id/fork</code> <span class="muted small">— copy a paste (public; a key makes the copy owned)</span></div>
      <p>
        The copy is a brand-new paste: new random id, own URL, own expiration, own view count, own
        password and burn settings. The source keeps its URL, content, expiration, view count and owner —
        nothing about it is modified. Ownership follows the actor: with an API key the copy belongs to that
        account (10 MB limit, manageable with the same key), without one it is an anonymous paste
        (5 MB, 60 copies/hour per IP).
      </p>
      <table class="spec">
        <thead><tr><th>Field (all optional)</th><th>Default</th></tr></thead>
        <tbody>
          <tr><td><code>title</code></td><td>the source title</td></tr>
          <tr><td><code>language</code> / <code>font</code> / <code>fontSize</code></td><td>the source's viewer settings</td></tr>
          <tr><td><code>expiresIn</code></td><td>the source's remaining lifetime, rounded up to the next preset</td></tr>
          <tr><td><code>password</code></td><td><code>null</code> — passwords are never copied (they cannot be read back)</td></tr>
          <tr><td><code>visibility</code></td><td><code>unlisted</code> — copies start unlisted unless explicitly published (signed-in actors only)</td></tr>
          <tr><td><code>burnAfter</code></td><td><code>never</code></td></tr>
        </tbody>
      </table>
      <pre><code>curl -sS -X POST ${base}/api/pastes/a8Kx92Lm/fork \\
  -H "Authorization: Bearer $MANTISBIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"copy of it","expiresIn":"1h","burnAfter":"read"}'
# 201 {"id":"Zt4Qm1Px","title":"copy of it", …}

curl -sS -X POST ${base}/api/pastes/a8Kx92Lm/fork   # no key: an anonymous copy</code></pre>
      <p>
        The content always comes from the source, so <code>content</code> is refused with <code>400</code>.
        A protected source must be unlocked first (<code>401</code> otherwise, and the browser flow shows the
        unlock screen and returns to the duplicate page afterwards); the owner's session or key never needs
        the passphrase. A burn-after-reading source is <b>consumed</b> by copying it, exactly as a read
        would be. In the browser, "Duplicate" on a paste view opens the ordinary editor pre-filled, so you
        can change anything before saving — no API key required.
      </p>

      <div class="endpoint"><span class="method method-get">GET</span> <code>/api/pastes/mine</code> <span class="muted small">— your pastes (API key required)</span></div>
      <div class="endpoint"><span class="method">PATCH</span> <code>/api/pastes/:id</code> <span class="muted small">— update your paste (API key required)</span></div>
      <div class="endpoint"><span class="method">DELETE</span> <code>/api/pastes/:id</code> <span class="muted small">— delete your paste (API key required)</span></div>
      <div class="endpoint"><span class="method method-get">GET</span> <code>/api/users/:username</code> <span class="muted small">— public profile metadata (public)</span></div>
      <div class="endpoint"><span class="method method-get">GET</span> <code>/api/meta</code> <span class="muted small">— languages, fonts, expirations and limits (public)</span></div>
      <div class="endpoint"><span class="method method-get">GET</span> <code>/api/health</code> <span class="muted small">— liveness probe (public)</span></div>

      <h2 id="protected">Password-protected pastes</h2>
      <p>
        Send <code>password</code> when creating a paste and the paste is locked: reading it requires the
        passphrase. Only a PBKDF2-SHA256 hash (100 000 iterations, per-paste salt) is stored — never the
        passphrase, and never anything derived from it in a URL, in HTML, in a log line or in a response body.
      </p>
      <pre><code>curl -sS -X POST ${base}/api/pastes \\
  -H "Authorization: Bearer $MANTISBIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"handover","content":"…","password":"correct-horse-battery-staple","expiresIn":"1d"}'</code></pre>

      <div class="endpoint"><span class="method">POST</span> <code>/api/pastes/:id/unlock</code> <span class="muted small">— verify the passphrase (public)</span></div>
      <pre><code>curl -sS -c jar.txt -X POST ${base}/api/pastes/a8Kx92Lm/unlock \\
  -H "Content-Type: application/json" \\
  -d '{"password":"correct-horse-battery-staple"}'
# {"unlocked":true,"id":"a8Kx92Lm","expiresAt":"…"}

curl -sS -b jar.txt ${base}/api/pastes/a8Kx92Lm        # now returns the paste
curl -sS -b jar.txt ${base}/api/pastes/a8Kx92Lm/raw    # and the raw bytes</code></pre>
      <p>
        The unlock is a signed <code>HttpOnly; SameSite=Lax</code> cookie valid for
        ${Math.round(UNLOCK_TTL_SECONDS / 60)} minutes and bound to that one paste id, so it cannot be copied to
        another paste. Browsers get the same thing from the form at <code>/p/:id</code> — the paste page needs no
        JavaScript to unlock. Up to 3 pastes stay unlocked at once, and no passphrase ever appears in a URL.
      </p>
      <table class="spec">
        <thead><tr><th>Situation</th><th>Status</th><th>Body</th></tr></thead>
        <tbody>
          <tr><td><code>GET /p/:id</code>, locked</td><td><code>200</code></td><td>HTML unlock screen: “this paste is password-protected” + safe metadata (id, created/expiry, views, unlisted). No title, no content.</td></tr>
          <tr><td><code>GET /p/:id/raw</code>, locked</td><td><code>401</code></td><td>Plain text explaining where to unlock. Zero bytes of content.</td></tr>
          <tr><td><code>GET /api/pastes/:id</code> and <code>/raw</code>, locked</td><td><code>401</code></td><td><code>{ "error": … }</code> only — no paste object, not even the title.</td></tr>
          <tr><td>Wrong passphrase</td><td><code>401</code></td><td><code>{ "error": "Wrong passphrase." }</code> (web: the unlock screen). No cookie is issued.</td></tr>
          <tr><td>Too many attempts</td><td><code>429</code></td><td>${RATE_LIMITS.unlock.limit} attempts / ${Math.round(RATE_LIMITS.unlock.window / 60)} min per paste + IP, with <code>Retry-After</code>.</td></tr>
          <tr><td>Owner (session cookie, or the account's API key)</td><td><code>200</code></td><td>Full access without the passphrase — the same account can always edit and delete its own paste.</td></tr>
        </tbody>
      </table>
      <p>
        <code>PATCH /api/pastes/:id</code> manages the lock: omit <code>password</code> to keep it, send a new
        string to replace it, or send <code>null</code> to remove it. Paste objects carry a
        <code>protected</code> boolean, so clients can tell before asking for content.
      </p>

      <h2 id="burn">Burn after reading</h2>
      <p>
        <code>burnAfter</code> turns a paste into a one-time link. Expiry is a deadline; burning is
        consumption. The paste is deleted as it is handed out, so there is nothing left to fetch, no
        view to count and nothing to leak later.
      </p>
      <table class="spec">
        <thead><tr><th>Mode</th><th>Consumed by</th></tr></thead>
        <tbody>
          <tr><td><code>never</code> (default)</td><td>nothing — the paste lives until it expires</td></tr>
          <tr><td><code>view</code></td><td>the first successful HTML view (<code>GET /p/:id</code>)</td></tr>
          <tr><td><code>read</code></td><td>the first successful content read of any kind: <code>GET /p/:id</code>, <code>/p/:id/raw</code>, <code>GET /api/pastes/:id</code> or <code>/api/pastes/:id/raw</code></td></tr>
        </tbody>
      </table>
      <pre><code>curl -sS -X POST ${base}/api/pastes \\
  -H "Authorization: Bearer $MANTISBIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"one time","content":"…","burnAfter":"read","expiresIn":"1d"}'
# {"burnAfter":"read", …}

curl -sS ${base}/api/pastes/a8Kx92Lm        # 200, the one and only read
curl -sS ${base}/api/pastes/a8Kx92Lm        # 404 — it is gone</code></pre>
      <p>
        Reads are claimed with a single atomic conditional update, so concurrent requests cannot both
        receive a one-time paste: exactly one caller gets the content and every other one gets
        <code>404</code>. Only successful reads consume a paste — a lock screen, a wrong passphrase, a
        <code>401</code>, a <code>404</code>, an expired paste or a rate-limited request leaves it
        untouched. A one-time paste is one-time for its owner as well.
      </p>
      <p>
        <code>PATCH /api/pastes/:id</code> manages the mode: omit <code>burnAfter</code> to keep it, send
        <code>view</code>/<code>read</code> to arm it, or <code>null</code>/<code>never</code> to switch it
        off. Answering a paste always includes its <code>burnAfter</code>, and unknown values are refused
        with <code>400</code> rather than silently stored as "keep forever".
      </p>

      <h2 id="thumbnails">Thumbnails</h2>
      <p>
        A paste can carry one optional preview image. ${SITE.name} <b>never stores image bytes</b>:
        the picture lives on a third-party image host and the paste keeps only the link, which is
        rendered on the paste page, in listings and as the <code>og:image</code> used by chat and
        social link previews. Images are fitted to a ${THUMBNAIL.width}×${THUMBNAIL.height} card in
        the browser before upload, so nothing full-resolution is sent anywhere.
      </p>
      <div class="notice">
        <b>A thumbnail is public.</b> It is served by an image host that does no authentication, so
        anyone with its URL can see it — including for a password-protected or burn-after-reading
        paste, where it stays visible on the lock screen by design. Never put anything private in a
        thumbnail.
      </div>
      <p>
        A <code>thumbnailUrl</code> may point at <b>any <code>https</code> image host</b> — uploads
        land on <code>catbox.moe</code>, and you can also paste a link to an image anywhere else.
        Only the protocol is enforced: <code>http</code> URLs, <code>data:</code> payloads and URLs
        carrying credentials are rejected. Because arbitrary remote images are allowed, the page's
        <code>img-src</code> permits <code>https:</code> images generally, which is why the public
        warning above matters.
      </p>
      ${options.thumbnailUploads
        ? html`<div class="endpoint"><span class="method">POST</span> <code>/p/thumbnail</code> <span class="muted small">— upload an image, get a URL (no key needed)</span></div>
            <p>
              Send <code>multipart/form-data</code> with an <code>image</code> field
              (${THUMBNAIL.types.map((type) => type.replace('image/', '')).join(', ')}; up to
              ${formatBytes(THUMBNAIL.maxBytes)}). The bytes are forwarded once to <code>catbox.moe</code>
              and the JSON reply is just the link, which you then send as
              <code>thumbnailUrl</code>. Uploading creates no paste and modifies nothing.
            </p>
            <pre><code>curl -sS -X POST ${base}/p/thumbnail -F "image=@card.jpg"
# {"url":"https://files.catbox.moe/ab12cd.jpg"}</code></pre>`
        : html`<p class="muted small">Image uploading is disabled on this instance — supply a <code>thumbnailUrl</code> (any https image URL) instead.</p>`}
      <p>
        <code>PATCH /api/pastes/:id</code> follows the usual rule: omit <code>thumbnailUrl</code> to
        keep the current image, send a URL to replace it, or <code>null</code> to remove it. A fork
        reuses the source's image unless the copy overrides it. Every paste object reports its
        <code>thumbnailUrl</code> (<code>null</code> when there is none), and
        <code>GET /api/meta</code> reports the size cap, accepted types and whether uploads are on.
      </p>

      <h2 id="profiles">Profiles & visibility</h2>
      <p>
        Every paste is <code>unlisted</code> unless its owner says otherwise: link-only, never
        listed anywhere. Accounts can set <code>visibility: "public"</code> (editor radios, or the
        API field on create/update/fork) to list a paste on their opt-in profile page at
        <code>/u/:username</code> — avatar, member-since, stats and public pastes, newest first.
        Anonymous pastes can never be public; copies start unlisted; flipping a paste back to
        unlisted removes it from the profile immediately.
      </p>
      <p>
        <code>GET /api/users/:username</code> returns the same profile as JSON (paste metadata,
        never content), and <code>GET /u/:username/avatar.svg</code> serves the account's
        deterministic avatar (immutable, cacheable forever). Profile pages are the only indexed
        discovery surface; paste pages stay <code>noindex</code>. Account settings live at
        <code>/me/settings</code>: profile link, password change (other sessions are revoked),
        session revocation, and password-confirmed account deletion — which anonymises owned
        pastes (links keep working, owner cleared, visibility reset to unlisted) instead of
        deleting them.
      </p>

      <h2 id="shape">Paste object</h2>
      <pre><code>{
  "id": "a8Kx92Lm",
  "url": "${base}/p/a8Kx92Lm",
  "rawUrl": "${base}/p/a8Kx92Lm/raw",
  "title": "build log",
  "language": "plaintext",
  "font": "mono",
  "fontSize": 14,
  "size": 18,
  "views": 3,
  "createdAt": "2026-09-14T10:12:00.000Z",
  "updatedAt": "2026-09-14T10:12:00.000Z",
  "expiresAt": "2026-09-15T10:12:00.000Z",
  "protected": false,
  "burnAfter": "never",
  "visibility": "unlisted",
  "thumbnailUrl": null,
  "content": "ok\\nreally ok"
}</code></pre>
      <p>List endpoints omit <code>content</code>. Timestamps are ISO 8601 UTC; <code>expiresAt</code> is <code>null</code> for “never”.</p>

      <h2 id="errors">Errors</h2>
      <p>
        Errors use one shape: <code>{ "error": "message" }</code> with a sensible status code —
        <code>400</code> invalid input, <code>401</code> missing/invalid key or locked paste, <code>403</code> not your
        paste, <code>404</code> unknown/expired/deleted paste, <code>413</code> too large,
        <code>429</code> rate limited (with a <code>Retry-After</code> header), <code>500</code> our fault.
        Messages are safe to show to end users; internals are never included.
      </p>

      <h2 id="limits">Limits & rate limits</h2>
      <ul>
        <li>Anonymous: ${formatBytes(LIMITS.anonMaxBytes)} per paste. With an API key or account: ${formatBytes(LIMITS.userMaxBytes)}.</li>
        <li>Paste IDs are ${LIMITS.idLength} random base62 characters; there are no custom URLs and no sequential ids.</li>
        <li>Create (web): ${RATE_LIMITS.create.limit}/hour per IP or account. Create (API): ${RATE_LIMITS.apiCreate.limit}/hour per key. Copies count against the same limits (anonymous copies against the IP, keyed copies against the key).</li>
        <li>Reads (API): ${RATE_LIMITS.apiRead.limit}/hour per IP. Auth endpoints: ${RATE_LIMITS.auth.limit}/${Math.round(RATE_LIMITS.auth.window / 60)} min per IP.</li>
        <li>Paste passphrases: ${LIMITS.passphraseMin}–${LIMITS.passphraseMax} characters, stored as a PBKDF2-SHA256 hash. Unlocking lasts ${Math.round(UNLOCK_TTL_SECONDS / 60)} minutes and is capped at ${RATE_LIMITS.unlock.limit} attempts / ${Math.round(RATE_LIMITS.unlock.window / 60)} min per paste + IP.</li>
        <li>View counts ignore repeat refreshes from the same visitor within 6 hours; a locked paste is never counted until it is unlocked, and a burn-after-reading paste is deleted as it is served.</li>
      </ul>

      <h2 id="languages">Languages</h2>
      <p>Send one of the stored language ids: <code>${LANGUAGE_OPTIONS.filter((l) => l.id !== 'auto').map((l) => l.id).join(', ')}</code>. The editor and API also accept <code>auto</code> (the editor default): the filename extension is read first (<code>app.py</code> → <code>python</code>, <code>Dockerfile</code> → <code>dockerfile</code>), then content fingerprints bounded to the first 64 KiB, while ambiguous or very large input becomes <code>plaintext</code>. The resolved language is stored; the full extension map is published at <code>GET /api/meta</code> as <code>filenameExtensions</code>. An explicit language always wins over both.</p>

      <h2 id="privacy">Privacy</h2>
      <p>
        Every paste is unlisted: no directory, no search, no feed. Paste pages and the API send
        <code>X-Robots-Tag: noindex, nofollow</code> and a matching <code>&lt;meta name="robots"&gt;</code>,
        and <code>robots.txt</code> disallows <code>/p/</code>. Only someone with the URL finds a paste.
      </p>
    </div>
  `;

  return layout({
    title: `API · ${SITE.name}`,
    description: `How to use the ${SITE.name} JSON API: create, fetch and raw endpoints, auth and limits.`,
    theme: options.theme,
    user: options.user,
    active: 'docs',
    path: options.path,
    body,
  });
}
