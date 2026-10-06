/**
 * Line-level formatting + shortcode rendering (merge phase 1).
 *
 * **Formatting is a display hint, never the content.** A paste's `content`
 * column stays the exact text an author typed, so `/raw`, download, QR, fork,
 * expiry, burn-after-reading and the password gate all keep working on a plain
 * string. This module owns the overlay that sits beside it:
 *
 *   { v: 1, lines: [ { line: 3, font: 'sans', size: 'lg', color: 'red' } ] }
 *
 * Rules, in one place:
 *
 *  - **Ids only.** Font/size/colour are ids from `config.js`, rendered as CSS
 *    classes (`fmt-f-sans`, `fmt-s-lg`, `fmt-c-red`). No inline styles, so the
 *    strict CSP (`style-src 'self'`) is untouched and a stored document can
 *    never inject CSS or markup.
 *  - **Hints degrade, they never fail a save.** An unknown font id, an
 *    out-of-range line number or a non-string value is dropped; only an
 *    unparseable or oversized payload is rejected outright. A paste must never
 *    be lost because its colour was wrong.
 *  - **Shortcodes are resolved at render time**, never stored: `:wave:` and
 *    `;wave;` become the curated sticker (an `<img>`) or, failing that, the
 *    built-in emoji. Because resolution happens on render, changing the pack
 *    changes every paste at once, and the stored text stays readable as typed.
 */

import { EMOJI_SHORTCODES, FORMAT, FORMAT_COLORS, FORMAT_FONTS, FORMAT_SIZES } from '../config.js';
import { escapeHtml } from './highlight.js';

/** @typedef {import('../db/turso.js').Db} Db */

const FONT_IDS = new Set(FORMAT_FONTS.map((font) => font.id));
const SIZE_IDS = new Set(FORMAT_SIZES.map((size) => size.id));
const COLOR_IDS = new Set(FORMAT_COLORS.map((color) => color.id));

/**
 * Private-use placeholders standing in for stickers while the text is
 * highlighted and escaped. They cannot appear in real paste text (the encoder
 * strips nothing, but U+E000–U+F8FF is reserved for exactly this), so a
 * placeholder in the output can only have come from this module.
 */
const PLACEHOLDER_START = 0xe000;
const PLACEHOLDER_END = 0xf8ff;
/**
 * Matches placeholder characters. Global, because it is used with `replace`;
 * `hasPlaceholder` is the only place allowed to run `test` on it, since `test`
 * advances `lastIndex` on a global regex.
 */
const PLACEHOLDER_RE = /[\uE000-\uF8FF]/g;

/** Does this HTML contain at least one sticker placeholder? */
function hasPlaceholder(html) {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(html);
}

/** @typedef {{ token: string, url: string | null, emoji: string | null, label: string }} Sticker */

