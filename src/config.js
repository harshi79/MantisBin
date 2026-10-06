/**
 * Central configuration for MantisBin.
 * Every tunable limit/option lives here so the UI, validator and API stay in sync.
 */

export const SITE = {
  name: 'MantisBin',
  tagline: 'Stay sharp. Paste faster.',
  description:
    'MantisBin is a fast, minimal pastebin for plain text and source code. Paste, save, share, copy.',
};

export const LIMITS = {
  /** Title is mandatory. */
  titleMin: 1,
  titleMax: 120,
  /** Content must not be empty. */
  contentMin: 1,
  /** Anonymous users: 5 MB. */
  anonMaxBytes: 5 * 1024 * 1024,
  /** Registered users (and API keys): 10 MB. */
  userMaxBytes: 10 * 1024 * 1024,
  /** Hard ceiling for a single request body before it is even parsed (10 MB + slack). */
  bodyMaxBytes: 11 * 1024 * 1024,
  /** Above this size the viewer skips syntax highlighting/linkifying to stay responsive. */
  highlightMaxBytes: 256 * 1024,
  /** Passwords are capped so hashing cannot be abused as a CPU DoS. */
  passwordMax: 256,
  /**
   * Usernames: 3–20 characters, letters/digits/underscore, unique
   * case-insensitively. Widened for the merged app — the historic MantisBin
   * rule was 4–6 alphanumeric, and every 4–6 character name still satisfies
   * 3–20, so existing accounts keep their handle with no rename and no
   * migration, while new sign-ups get the longer, underscore-friendly form.
   */
  usernameMin: 3,
  usernameMax: 20,
  passwordMin: 8,
  /**
   * Optional per-paste passphrase (2.2 §1). Short codes get handed out over
   * chat, so the floor is 6 rather than the 8 used for accounts; brute force is
   * stopped by the unlock rate limit, not by the character count. Same 256
   * character ceiling as accounts so PBKDF2 work stays bounded.
   */
  passphraseMin: 6,
  passphraseMax: 256,
  /** Paste ID length (base62). */
  idLength: 8,
};

/**
 * Optional paste thumbnails (2.4).
 *
 * A thumbnail is one small image attached to a paste. The database stores only
 * a URL — the bytes live on a third-party image host — and the picture is shown
 * on the paste page, in listings and as the `og:image` link preview.
 *
 * Uploads are forwarded to a public image host (catbox.moe, with 0x0.st as the
 * fallback for when catbox refuses the Worker's datacenter IP) — see
 * lib/thumbnail.js. Add a `CATBOX_USERHASH` in the dashboard to authenticate
 * catbox uploads (and make them deletable from that account); with nothing set,
 * uploads are anonymous. You may also paste any `https:` image URL by hand — a
 * link on any host is accepted.
 *
 * Because an image host serves the picture to anyone who has the link, a
 * thumbnail is PUBLIC even when the paste itself is password-protected or burns
 * after reading. The editor says so, and `views/unlock.js` treats it as public
 * metadata rather than content.
 */
export const THUMBNAIL = {
  /** Target card box — the 1.91:1 frame link previews crop to. Contain, never upscale. */
  width: 1200,
  height: 630,
  /** JPEG quality used by the in-browser resize before anything is uploaded. */
  quality: 0.82,
  /** Hard ceiling for one uploaded image *after* the client-side resize. */
  maxBytes: 2 * 1024 * 1024,
  /** Reject either side above this: a resized card is 1200×630, this is slack. */
  maxDimension: 4096,
  /** Stored URL length cap (the column is a URL, never a data: payload). */
  maxUrlLength: 500,
  /** MIME types the upload endpoint accepts, and the extensions they imply. */
  types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  /** Output of the browser-side resize. */
  outputType: 'image/jpeg',
};

