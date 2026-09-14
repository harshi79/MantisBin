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
  /** Paste ID length (base62). */
  idLength: 8,
};

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
 * Fonts are system font stacks on purpose: zero downloads, zero layout shift,
 * works identically in the editor and the viewer.
 */
export const FONTS = [
  {
    id: 'mono',
    label: 'Mono (default)',
    stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
  { id: 'sans', label: 'Sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif' },
  { id: 'classic', label: 'Typewriter', stack: '"Courier New", Courier, ui-monospace, monospace' },
];

export const DEFAULT_FONT = 'mono';

export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20];
export const DEFAULT_FONT_SIZE = 14;

/**
 * Supported languages (manual selection only — no auto-detection).
 * `plaintext` renders escaped text with no tokens.
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
};

/** Sessions last 30 days and slide forward on activity. */
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
/** Re-issue a session cookie when less than this much lifetime remains. */
export const SESSION_REFRESH_SECONDS = 7 * 24 * 3600;

export const COOKIE = {
  session: 'mb_session',
  theme: 'mb_theme',
};

/** A view only counts once per IP per paste within this window. */
export const VIEW_DEDUPE_SECONDS = 6 * 3600;

/** Batch size for the scheduled cleanup job. */
export const CLEANUP_BATCH = 500;