/** Empty overlay — what a paste without formatting resolves to. */
export function emptyFormatting() {
  return { v: FORMAT.version, lines: [] };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalise one line entry. Returns `null` when nothing usable is left, so an
 * entry that is entirely unknown ids does not occupy a slot in the overlay.
 * @param {any} entry
 * @param {number} lineCount
 */
function normalizeEntry(entry, lineCount) {
  if (!isPlainObject(entry)) return null;
  const line = Number(entry.line);
  if (!Number.isInteger(line) || line < 1 || line > lineCount) return null;

  /** @type {{ line: number, font?: string, size?: string, color?: string }} */
  const out = { line };
  if (typeof entry.font === 'string' && FONT_IDS.has(entry.font)) out.font = entry.font;
  if (typeof entry.size === 'string' && SIZE_IDS.has(entry.size)) out.size = entry.size;
  if (typeof entry.color === 'string' && COLOR_IDS.has(entry.color)) out.color = entry.color;
  return out.font || out.size || out.color ? out : null;
}

/**
 * Validate and canonicalise an overlay coming from a form field or the API.
 *
 * Accepts either a JSON string or an already-parsed object. Line numbers are
 * clamped to the paste being saved, duplicates collapse (last wins) and the
 * result is sorted. Returns a compact JSON string ready for storage, or `null`
 * when there is nothing to store.
 *
 * @param {unknown} raw
 * @param {{ lineCount: number }} options
 * @returns {{ ok: boolean, value?: string | null, error?: string, lines?: number }}
 */
export function normalizeFormatting(raw, options) {
  const lineCount = Math.max(1, Number(options?.lineCount) || 1);
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null, lines: 0 };

  let parsed = raw;
  if (typeof raw === 'string') {
    if (raw.length > FORMAT.maxBytes) {
      return { ok: false, error: 'Formatting data is too large. Save the paste again to reset it.' };
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated or hand-edited field must not cost the author their paste.
      return { ok: true, value: null, lines: 0 };
    }
  }
  if (!isPlainObject(parsed)) return { ok: true, value: null, lines: 0 };

  const doc = /** @type {{ v?: unknown, lines?: unknown }} */ (parsed);
  const version = Number(doc.v ?? FORMAT.version);
  if (version !== FORMAT.version) return { ok: true, value: null, lines: 0 };

  const incoming = Array.isArray(doc.lines) ? doc.lines : [];
  /** @type {Map<number, any>} */
  const byLine = new Map();
  for (const entry of incoming.slice(0, FORMAT.maxLines * 2)) {
    const normalized = normalizeEntry(entry, lineCount);
    if (normalized) byLine.set(normalized.line, normalized);
  }
  if (!byLine.size) return { ok: true, value: null, lines: 0 };

  // Two budgets bound what is stored: a line count and a byte size. Both are
  // spent top-down, so the visible start of a long paste keeps its styling and
  // only the tail is dropped. Formatting is a display hint — running out of
  // room trims it, it never costs the author their paste.
  const wanted = [...byLine.values()].sort((a, b) => a.line - b.line).slice(0, FORMAT.maxLines);
  const budget = FORMAT.maxBytes - 32; // wrapper + separators, with slack
  let used = 0;
  let lines = [];
  for (const entry of wanted) {
    const cost = JSON.stringify(entry).length + 1;
    if (used + cost > budget) break;
    used += cost;
    lines.push(entry);
  }
  if (!lines.length) return { ok: true, value: null, lines: 0 };
  const serialized = JSON.stringify({ v: FORMAT.version, lines });
  if (serialized.length > FORMAT.maxBytes) return { ok: true, value: null, lines: 0 };
  return { ok: true, value: serialized, lines: lines.length };
}

/**
 * Parse a stored overlay. A malformed or stale value resolves to "no
 * formatting" — rendering must never fail because of a display hint.
 * @param {unknown} raw
 * @returns {{ v: number, lines: Array<{ line: number, font?: string, size?: string, color?: string }> }}
 */
export function parseFormatting(raw) {
  if (typeof raw !== 'string' || raw === '') return emptyFormatting();
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.lines)) return emptyFormatting();
    // An overlay written by a future version may mean something else by these
    // fields; render it plain rather than guessing.
    if (Number(parsed.v ?? FORMAT.version) !== FORMAT.version) return emptyFormatting();
    const lines = parsed.lines
      .map((entry) => normalizeEntry(entry, Number.MAX_SAFE_INTEGER))
      .filter(Boolean);
    return { v: FORMAT.version, lines };
  } catch {
    return emptyFormatting();
  }
}

/** True when an overlay has anything to render. */
export function hasFormatting(formatting) {
  return Boolean(formatting && Array.isArray(formatting.lines) && formatting.lines.length);
}

/** CSS classes for one line entry, e.g. `fmt-f-sans fmt-s-lg fmt-c-red`. */
export function lineClasses(entry) {
  if (!entry) return '';
  const classes = [];
  if (entry.font) classes.push(`fmt-f-${entry.font}`);
  if (entry.size) classes.push(`fmt-s-${entry.size}`);
  if (entry.color) classes.push(`fmt-c-${entry.color}`);
  return classes.join(' ');
}

/**
 * Line number → class string, for the renderer. Lines without formatting are
 * absent from the map, so the common case costs nothing.
 * @param {{ v: number, lines: any[] }} formatting
 * @returns {Map<number, string>}
 */