/**
 * A hand-typed thumbnail URL may point at ANY `https:` host — MantisBin does
 * not restrict which image host you link to. These entries are only the hosts
 * listed *by default* in the page `img-src` (see lib/http.js) so the built-in
 * upload targets render without extra configuration; operators can add more
 * with the `THUMBNAIL_HOSTS` variable. Because arbitrary `https:` image URLs
 * are allowed, `img-src` is widened to `https:` as well — see lib/http.js.
 */
export const THUMBNAIL_DEFAULT_HOSTS = ['files.catbox.moe', '0x0.st'];

/**
 * Upload back ends for `POST /p/thumbnail`, tried in this order.
 *
 *   catbox      — `POST https://catbox.moe/user/api.php`. Permanent storage. A
 *                 `CATBOX_USERHASH` (secret) authenticates the upload so catbox
 *                 accepts it from the Worker's datacenter IPs and lets you
 *                 delete it later from your account; without it the upload is
 *                 anonymous and may be refused outright (catbox answers `200 OK`
 *                 with the sentence `Invalid Uploader` when it filters that
 *                 traffic).
 *   nullpointer — `POST https://0x0.st`. Anonymous, no key, nothing to
 *                 configure, so it is the fallback that keeps uploading working
 *                 when catbox refuses a Worker IP. Files live between 30 days
 *                 and a year (smaller files live longer).
 *
 * MantisBin never stores image bytes: the Worker forwards them once per
 * provider — at most one request each, never a retry — and keeps only the
 * returned link. `THUMBNAIL_PROVIDERS` (comma or space separated) reorders or
 * narrows the chain, and `THUMBNAIL_UPLOADS="off"` disables uploading entirely
 * (the editor still accepts a pasted image URL).
 */
export const THUMBNAIL_PROVIDERS = [
  {
    id: 'catbox',
    label: 'catbox.moe',
    endpoint: 'https://catbox.moe/user/api.php',
    /** Multipart field the bytes go in. */
    fileField: 'fileToUpload',
    /** Static multipart fields this host expects. */
    fields: { reqtype: 'fileupload' },
    /** Where an account credential goes, if the operator configured one. */
    userhashField: 'userhash',
    /** How long the host keeps an uploaded file — shown to authors. */
    retention: 'keeps uploads indefinitely',
  },
  {
    id: 'nullpointer',
    label: '0x0.st',
    endpoint: 'https://0x0.st',
    fileField: 'file',
    // An empty `secret` asks 0x0.st for a longer, hard-to-guess URL instead of
    // the short default one — the thumbnail is public either way, and this at
    // least keeps it out of anyone's enumeration.
    fields: { secret: '' },
    userhashField: null,
    retention: 'keeps files for 30 days to a year',
  },
];

/** Expiration presets. `seconds: 0` means "never". */
export const EXPIRATIONS = [
  { id: '10m', label: '10 minutes', seconds: 600 },
  { id: '1h', label: '1 hour', seconds: 3600 },
  { id: '6h', label: '6 hours', seconds: 21600 },
  { id: '1d', label: '1 day', seconds: 86400 },
  { id: '1w', label: '1 week', seconds: 604800 },
  { id: '1mo', label: '30 days', seconds: 2592000 },
  { id: '1y', label: '1 year', seconds: 31536000 },
  { id: 'never', label: 'Never', seconds: 0 },
];

export const DEFAULT_EXPIRATION = '1w';

/**
 * Burn-after-reading modes (2.2 §2). Stored per paste as `pastes.burn_mode`:
 *   never — the paste lives until it expires (default, unchanged behaviour)
 *   view  — deleted after the first successful HTML view
 *   read  — deleted after the first successful content read of any kind
 *           (HTML view, /raw, or either API endpoint)
 *
 * Only *successful* reads count: a wrong passphrase, a 401/404, a rate-limited
 * request, an expired paste or a lock screen never consumes a one-time paste.
 */
export const BURN_MODES = [
  { id: 'never', label: 'Keep until it expires', short: 'until it expires' },
  { id: 'view', label: 'Burn after the first view', short: 'burns after the first view' },
  { id: 'read', label: 'Burn after the first read (view, raw or API)', short: 'burns after the first read' },
];

