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
  usernameMin: 4,
  usernameMax: 6,
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
 * Uploads always go to catbox.moe (see lib/thumbnail.js). Add a
 * `CATBOX_USERHASH` in the dashboard so uploads are accepted (and deletable
 * from that account); with nothing set, uploads are anonymous. You may also
 * paste any `https:` image URL by hand — a link on any host is accepted.
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
 * upload target renders without extra configuration; operators can add more
 * with the `THUMBNAIL_HOSTS` variable. Because arbitrary `https:` image URLs
 * are allowed, `img-src` is widened to `https:` as well — see lib/http.js.
 */
export const THUMBNAIL_DEFAULT_HOSTS = ['files.catbox.moe'];

/**
 * Upload back end for `POST /p/thumbnail`: catbox.moe only.
 *
 *   catbox — `POST https://catbox.moe/user/api.php`. Add a `CATBOX_USERHASH`
 *            in the dashboard so uploads are accepted from the Worker's
 *            datacenter IPs (and deletable from that account); without it,
 *            uploads are anonymous.
 *
 * MantisBin never stores image bytes: the Worker forwards them to catbox once
 * and keeps only the returned link. Set `THUMBNAIL_UPLOADS="off"` to disable
 * uploading entirely — the editor still accepts a pasted image URL.
 */
export const THUMBNAIL_PROVIDERS = [
  { id: 'catbox', label: 'catbox.moe', endpoint: 'https://catbox.moe/user/api.php' },
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
};

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

/** Batch size for the scheduled cleanup job. */
export const CLEANUP_BATCH = 500;