export function lineClassMap(formatting) {
  /** @type {Map<number, string>} */
  const map = new Map();
  if (!hasFormatting(formatting)) return map;
  for (const entry of formatting.lines) {
    const classes = lineClasses(entry);
    if (classes) map.set(Number(entry.line), classes);
  }
  return map;
}

/** Human summary for the paste page meta row ("3 lines formatted"). */
export function formattingSummary(formatting) {
  const count = hasFormatting(formatting) ? formatting.lines.length : 0;
  return count === 0 ? '' : `${count} formatted ${count === 1 ? 'line' : 'lines'}`;
}

// ---------------------------------------------------------------------------
// Stickers + shortcodes
// ---------------------------------------------------------------------------

/**
 * Index of the shortcodes that can be resolved right now.
 *
 * The curated pack wins over the built-in emoji set, so an operator can point
 * `:wave:` at an animated sticker without changing any paste. A pack entry
 * with an unusable URL contributes its emoji instead, and a pack entry with
 * neither URL nor emoji is ignored.
 *
 * @param {any[]} [rows] rows from the `stickers` table
 * @returns {Map<string, Sticker>}
 */
export function stickerIndex(rows = []) {
  /** @type {Map<string, Sticker>} */
  const index = new Map();
  for (const [name, emoji] of Object.entries(EMOJI_SHORTCODES)) {
    index.set(name, { token: `:${name}:`, url: null, emoji, label: `:${name}:` });
  }
  for (const row of rows) {
    const name = shortcodeName(row?.token);
    if (!name) continue;
    const emoji = typeof row.emoji === 'string' && row.emoji.trim() ? row.emoji.trim() : null;
    const url = safeStickerUrl(row.url);
    if (!url && !emoji) continue;
    index.set(name, {
      token: `:${name}:`,
      url,
      emoji,
      label: typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, 60) : name,
    });
  }
  return index;
}

/**
 * The shortcode name inside a token, lowercased: `:Wave:` → `wave`.
 *
 * Accepts `:name:` and `;name;` (the two shapes an author can type) and a bare
 * `name`, because a curated pack row is written by an operator and a stray
 * delimiter should not silently disable their sticker.
 * @param {unknown} token
 * @returns {string | null}
 */
