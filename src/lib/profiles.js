/**
 * Profile customisation (merge phase 2).
 *
 * VibeBin let a profile choose arbitrary colours and free-form animation
 * parameters, which it applied with inline styles. MantisBin's CSP is
 * `style-src 'self'` with **no inline styles anywhere**, so this module does
 * two things instead:
 *
 *  1. Everything a profile chooses is stored as a **validated id or a strict
 *     `#rrggbb` hex** — never a CSS fragment, never free text.
 *  2. Those values are rendered by a **generated stylesheet**
 *     (`/u/:username/theme.css`), which is same-origin and therefore allowed.
 *     The profile page links it with a content hash in the query string, so it
 *     is immutable-cacheable forever and changes the moment the profile does.
 *
 * That keeps the strict CSP intact while still allowing an arbitrary accent
 * colour, animation speed and intensity — the three things VibeBin used inline
 * CSS for.
 *
 * Imported by the profile route, the profile + customiser views, the API and
 * the tests, so validation and rendering can never drift apart.
 */

import { EMOJI_SHORTCODES } from '../config.js';
import { NAME_EFFECTS as NAME_EFFECT_PRESETS } from './nameEffects.js';

/** @typedef {import('../db/turso.js').Db} Db */

// ---------------------------------------------------------------------------
// Limits + vocabulary
// ---------------------------------------------------------------------------

export const PROFILE_LIMITS = {
  /** Display name = the name shown instead of the handle. */
  displayName: 40,
  bio: 280,
  statusText: 60,
  /** A status is at most this many emoji graphemes (VibeBin's rule). */
  statusGraphemes: 3,
  links: 6,
  linkLabel: 40,
  accent: 7,
  bannerUrl: 500,
};

/** The accent used when a profile has none (and the fallback for junk). */
export const ACCENT_DEFAULT = '#8b5cf6';

/**
 * Accent swatches offered by the customiser. Any `#rrggbb` is accepted by the
 * API — these are just the friendly choices, and they double as the palette
 * for tags (`tags.color` holds one of these ids, never a hex).
 */
export const ACCENT_PRESETS = [
  { id: 'violet', label: 'Violet', hex: '#8b5cf6' },
  { id: 'indigo', label: 'Indigo', hex: '#6366f1' },
  { id: 'cyan', label: 'Cyan', hex: '#22d3ee' },
  { id: 'teal', label: 'Teal', hex: '#2dd4bf' },
  { id: 'emerald', label: 'Emerald', hex: '#34d399' },
  { id: 'amber', label: 'Amber', hex: '#fbbf24' },
  { id: 'orange', label: 'Orange', hex: '#fb923c' },
  { id: 'rose', label: 'Rose', hex: '#fb7185' },
  { id: 'pink', label: 'Pink', hex: '#f472b6' },
  { id: 'slate', label: 'Slate', hex: '#94a3b8' },
];

const ACCENT_BY_ID = new Map(ACCENT_PRESETS.map((preset) => [preset.id, preset]));

/** Banner styles. Video banners were dropped: they need `media-src` in the CSP. */
export const BANNER_TYPES = [
  { id: 'image', label: 'Image', hint: 'An https image URL, like a paste thumbnail.' },
  { id: 'gradient', label: 'Gradient', hint: 'A soft wash built from your accent colour.' },
];

export const BANNER_TYPE_IDS = new Set(BANNER_TYPES.map((type) => type.id));

/** Admin-awarded tag colours: ids only, so a tag can never inject CSS. */
export const TAG_COLORS = ACCENT_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }));

/** Optional per-tag animation, rendered as a static class. */
export const TAG_EFFECTS = [
  { id: '', label: 'None' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'glow', label: 'Glow' },
];

export const TAG_EFFECT_IDS = new Set(TAG_EFFECTS.map((effect) => effect.id));
const TAG_COLOR_IDS = new Set(TAG_COLORS.map((color) => color.id));

