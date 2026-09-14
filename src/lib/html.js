/**
 * Tiny XSS-safe HTML templating.
 *
 * `html` is a tagged template: every interpolated value is escaped unless it is
 * itself a `SafeHtml` fragment (produced by `html`/`raw`) or an array of them.
 * Views are plain functions returning `SafeHtml`, so there is exactly one way to
 * produce markup and no way to accidentally inject user data.
 */

/** Marker class for strings that are already safe to embed. */
export class SafeHtml {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escape a value for use in HTML text or in a double-quoted attribute. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str.replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]);
}

/**
 * Mark a string as trusted markup. Only for literals assembled in this repo
 * (never for user input).
 * @param {string} value
 */
export function raw(value) {
  return new SafeHtml(value);
}

/**
 * @param {TemplateStringsArray} strings
 * @param {any[]} values
 * @returns {SafeHtml}
 */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return new SafeHtml(out);
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) {
    let out = '';
    for (const item of value) out += renderValue(item);
    return out;
  }
  return esc(value);
}

/** Join fragments without introducing escaping (useful for lists of nodes). */
export function joinFragments(fragments, separator = '') {
  return new SafeHtml(fragments.map((f) => renderValue(f)).join(separator));
}