export function shortcodeName(token) {
  if (typeof token !== 'string') return null;
  const match = /^[:;]?([a-z0-9][a-z0-9_-]{0,31})[:;]?$/i.exec(token.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Sticker images live on third-party hosts, exactly like thumbnails, so the
 * same rule applies: `https:` only, no credentials, and a length cap. Anything
 * else falls back to the emoji — a broken or hostile URL never reaches a page.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeStickerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (raw.length > 500) return null;
  if (raw.startsWith('data:')) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const SHORTCODE_RE = /[:;]([a-z0-9][a-z0-9_-]{0,31})[:;]/gi;

/**
 * Replace resolvable shortcodes in raw text with either the emoji itself or a
 * private-use placeholder for a sticker image.
 *
 * Runs on the **source** text before escaping, so the surrounding code is
 * highlighted exactly as typed and the substitution can never produce markup.
 * @param {string} text
 * @param {Map<string, Sticker>} index
 * @returns {{ text: string, stickers: Sticker[] }}
 */
export function substituteShortcodes(text, index) {
  const source = String(text ?? '');
  /** @type {Sticker[]} */
  const stickers = [];
  if (!source || !index.size || !/[:;]/.test(source)) return { text: source, stickers };
  const out = source.replace(SHORTCODE_RE, (match, name) => {
    const found = index.get(String(name).toLowerCase());
    if (!found) return match;
    if (!found.url) return found.emoji || match;
    const placeholder = String.fromCharCode(PLACEHOLDER_START + stickers.length);
    if (placeholder.charCodeAt(0) > PLACEHOLDER_END) return found.emoji || match;
    stickers.push(found);
    return placeholder;
  });
  return { text: out, stickers };
}

/**
 * A line that is nothing but an https image URL becomes an image.
 *
 * This is the one rendering rule added for GIF search (merge phase 4): the
 * editor inserts the URL the provider returned, on its own line, and the paste
 * shows the picture. The rule is deliberately narrow — the whole line must be
 * the URL (only surrounding whitespace allowed) and the path must end in an
 * image extension — so a URL written *inside* a sentence is still just a link,
 * and ordinary prose is never re-interpreted. `content` is untouched either way:
 * `/raw`, download, fork and the API keep the exact bytes the author typed.
 */
const MEDIA_LINE_RE = /^[ \t]*(https:\/\/[^\s<>"']+\.(?:gif|png|jpe?g|webp))[ \t]*$/i;

/**
 * Replace standalone image URLs with the same placeholders shortcodes use, so
 * the renderer needs no second code path.
 *
 * @param {string} text source text (after `substituteShortcodes`)
 * @param {Sticker[]} [stickers] the running placeholder list, extended in place
 * @returns {{ text: string, stickers: Sticker[] }}
 */
export function substituteMediaLines(text, stickers = []) {
  const source = String(text ?? '');
  if (!source || !/https:\/\//i.test(source)) return { text: source, stickers };
  /** @type {Sticker[]} */
  const images = stickers;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = MEDIA_LINE_RE.exec(lines[index]);
    if (!match) continue;
    const url = safeStickerUrl(match[1]);
    if (!url) continue;
    const placeholder = String.fromCharCode(PLACEHOLDER_START + images.length);
    if (placeholder.charCodeAt(0) > PLACEHOLDER_END) break;
    images.push({ token: '', url, emoji: '', label: 'image' });
    lines[index] = lines[index].replace(match[1], placeholder);
  }
  return { text: lines.join('\n'), stickers: images };
}

/**
 * Both substitution passes in one call: `:shortcode:` tokens first, then
 * standalone image URLs. The placeholder list is shared, so the renderer sees
 * one flat array.
 * @param {string} text
 * @param {Map<string, Sticker>} index
 * @returns {{ text: string, stickers: Sticker[] }}
 */
export function resolveStickers(text, index) {
  const shortcodes = substituteShortcodes(text, index);
  return substituteMediaLines(shortcodes.text, shortcodes.stickers);
}

/** HTML for one sticker image. Attributes are literal; only the URL varies. */
function stickerHtml(sticker) {
  const label = escapeHtml(sticker.label || 'sticker');
  return (
    `<img class="sticker" src="${escapeHtml(sticker.url ?? '')}" alt="${label}" ` +
    `title="${label}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
  );
}

/**
 * Swap placeholder characters for sticker markup *after* escaping and
 * highlighting.
 *
 * The HTML is walked tag by tag and placeholders are replaced **only in text
 * segments**, never inside an attribute. That matters for a pathological case:
 * a shortcode written inside a URL (`https://x.test/:wave:`) has already been
 * turned into an anchor by the highlighter, and the placeholder is sitting in
 * its `href`. Substituting there would inject markup into an attribute; skipping
 * tag segments leaves the character as inert literal text instead.
 *
 * @param {string} escaped already-escaped, placeholdered HTML
 * @param {Sticker[]} stickers
 */
export function renderStickers(escaped, stickers) {
  const html = String(escaped ?? '');
  if (!stickers.length || !hasPlaceholder(html)) return html;
  return html
    .split(/(<[^>]*>)/g)
    .map((segment) => {
      if (!segment || segment[0] === '<') return segment;
      return segment.replace(PLACEHOLDER_RE, (char) => {
        const sticker = stickers[char.charCodeAt(0) - PLACEHOLDER_START];
        return sticker ? stickerHtml(sticker) : char;
      });
    })
    .join('');
}

/** Does this text contain anything that looks like a shortcode? */
export function hasShortcode(text) {
  SHORTCODE_RE.lastIndex = 0;
  return SHORTCODE_RE.test(String(text ?? ''));
}

/**
 * Load the sticker pack. Kept here (rather than in a route) so the web view,
 * the API and the editor preview all resolve shortcodes the same way.
 * @param {Db} db
 * @returns {Promise<Sticker[]>}
 */
export async function loadStickers(db) {
  try {
    return /** @type {Sticker[]} */ (
      await db.all('SELECT token, url, emoji, label FROM stickers ORDER BY created_at DESC LIMIT 500')
    );
  } catch {
    // A database that predates the sticker table renders emoji only.
    return [];
  }
}