export const DEFAULT_BURN_MODE = 'never';

/**
 * Fonts are system font stacks on purpose: zero downloads, zero layout shift,
 * works identically in the editor and the viewer.
 */
export const FONTS = [
  {
    id: 'mono',
    label: 'Mono (default)',
    stack: 'SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", ui-monospace, monospace',
  },
  { id: 'sans', label: 'Sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif' },
  { id: 'classic', label: 'Typewriter', stack: '"Courier New", Courier, ui-monospace, monospace' },
];

export const DEFAULT_FONT = 'mono';

export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20];
export const DEFAULT_FONT_SIZE = 14;

/**
 * Supported languages. `plaintext` renders escaped text with no tokens. The
 * editor's `Auto detect` sentinel is kept separate so it can never be stored
 * in a paste row or accidentally handed to the highlighter.
 */
export const LANGUAGES = [
  { id: 'plaintext', label: 'Plain text' },
  { id: 'bash', label: 'Bash / Shell' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'css', label: 'CSS' },
  { id: 'diff', label: 'Diff / Patch' },
  { id: 'dockerfile', label: 'Dockerfile' },
  { id: 'go', label: 'Go' },
  { id: 'html', label: 'HTML' },
  { id: 'ini', label: 'INI / TOML' },
  { id: 'java', label: 'Java' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'json', label: 'JSON' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'lua', label: 'Lua' },
  { id: 'makefile', label: 'Makefile' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'php', label: 'PHP' },
  { id: 'python', label: 'Python' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'rust', label: 'Rust' },
  { id: 'sql', label: 'SQL' },
  { id: 'swift', label: 'Swift' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'xml', label: 'XML' },
  { id: 'yaml', label: 'YAML' },
];

export const DEFAULT_LANGUAGE = 'plaintext';
export const AUTO_LANGUAGE = 'auto';
/** Form/API choices: `auto` is an input instruction, never a stored language. */
export const LANGUAGE_OPTIONS = [{ id: AUTO_LANGUAGE, label: 'Auto detect' }, ...LANGUAGES];
/** Auto detection never examines more than this prefix. */
export const LANGUAGE_DETECT_MAX_BYTES = 64 * 1024;

/**
 * Filename-first editing (PasteX-style): the create form starts with this
 * name, and `languageFromFilename()` in lib/detect.js reads the extension.
 */
export const DEFAULT_FILENAME = 'untitled.txt';

/**
 * Filename extension (lowercase, without the dot) → stored language id.
 * Consulted only when the language choice is `auto`: an explicit selection
 * always wins, and an unknown/missing extension falls through to content
 * detection. Every value must be a valid `LANGUAGES` id.
 */
export const FILENAME_EXTENSIONS = {
  txt: 'plaintext',
  text: 'plaintext',
  log: 'plaintext',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkdown: 'markdown',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  geojson: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ksh: 'bash',
  c: 'c',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  php: 'php',
  go: 'go',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  lua: 'lua',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  xml: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  xsd: 'xml',
  svg: 'xml',
  plist: 'xml',
  wsdl: 'xml',
  rss: 'xml',
  atom: 'xml',
  css: 'css',
  scss: 'css',
  less: 'css',
  diff: 'diff',
  patch: 'diff',
  rej: 'diff',
  mk: 'makefile',
  mak: 'makefile',
  mkfile: 'makefile',
  dockerfile: 'dockerfile',
};

/**
 * Exact basenames (lowercase, leading dots ignored) → stored language id.
 * For the extension-less files developers actually paste: `Dockerfile`,
 * `Makefile`, `Gemfile`, dotfiles like `.bashrc`. Checked before the
 * extension map above.
 */
export const FILENAME_EXACT_NAMES = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  bashrc: 'bash',
  zshrc: 'bash',
  shrc: 'bash',
};

/**
 * Rate limits — deliberately generous, they exist only to stop obvious abuse.
 * `limit` requests per `window` seconds, per bucket (IP or API key).
 */
