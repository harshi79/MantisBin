/**
 * Server-side validation + normalisation.
 * Nothing here trusts the client: every value that reaches the database passes
 * through one of these functions.
 */

import { BURN_MODES, DEFAULT_BURN_MODE, DEFAULT_EXPIRATION, DEFAULT_FONT, DEFAULT_FONT_SIZE, DEFAULT_LANGUAGE, EXPIRATIONS, FONTS, FONT_SIZES, LANGUAGES, LIMITS } from '../config.js';

const encoder = new TextEncoder();

/** UTF-8 byte length (the limit we advertise is a byte limit). */
export function byteLength(value) {
  return encoder.encode(value).length;
}

/** @returns {string} */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  // Normalise newlines and drop NUL bytes (they break terminals + SQLite text).
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
}

/**
 * @typedef {{ ok: boolean, value?: string, error?: string, bytes?: number }} Result
 * One result shape everywhere: with `strictNullChecks` off, discriminated
 * unions do not narrow, so optional fields beat union branches.
 */

/**
 * Paste title — mandatory, single line, capped.
 * @returns {Result}
 */
export function validateTitle(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Title is required.' };
  const title = value.replace(/\s+/g, ' ').trim().slice(0, LIMITS.titleMax + 10);
  if (title.length < LIMITS.titleMin) return { ok: false, error: 'Title is required.' };
  if (title.length > LIMITS.titleMax) {
    return { ok: false, error: `Title must be ${LIMITS.titleMax} characters or fewer.` };
  }
  return { ok: true, value: title };
}

/**
 * Paste content — mandatory, byte-limited.
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {Result}
 */
export function validateContent(value, maxBytes) {
  if (typeof value !== 'string') return { ok: false, error: 'Content is required.' };
  const content = cleanText(value);
  const bytes = byteLength(content);
  if (bytes < LIMITS.contentMin) return { ok: false, error: 'Content cannot be empty.' };
  if (bytes > maxBytes) {
    return {
      ok: false,
      error: `Content is ${formatBytes(bytes)} — the limit is ${formatBytes(maxBytes)}${maxBytes === LIMITS.anonMaxBytes ? ' for anonymous users (sign in for 10 MB)' : ''}.`,
    };
  }
  return { ok: true, value: content, bytes };
}

/** 4–6 letters/numbers only, no separators. @returns {Result} */
export function validateUsername(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length < LIMITS.usernameMin || raw.length > LIMITS.usernameMax) {
    return { ok: false, error: `Username must be ${LIMITS.usernameMin}–${LIMITS.usernameMax} characters.` };
  }
  if (!/^[A-Za-z0-9]+$/.test(raw)) {
    return { ok: false, error: 'Username may only contain letters and numbers (no spaces, _ - . or symbols).' };
  }
  return { ok: true, value: raw };
}

/** @returns {Result} */
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < LIMITS.passwordMin) {
    return { ok: false, error: `Password must be at least ${LIMITS.passwordMin} characters.` };
  }
  if (value.length > LIMITS.passwordMax) {
    return { ok: false, error: 'Password is too long.' };
  }
  return { ok: true, value };
}

/**
 * Optional per-paste passphrase (2.2 §1). Unlike account passwords there is no
 * complexity rule — it is a shared handoff code — but it may not be blank and
 * is byte-capped so hashing stays bounded. The value is never trimmed: spaces
 * are part of the secret.
 * @returns {Result}
 */
export function validatePassphrase(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: 'Passphrase cannot be blank. Leave the field empty to skip protection.' };
  }
  if (value.length < LIMITS.passphraseMin) {
    return { ok: false, error: `Passphrase must be at least ${LIMITS.passphraseMin} characters.` };
  }
  if (value.length > LIMITS.passphraseMax) {
    return { ok: false, error: `Passphrase must be ${LIMITS.passphraseMax} characters or fewer.` };
  }
  return { ok: true, value };
}

/**
 * Burn-after-reading mode (2.2 §2). Unlike an unknown language or font, an
 * unknown burn mode is a hard error: silently downgrading "burn after reading"
 * to a permanent paste would be the exact opposite of what the caller asked for.
 * An empty/missing value means the default (`never`).
 * @returns {Result}
 */