/** Re-exported so callers never import two modules to build an effect picker. */
export const NAME_EFFECTS = NAME_EFFECT_PRESETS.map((effect) => ({
  id: effect.id,
  label: effect.label,
  emoji: effect.emoji,
  category: effect.category,
  className: effect.className,
}));

const NAME_EFFECT_IDS = new Set(NAME_EFFECTS.map((effect) => effect.id));

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

/** Trim, drop control characters and collapse runs of whitespace. */
function cleanText(value, max) {
  return String(value ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Strict `#rrggbb`. Anything else — including the old hex column default, a
 * named colour or a CSS fragment — resolves to the fallback, so a stored value
 * can never carry CSS syntax into the stylesheet.
 * @param {unknown} value
 * @param {string} [fallback]
 */
export function normalizeHex(value, fallback = ACCENT_DEFAULT) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  // A shorthand hex is unambiguous, so accept and expand it.
  if (/^#[0-9a-f]{3}$/.test(raw)) return `#${raw.slice(1).split('').map((ch) => ch + ch).join('')}`;
  return fallback;
}

/** `#8b5cf6` → `139, 92, 246` (for the alpha variants in the theme sheet). */
function hexChannels(hex) {
  const value = normalizeHex(hex);
  return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16)).join(', ');
}

/** An accent preset id (`violet`) or, as a courtesy, its hex. */
export function normalizeAccentPreset(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (ACCENT_BY_ID.has(raw)) return raw;
  const byHex = ACCENT_PRESETS.find((preset) => preset.hex === raw);
  return byHex ? byHex.id : null;
}

/** Clamp an effect parameter to 0–100; anything else becomes the default. */
export function normalizeEffectValue(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, Math.round(number)));
}

/** Animation duration from a 0–100 "speed" (higher = faster). */
export function effectDuration(speed) {
  const value = normalizeEffectValue(speed, 50);
  // 100 → 1.6s, 50 → 4s, 0 → 9s, rounded to a tenth of a second.
  const seconds = 9 - (value / 100) * 7.4;
  return Math.round(seconds * 10) / 10;
}

/** Effect strength from a 0–100 "intensity". */
export function effectStrength(intensity) {
  const value = normalizeEffectValue(intensity, 60);
  return Math.round((0.25 + (value / 100) * 0.75) * 100) / 100;
}

/**
 * A status emoji: at most three graphemes, no control characters, no markup and
 * no URL schemes. Grapheme-aware so a flag, a ZWJ family or a skin-tone
 * modifier is never sliced in half. Returns `''` when the value is unusable.
 * @param {unknown} value
 */
export function normalizeStatusEmoji(value) {
  const raw = String(value ?? '').normalize('NFC').trim();
  if (!raw) return '';
  if (/[\u0000-\u001f\u007f<>]/.test(raw)) return '';
  if (/^(?:https?:|data:|javascript:|file:|vbscript:)/i.test(raw)) return '';
  // A sticker token (`:fire:`) is resolved at render time like a shortcode.
  if (/^:[a-z0-9][a-z0-9_-]{0,31}:$/i.test(raw)) return raw.toLowerCase();
  let graphemes;
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    graphemes = [...segmenter.segment(raw)].map((entry) => entry.segment);
  } catch {
    graphemes = [...raw];
  }
  if (!graphemes.length || graphemes.length > PROFILE_LIMITS.statusGraphemes) return '';
  return graphemes.join('');
}

/**
 * A profile link: `https:` only, no credentials, ≤ 500 chars. A bare host is
 * tolerated (`github.com/me` → `https://github.com/me`) because that is what
 * people type; anything unparseable is dropped.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeProfileLink(value) {
  let raw = String(value ?? '').trim();
  if (!raw || raw.length > 500) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.toString();
}

/**
 * Social platforms, recognised by exact host or a legitimate subdomain.
 * Lookalikes (`github.com.evil.test`) deliberately fall through to `generic`.
 * Colour lives in CSS (`link-<platform>`), never in the data.
 */