export const RATE_LIMITS = {
  /** Paste creation from the web UI (per IP, or per user when signed in). */
  create: { limit: 60, window: 3600 },
  /** Paste creation through the API (per API key / IP). */
  apiCreate: { limit: 300, window: 3600 },
  /** Reads through the API (per IP). */
  apiRead: { limit: 3000, window: 3600 },
  /** Login + registration attempts (per IP). */
  auth: { limit: 40, window: 900 },
  /**
   * Wrong/attempted passphrase unlocks of one paste from one IP. The bucket key
   * carries both, so hammering one paste cannot lock a visitor out of another.
   */
  unlock: { limit: 10, window: 900 },
  /**
   * Thumbnail uploads (per IP, or per user when signed in). Tighter than paste
   * creation: every one of these spends an outbound request to a third-party
   * image host that MantisBin does not pay for or control.
   */
  thumbnail: { limit: 20, window: 3600 },
  /**
   * Social actions — follow, bookmark, react, mark notifications read — share
   * one bucket per account. These are cheap single-row writes, so the limit is
   * generous; it exists to bound a script, not a person.
   */
  social: { limit: 240, window: 3600 },
  /** Profile customisation saves (per account). */
  profile: { limit: 30, window: 3600 },
  /** Pin changes (per account): pins are cheap, but a toggle is still a write. */
  pin: { limit: 60, window: 3600 },
  /**
   * GIF search and the sticker pack (per IP). Every search spends outbound
   * quota on a third-party API that MantisBin does not pay for, so this bucket
   * is tighter than a plain read — and the response is cacheable, so a busy
   * editor is served from the edge rather than the provider.
   */
  media: { limit: 240, window: 3600 },
  /**
   * The notification bell polls one tiny query while a page is open (per
   * account). Generous, because being throttled would only make the badge
   * stale — never wrong.
   */
  notifyPoll: { limit: 1200, window: 3600 },
};

/**
 * Third-party media search (merge phase 4). Both providers are outbound calls
 * made by the Worker, never the browser: the Giphy key stays server-side, and
 * a provider outage degrades to an empty result rather than an error page.
 */
export const MEDIA = {
  /** Longest accepted search query. */
  queryMax: 60,
  /** Results returned to the editor per request. */
  results: 24,
  /** Absolute ceiling, whatever a caller asks for. */
  resultsMax: 48,
  /** Giphy's published public beta key: enough for small installs, no secret. */
  giphyBetaKey: 'dc6zaTOxFJmzC',
  /** Hosts a GIF may be imported from into the curated sticker pack. */
  giphyHosts: ['media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'i.giphy.com'],
  nekoHosts: ['nekos.best', 'nekos.best.cdn'],
};

/**
 * How many pastes one profile may pin. Three keeps the top of a profile
 * curated without letting it become a second, unordered listing.
 */
export const PROFILE_PIN_LIMIT = 3;

/** Sessions last 30 days and slide forward on activity. */
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
/** Re-issue a session cookie when less than this much lifetime remains. */
export const SESSION_REFRESH_SECONDS = 7 * 24 * 3600;

/** How long a successful paste unlock lasts (cookie + signed token). */
export const UNLOCK_TTL_SECONDS = 30 * 60;
/** At most this many unlocked pastes are remembered in one browser. */
export const UNLOCK_MAX_TOKENS = 3;

export const COOKIE = {
  session: 'mb_session',
  theme: 'mb_theme',
  /** Signed, paste-scoped unlock proof — never readable from client JS. */
  unlock: 'mb_unlock',
};

/** A view only counts once per IP per paste within this window. */
export const VIEW_DEDUPE_SECONDS = 6 * 3600;

/**
 * Paste visibility. `unlisted` is the historic behaviour (link-only, never
 * listed anywhere); `public` lists the paste on the owner's opt-in profile
 * page. Public pastes require an account — anonymous pastes are always
 * unlisted — and flipping a paste back to unlisted unlists it immediately.
 */
export const VISIBILITY = [
  { id: 'unlisted', label: 'Unlisted', hint: 'Only people with the link can read it. Never listed anywhere.' },
  { id: 'public', label: 'Public', hint: 'Listed on your public profile. Anyone with your profile link can read it.' },
];

export const DEFAULT_VISIBILITY = 'unlisted';

/** How many public pastes a profile page (web + API) shows, newest first. */
export const PROFILE_PASTE_LIMIT = 100;

/**
 * Named themes. `auto` (no cookie) follows the operating system; the toggle
 * cycles light → dark → ocean → auto.
 */
export const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'auto', label: 'Auto' },
];