export function validateBurnMode(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: DEFAULT_BURN_MODE };
  }
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (id && BURN_MODES.some((mode) => mode.id === id)) return { ok: true, value: id };
  return {
    ok: false,
    error: `Unknown burn mode. Use one of: ${BURN_MODES.map((mode) => mode.id).join(', ')}.`,
  };
}

/** Human-readable burn mode label ("Burn after the first view"). */
export function burnModeLabel(value) {
  const found = BURN_MODES.find((mode) => mode.id === value);
  return found ? found.label : '';
}

/** Whitelist a language id. */
export function normalizeLanguage(value) {
  const id = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (id && LANGUAGES.some((l) => l.id === id)) return id;
  return DEFAULT_LANGUAGE;
}

/** Whitelist a font id. */
export function normalizeFont(value) {
  const id = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (id && FONTS.some((f) => f.id === id)) return id;
  return DEFAULT_FONT;
}

/** Whitelist a font size. */
export function normalizeFontSize(value) {
  const size = Number(value);
  if (FONT_SIZES.includes(size)) return size;
  return DEFAULT_FONT_SIZE;
}

/**
 * Expiration: accepts a preset id ("1w"), a number of seconds, or "never".
 * @returns {{ id: string, seconds: number, expiresAt: number | null }}
 */
export function normalizeExpiration(value, now = Math.floor(Date.now() / 1000)) {
  const raw = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  let preset = EXPIRATIONS.find((e) => e.id === raw);
  if (!preset && raw !== '') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      preset = EXPIRATIONS.find((e) => e.seconds === seconds);
    }
  }
  if (!preset) preset = EXPIRATIONS.find((e) => e.id === DEFAULT_EXPIRATION) ?? EXPIRATIONS[EXPIRATIONS.length - 1];
  return {
    id: preset.id,
    seconds: preset.seconds,
    expiresAt: preset.seconds > 0 ? now + preset.seconds : null,
  };
}

/**
 * Pick the preset closest to (but not shorter than) a moment in the future.
 * Used when a paste is duplicated so the copy keeps the source's remaining life
 * without ever outliving it more than one preset step.
 * @param {number | null | undefined} expiresAt
 * @param {number} now
 * @returns {string} an EXPIRATIONS id
 */
export function expirationPresetFor(expiresAt, now = Math.floor(Date.now() / 1000)) {
  if (expiresAt === null || expiresAt === undefined) return 'never';
  const remaining = Number(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return 'never';
  for (const option of EXPIRATIONS) {
    if (option.seconds > 0 && option.seconds >= remaining) return option.id;
  }
  return '1y';
}

const PASTE_ID_RE = new RegExp(`^[A-Za-z0-9]{${LIMITS.idLength}}$`);

/** Paste IDs are base62 strings of a fixed length; reject anything else early. */
export function isValidPasteId(value) {
  return typeof value === 'string' && PASTE_ID_RE.test(value);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

export function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

/** "3 minutes ago" / "in 2 days" — small, dependency-free relative time. */
export function relativeTime(epochSeconds, now = Math.floor(Date.now() / 1000)) {
  const target = Number(epochSeconds);
  if (!Number.isFinite(target)) return '';
  const diff = target - now;
  const abs = Math.abs(diff);
  /** @type {Array<[string, number]>} */
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [name, seconds] of units) {
    if (abs >= seconds) {
      const value = Math.round(diff / seconds);
      return formatRelative(value, name);
    }
  }
  return diff < 0 ? 'just now' : 'in a few seconds';
}

function formatRelative(value, unit) {
  const label = Math.abs(value) === 1 ? unit : `${unit}s`;
  return value < 0 ? `${Math.abs(value)} ${label} ago` : `in ${value} ${label}`;
}

export function formatDateTime(epochSeconds) {
  const date = new Date(Number(epochSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Filename for the raw endpoint / download: keep it boring and safe. */
export function safeFilename(title) {
  const base = String(title || 'paste')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'paste';
}