const PLATFORMS = [
  { id: 'github', label: 'GitHub', hosts: ['github.com'] },
  { id: 'telegram', label: 'Telegram', hosts: ['t.me', 'telegram.me'] },
  { id: 'instagram', label: 'Instagram', hosts: ['instagram.com'] },
  { id: 'facebook', label: 'Facebook', hosts: ['facebook.com', 'fb.com', 'fb.watch'] },
  { id: 'youtube', label: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { id: 'discord', label: 'Discord', hosts: ['discord.com', 'discord.gg'] },
  { id: 'x', label: 'X', hosts: ['x.com', 'twitter.com'] },
  { id: 'linkedin', label: 'LinkedIn', hosts: ['linkedin.com'] },
  { id: 'twitch', label: 'Twitch', hosts: ['twitch.tv'] },
  { id: 'reddit', label: 'Reddit', hosts: ['reddit.com'] },
  { id: 'tiktok', label: 'TikTok', hosts: ['tiktok.com'] },
  { id: 'generic', label: 'Website', hosts: [] },
];

/**
 * @param {unknown} url
 * @returns {{ id: string, label: string, host: string }}
 */
export function detectPlatform(url) {
  const value = String(url ?? '').trim();
  let host = '';
  try {
    host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return { id: 'generic', label: 'Website', host: '' };
  }
  for (const platform of PLATFORMS) {
    if (platform.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return { id: platform.id, label: platform.label, host };
    }
  }
  return { id: 'generic', label: 'Website', host };
}

/**
 * Normalise the stored `links` column: a JSON string from the database, or an
 * array from a form/API body. Each entry becomes `{ url, label, platform }`.
 * Duplicates collapse, order is kept, and the list is capped.
 *
 * @param {unknown} raw
 * @returns {Array<{ url: string, label: string, platform: string }>}
 */
export function parseProfileLinks(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  /** @type {Array<{ url: string, label: string, platform: string }>} */
  const out = [];
  const seen = new Set();
  for (const entry of list.slice(0, PROFILE_LIMITS.links * 2)) {
    const source = entry && typeof entry === 'object' ? /** @type {any} */ (entry) : { url: entry };
    const url = safeProfileLink(source.url ?? source.link ?? source.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const platform = detectPlatform(url);
    out.push({ url, label: cleanText(source.label, PROFILE_LIMITS.linkLabel) || platform.label, platform: platform.id });
    if (out.length >= PROFILE_LIMITS.links) break;
  }
  return out;
}

/** Read a link list out of a form: repeated `link_url` / `link_label` fields. */
export function linksFromForm(form) {
  const urls = Array.isArray(form.link_url) ? form.link_url : form.link_url ? [form.link_url] : [];
  const labels = Array.isArray(form.link_label) ? form.link_label : form.link_label ? [form.link_label] : [];
  return urls.map((url, index) => ({ url, label: labels[index] ?? '' }));
}

// ---------------------------------------------------------------------------
// Row → canonical profile
// ---------------------------------------------------------------------------

/**
 * Canonical view of a stored profile row (or of "no profile yet").
 *
 * Every field is validated on the way out as well as on the way in: a row that
 * predates a rule, or was written by hand, still renders safely.
 *
 * @param {any} row
 * @param {{ created_at?: number } | null} [account]
 */
export function profileView(row, account = null) {
  const accent = normalizeHex(row?.accent);
  const nameEffect = NAME_EFFECT_IDS.has(String(row?.name_effect ?? '')) ? String(row.name_effect) : 'none';
  const bannerType = BANNER_TYPE_IDS.has(String(row?.banner_type ?? '')) ? String(row.banner_type) : 'image';
  const bannerUrl = safeProfileLink(row?.banner_url);
  return {
    displayName: cleanText(row?.display_name, PROFILE_LIMITS.displayName),
    bio: cleanText(row?.bio, PROFILE_LIMITS.bio),
    bioEnabled: row?.bio_enabled === undefined ? true : Boolean(Number(row.bio_enabled)),
    accent,
    accentSoft: `rgba(${hexChannels(accent)}, 0.16)`,
    nameEffect,
    effectSpeed: normalizeEffectValue(row?.effect_speed, 50),
    effectIntensity: normalizeEffectValue(row?.effect_intensity, 60),
    /** An image banner needs a URL; a gradient banner is complete without one. */
    bannerType: bannerUrl || bannerType === 'gradient' ? bannerType : bannerType === 'gradient' ? 'gradient' : 'image',
    bannerUrl: bannerUrl ?? '',
    statusEmoji: normalizeStatusEmoji(row?.status_emoji),
    statusText: cleanText(row?.status_text, PROFILE_LIMITS.statusText),
    links: parseProfileLinks(row?.links),
    views: Math.max(0, Number(row?.views ?? 0)),
    memberSince: Number(account?.created_at ?? 0),
  };
}

/** Does this profile differ from the defaults (i.e. did the owner style it)? */
export function isCustomised(profile) {
  return Boolean(
    profile &&
      (profile.displayName ||
        (profile.bio && profile.bioEnabled) ||
        profile.bannerUrl ||
        profile.bannerType === 'gradient' ||
        profile.accent !== ACCENT_DEFAULT ||
        profile.nameEffect !== 'none' ||
        profile.statusEmoji ||
        profile.statusText ||
        profile.links.length),
  );
}

/**
 * Resolve a stored status emoji.
 *
 * A status is either a Unicode emoji (validated above) or a shortcode token
 * such as `:fire:`. Tokens resolve exactly like paste shortcodes: the curated
 * sticker pack wins, then the built-in emoji, then the literal name — so a
 * status is never a broken image.
 *
 * @param {unknown} stored
 * @param {Map<string, { token: string, url: string | null, emoji: string | null, label: string }>} [index]
 * @returns {{ kind: 'empty' | 'emoji' | 'sticker', text: string, sticker: any | null }}
 */
export function resolveStatus(stored, index = new Map()) {
  const value = normalizeStatusEmoji(stored);
  if (!value) return { kind: 'empty', text: '', sticker: null };
  if (!value.startsWith(':')) return { kind: 'emoji', text: value, sticker: null };
  const name = value.slice(1, -1);
  const entry = index.get(name);
  if (!entry) return { kind: 'emoji', text: EMOJI_SHORTCODES[name] ?? `:${name}:`, sticker: null };
  if (entry.url) return { kind: 'sticker', text: entry.label || `:${name}:`, sticker: entry };
  return { kind: 'emoji', text: entry.emoji || `:${name}:`, sticker: null };
}

// ---------------------------------------------------------------------------
// The generated stylesheet
// ---------------------------------------------------------------------------

/**
 * Version tag for the stylesheet URL: a short hash of exactly the fields the
 * sheet renders, so the URL changes when (and only when) the CSS would.
 * @param {ReturnType<typeof profileView>} profile
 */
export async function themeHash(profile) {
  const material = [
    profile.accent,
    profile.nameEffect,
    profile.effectSpeed,
    profile.effectIntensity,
    profile.bannerType,
    profile.bannerUrl,
  ].join('|');
  // `crypto.subtle` is available in Workers and Node; a tiny fallback keeps the
  // hash deterministic if it ever is not.
  try {
    const { sha256Hex } = await import('./crypto.js');
    return (await sha256Hex(material)).slice(0, 10);
  } catch {
    let hash = 0;
    for (const char of material) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash.toString(16).padStart(8, '0').slice(0, 10);
  }
}

/**
 * The profile's stylesheet.
 *
 * Only validated values reach it: a hex that passed `normalizeHex`, a class
 * name from the effect catalogue, numbers, and a URL that passed
 * `safeProfileLink` — which is why the banner is the only URL in here, and it
 * is emitted inside `url("…")` with quotes and backslashes already impossible.
 *
 * @param {ReturnType<typeof profileView>} profile
 * @param {string} username only used in the header comment
 */
export function themeCss(profile, username = '') {
  const lines = [
    `/* MantisBin profile theme${username ? ` for @${String(username).replace(/[^A-Za-z0-9_]/g, '')}` : ''} — generated, do not edit. */`,
    '.profile-theme {',
    `  --accent: ${profile.accent};`,
    `  --accent-soft: ${profile.accentSoft};`,
    `  --accent-line: rgba(${hexChannels(profile.accent)}, 0.38);`,
    `  --name-speed: ${effectDuration(profile.effectSpeed)}s;`,
    `  --name-strength: ${effectStrength(profile.effectIntensity)};`,
    '}',
  ];
  if (profile.nameEffect !== 'none') {
    lines.push(
      `/* ${profile.nameEffect} uses the static .name-${profile.nameEffect} animation in app.css. */`,
    );
  }
  if (profile.bannerType === 'gradient' || profile.bannerUrl) {
    lines.push('.profile-banner {');
    lines.push(
      profile.bannerType === 'image' && profile.bannerUrl
        ? `  background-image: url("${profile.bannerUrl}");`
        : '  background-image: linear-gradient(120deg, var(--accent-soft), transparent 65%), linear-gradient(300deg, rgba(255, 255, 255, 0.08), transparent 60%);',
    );
    lines.push('}');
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/**
 * Auto-computed badges — VibeBin's set, minus the inline gradients (each id has
 * a static class in app.css). No manual awarding, no stored state: a badge
 * disappears by itself when the condition stops holding.
 *
 * @param {{
 *   profile: ReturnType<typeof profileView>,
 *   stats: { publicPastes?: number, views?: number, accountRank?: number | null },
 * }} input
 * @returns {Array<{ id: string, label: string, emoji: string, hint: string }>}
 */
export function badgesFor(input) {
  const profile = input.profile;
  const publicPastes = Math.max(0, Number(input.stats?.publicPastes ?? 0));
  const views = Math.max(0, Number(input.stats?.views ?? 0));
  const rank = input.stats?.accountRank;
  /** @type {Array<{ id: string, label: string, emoji: string, hint: string }>} */
  const badges = [];
  if (typeof rank === 'number' && rank >= 1 && rank <= 10) {
    badges.push({ id: 'og', label: 'OG member', emoji: '🏅', hint: `Among the first ten accounts on this instance (#${rank}).` });
  }
  if (publicPastes >= 10) {
    badges.push({ id: 'prolific', label: 'Prolific', emoji: '📚', hint: 'Ten or more public pastes.' });
  }
  if (views >= 500) {
    badges.push({ id: 'viral', label: 'Viral', emoji: '🔥', hint: 'Five hundred views on public pastes.' });
  }
  if (isCustomised(profile)) {
    badges.push({ id: 'stylist', label: 'Stylist', emoji: '✨', hint: 'Customised this profile.' });
  }
  return badges;
}

// ---------------------------------------------------------------------------
// Form input → stored values
// ---------------------------------------------------------------------------

/**
 * Validate a submitted customiser form. Returns the values to store plus a list
 * of human-readable errors; **nothing is stored when there are errors**, so a
 * half-saved profile is impossible.
 *
 * @param {Record<string, any>} form
 * @returns {{ errors: string[], values: any }}
 */
export function readProfileInput(form) {
  /** @type {string[]} */
  const errors = [];

  // A form carries at most one of each of these, so a repeat is either a bug or
  // an attempt to have two values interpreted as one field.
  const singles = ['display_name', 'bio', 'bio_enabled', 'accent', 'name_effect', 'effect_speed',
    'effect_intensity', 'banner_type', 'banner_url', 'status_emoji', 'status_text'];
  if (singles.some((key) => Array.isArray(form[key]))) {
    errors.push('That form sent one field more than once. Reload the page and try again.');
  }

  const displayNameRaw = String(form.display_name ?? '').trim();
  const displayName = cleanText(displayNameRaw, PROFILE_LIMITS.displayName);
  if (displayNameRaw && !displayName) errors.push('That display name has no visible characters.');

  const bioRaw = String(form.bio ?? '');
  const bio = cleanText(bioRaw, PROFILE_LIMITS.bio);
  if (bioRaw.trim().length > PROFILE_LIMITS.bio) {
    errors.push(`The bio can be at most ${PROFILE_LIMITS.bio} characters.`);
  }

  const statusEmojiRaw = String(form.status_emoji ?? '').trim();
  const statusEmoji = normalizeStatusEmoji(statusEmojiRaw);
  if (statusEmojiRaw && !statusEmoji) {
    errors.push(`A status can hold up to ${PROFILE_LIMITS.statusGraphemes} emoji (or one shortcode like :fire:).`);
  }

  const statusTextRaw = String(form.status_text ?? '');
  const statusText = cleanText(statusTextRaw, PROFILE_LIMITS.statusText);
  if (statusTextRaw.trim().length > PROFILE_LIMITS.statusText) {
    errors.push(`The status text can be at most ${PROFILE_LIMITS.statusText} characters.`);
  }

  const accentRaw = String(form.accent ?? '').trim();
  const accentPreset = normalizeAccentPreset(accentRaw);
  const accent = accentPreset ? ACCENT_BY_ID.get(accentPreset).hex : normalizeHex(accentRaw, ACCENT_DEFAULT);

  const nameEffect = String(form.name_effect ?? 'none').trim();
  if (!NAME_EFFECT_IDS.has(nameEffect)) errors.push('Pick a name effect from the list.');

  const bannerTypeRaw = String(form.banner_type ?? 'image').trim();
  const bannerType = BANNER_TYPE_IDS.has(bannerTypeRaw) ? bannerTypeRaw : 'image';
  const bannerRaw = String(form.banner_url ?? '').trim();
  let bannerUrl = '';
  if (bannerRaw) {
    bannerUrl = safeProfileLink(bannerRaw) ?? '';
    if (!bannerUrl) errors.push('The banner must be an https image URL.');
  }

  const links = parseProfileLinks(linksFromForm(form));
  const submittedLinks = (Array.isArray(form.link_url) ? form.link_url : form.link_url ? [form.link_url] : []).filter(
    (url) => String(url ?? '').trim(),
  );
  if (submittedLinks.length > PROFILE_LIMITS.links) {
    errors.push(`A profile can show at most ${PROFILE_LIMITS.links} links.`);
  }
  if (submittedLinks.length !== links.length) {
    errors.push('Every link must be a unique https URL (a bare host such as github.com/you is fine).');
  }

  return {
    errors,
    values: {
      displayName: displayName || '',
      bio,
      bioEnabled: form.bio_enabled === undefined ? true : Boolean(form.bio_enabled),
      accent,
      nameEffect,
      effectSpeed: normalizeEffectValue(form.effect_speed, 50),
      effectIntensity: normalizeEffectValue(form.effect_intensity, 60),
      bannerType: bannerUrl ? bannerType : bannerType === 'gradient' ? 'gradient' : 'image',
      bannerUrl,
      statusEmoji,
      statusText,
      links,
    },
  };
}

/** Tag colour: an id from the palette; a legacy hex maps to the nearest preset. */
export function normalizeTagColor(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (TAG_COLOR_IDS.has(raw)) return raw;
  const byHex = ACCENT_PRESETS.find((preset) => preset.hex === normalizeHex(raw, ''));
  return byHex ? byHex.id : 'violet';
}

/** Tag id from a label — stable, so re-awarding the same tag reuses the row. */
export function tagIdFromLabel(label) {
  const slug = String(label ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || '';
}