/**
 * Line-level formatting (merge phase 1).
 *
 * A paste's `content` is always the exact text — the source of truth for
 * `/raw`, download, QR, fork, expiry, burning and the password gate. Rich
 * presentation is an *optional overlay* stored beside it in
 * `pastes.formatting` (JSON), keyed by 1-based line number:
 *
 *   { v: 1, lines: [ { line: 3, font: 'sans', size: 'lg', color: 'red' } ] }
 *
 * Every value here is an **id**, never a raw CSS value: the renderer emits a
 * class (`fmt-f-sans`, `fmt-s-lg`, `fmt-c-red`) that resolves to a theme-aware
 * variable in `public/app.css`. That keeps the strict CSP intact (no inline
 * styles), keeps the palette legible in every theme, and means a stored
 * document can never inject markup or CSS. Unknown ids are dropped rather
 * than erroring — formatting is a display hint, so a paste must still save.
 */
export const FORMAT_FONTS = FONTS;

export const FORMAT_SIZES = [
  { id: 'sm', label: 'Small', px: 12 },
  { id: 'md', label: 'Normal', px: 14 },
  { id: 'lg', label: 'Large', px: 18 },
  { id: 'xl', label: 'Heading', px: 24 },
  { id: 'xxl', label: 'Title', px: 32 },
];

export const FORMAT_COLORS = [
  { id: 'red', label: 'Red' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'teal', label: 'Teal' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' },
  { id: 'gray', label: 'Gray' },
];

export const FORMAT = {
  /** Overlay shape version — bump only with a migration story. */
  version: 1,
  /** Hard cap on formatted lines: a display hint must not become a page cost. */
  maxLines: 2000,
  /** Hard cap on the serialised overlay itself. */
  maxBytes: 64 * 1024,
};

/**
 * Built-in emoji shortcodes, resolvable with no database and no admin setup.
 * `:fire:` and `;fire;` are both accepted (the `;` form came from VibeBin).
 * The curated sticker pack (`stickers` table) is consulted first at render
 * time, so an administrator can override any token by adding it; an unknown
 * token is left as literal text.
 */
export const EMOJI_SHORTCODES = {
  wave: '👋', fire: '🔥', heart: '❤️', rocket: '🚀', sparkles: '✨', tada: '🎉',
  thumbsup: '👍', ok: '👌', clap: '👏', pray: '🙏', eyes: '👀', brain: '🧠',
  bug: '🐛', wrench: '🔧', hammer: '🔨', lock: '🔒', key: '🔑', bulb: '💡',
  warning: '⚠️', check: '✅', cross: '❌', star: '⭐', zap: '⚡', boom: '💥',
  coffee: '☕', pizza: '🍕', cake: '🍰', gift: '🎁', money: '💰', chart: '📈',
  pin: '📌', memo: '📝', book: '📚', link: '🔗', shield: '🛡️', ghost: '👻',
  smile: '😄', laugh: '😂', think: '🤔', cry: '😢', cool: '😎', party: '🥳',
  sad: '😞', angry: '😠', love: '🥰', shrug: '🤷', facepalm: '🤦', dance: '💃',
  hug: '🤗', kiss: '😘', pat: '🖐️', blush: '😊', wink: '😉',
};

/** Batch size for the scheduled cleanup job. */
export const CLEANUP_BATCH = 500;

/**
 * Reactions: **one per account per paste**, chosen from this fixed palette.
 *
 * VibeBin allowed any single emoji plus a curated sticker token; MantisBin
 * keeps the *one reaction per account* rule and narrows the vocabulary to a
 * fixed, curated palette. That is deliberate:
 *
 *  - the palette is what the paste page renders, so the layout is predictable
 *    (no 40-emoji pile-up under a paste);
 *  - counts group cleanly (`❤️ 4 · 🔥 2`) without storing free-form text;
 *  - the stored value is *canonical* — the emoji itself, validated on the way
 *    in and on the way out — so nothing a visitor sends is ever rendered as
 *    anything but one of these glyphs.
 *
 * The sticker pack is deliberately NOT used for reactions in this phase: a
 * reaction is a single glyph with a count, and mixing remote images into that
 * row would make the count unreadable.
 */
export const REACTIONS = [
  { id: 'heart', emoji: '❤️', label: 'Love' },
  { id: 'fire', emoji: '🔥', label: 'Fire' },
  { id: 'clap', emoji: '👏', label: 'Applause' },
  { id: 'laugh', emoji: '😂', label: 'Funny' },
  { id: 'party', emoji: '🎉', label: 'Celebrate' },
  { id: 'eyes', emoji: '👀', label: 'Watching' },
  { id: 'mindblown', emoji: '🤯', label: 'Mind blown' },
  { id: 'skull', emoji: '💀', label: 'Dead' },
];

/** The canonical glyphs, for validation. */
export const REACTION_EMOJIS = new Set(REACTIONS.map((reaction) => reaction.emoji));

/** Notification types (stable identifiers, never UI strings). */
export const NOTIFICATION_TYPES = ['follow', 'reaction', 'new_paste', 'admin'];

/**
 * Bounds for the social layer. Everything here is a budget that keeps a
 * popular account from turning one click into unbounded work: a follow with
 * 50 000 followers writes at most `fanout` rows, a mailbox lists
 * `notificationPage` rows per page, and read notifications are pruned after
 * `notificationRetention` seconds so the table cannot grow forever.
 */
export const SOCIAL = {
  /** Saved pastes per account. */
  bookmarks: 2000,
  /** Accounts one broadcast may reach; a bigger audience needs a second send. */
  broadcastMax: 5000,
  /** Broadcast title / message caps, enforced on the way in. */
  broadcastTitle: 120,
  broadcastMessage: 500,
  /** Followers notified when an account publishes a public paste. */
  fanout: 500,
  /** Notifications per page. */
  notificationPage: 20,
  /** Read notifications older than this are deleted by maintenance. */
  notificationRetention: 30 * 86400,
  /** Rows per followers/following page. */
  followListPage: 50,
  /** Unread badge saturates here ("9+"). */
  unreadBadgeMax: 9,
};

/**
 * Names that no account may take, checked case-insensitively.
 *
 * With 3–20 character handles the namespace is wide enough for names that
 * look like the service itself, so the operator's own vocabulary is fenced
 * off: routes (`admin`, `api`, `me`, `docs`, `login`, `register`, `u`, `p`),
 * brand (`mantisbin`, `mantis`), and support-flavoured names that would make
 * an ordinary user look official. Reserved names are rejected at registration
 * with "That username is reserved."; a reservation is not a user row, so
 * nothing else in the app has to know about it.
 */
export const RESERVED_USERNAMES = [
  'admin', 'administrator', 'api', 'docs', 'login', 'logout', 'register',
  'support', 'help', 'root', 'moderator', 'mod', 'staff', 'official', 'system',
  'mantisbin', 'mantis', 'security', 'abuse', 'billing', 'team', 'profile', 'account',
];
// Single/double-letter route words (`u`, `p`, `me`) are deliberately absent:
// the 3-character minimum already makes them unregisterable, and a username
// only ever appears in a URL as /u/:username, so they cannot collide.

