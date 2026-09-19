/**
 * Small, deliberately conservative language detector.
 *
 * Detection is a convenience for new pastes, not a parser. It only looks at a
 * bounded prefix, never executes or imports anything from the paste, and falls
 * back to plaintext whenever two formats look similarly plausible. The 256 KiB
 * viewer fast path is also the detector's upper bound: very large pastes stay
 * on the cheap plaintext renderer.
 */

import {
  AUTO_LANGUAGE,
  DEFAULT_LANGUAGE,
  FILENAME_EXACT_NAMES,
  FILENAME_EXTENSIONS,
  LANGUAGE_DETECT_MAX_BYTES,
  LANGUAGES,
  LIMITS,
} from '../config.js';

const encoder = new TextEncoder();
const MAX_LINES = 4096;

/** Stored ids, for validating the filename maps (defence in depth). */
const KNOWN_LANGUAGES = new Set(LANGUAGES.map((lang) => lang.id));

/** A plausible file extension: short, alphanumeric, no spaces or punctuation. */
const EXTENSION_RE = /^[a-z0-9]{1,10}$/;

/**
 * @param {string} value
 * @returns {{ sample: string, truncated: boolean }}
 */
function boundedPrefix(value) {
  const text = String(value || '');
  // Avoid encoding the whole paste. A 64 KiB UTF-16 prefix is the only input
  // this module ever turns into bytes or feeds to a regular expression.
  let candidate = text.slice(0, LANGUAGE_DETECT_MAX_BYTES);
  let bytes = encoder.encode(candidate);
  if (bytes.length > LANGUAGE_DETECT_MAX_BYTES) {
    // A binary search trims a multibyte prefix without an O(n²) character loop.
    let low = 0;
    let high = candidate.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encoder.encode(candidate.slice(0, middle)).length <= LANGUAGE_DETECT_MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    candidate = candidate.slice(0, low);
    bytes = encoder.encode(candidate);
  }
  return { sample: candidate, truncated: candidate.length < text.length || bytes.length < encoder.encode(text.slice(0, candidate.length)).length };
}

/** Count bounded line matches without using a global regex over the full paste. */
function countLines(lines, pattern) {
  let count = 0;
  for (const line of lines) if (pattern.test(line)) count++;
  return count;
}

/**
 * Read a stored language id from a paste title treated as a filename:
 * `app.py` → `python`, `Dockerfile` → `dockerfile`, `.bashrc` → `bash`.
 * Returns `null` when the title has no recognised name or extension, so the
 * caller falls through to content detection. Pure and total: any input,
 * including titles with spaces or multiple dots, yields an id or `null`.
 * @param {unknown} title
 * @returns {string | null}
 */
export function languageFromFilename(title) {
  if (typeof title !== 'string') return null;
  // Titles are single-line, but callers pass raw form input too: take the
  // basename in case anything ever carries a path.
  const base = title.split(/[\\/]/).pop()?.trim() || '';
  if (!base || base.length > 260) return null;
  const lowered = base.toLowerCase();

  const exact = FILENAME_EXACT_NAMES[lowered.replace(/^\.+/, '')];
  if (exact && KNOWN_LANGUAGES.has(exact)) return exact;

  const dot = lowered.lastIndexOf('.');
  // A leading dot (`.bashrc`) or a trailing dot (`notes.`) is not an extension.
  if (dot <= 0 || dot === lowered.length - 1) return null;
  const ext = lowered.slice(dot + 1);
  if (!EXTENSION_RE.test(ext)) return null;
  const mapped = FILENAME_EXTENSIONS[ext];
  return mapped && KNOWN_LANGUAGES.has(mapped) ? mapped : null;
}

/**
 * The display extension of a filename (`app.py` → `.py`), or `''` when the
 * title has none. Used for the file badge on the paste view.
 * @param {unknown} title
 * @returns {string}
 */
export function filenameExtension(title) {
  if (typeof title !== 'string') return '';
  const base = title.split(/[\\/]/).pop()?.trim() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1);
  return EXTENSION_RE.test(ext.toLowerCase()) ? `.${ext.toLowerCase()}` : '';
}

/**
 * Resolve a normalised language choice to a stored language id.
 * Resolution order for `auto`: an explicit selection always wins; otherwise
 * the filename extension wins over content fingerprints, and anything
 * ambiguous or very large stays `plaintext`. This is the single call site
 * behind the web form and every API create/update path.
 * @param {string} choice normalised via `normalizeLanguageChoice`
 * @param {unknown} title paste title (read as a filename)
 * @param {unknown} content paste content
 * @param {number} [byteCount] already-known UTF-8 size
 * @returns {string}
 */
export function resolvePasteLanguage(choice, title, content, byteCount) {
  if (choice !== AUTO_LANGUAGE) return choice;
  return languageFromFilename(title) || detectLanguage(content, byteCount);
}

/**
 * Resolve an `auto` choice to one of the stored language ids.
 * @param {unknown} value paste content
 * @param {number} [byteCount] already-known UTF-8 size
 * @returns {string}
 */
export function detectLanguage(value, byteCount) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return DEFAULT_LANGUAGE;
  // Reuse the existing viewer rule: a huge paste takes the fast plaintext path.
  // Callers that already validated the content pass its byte count so this does
  // not need to encode a multi-megabyte string just to reject it.
  if (Number.isFinite(byteCount) ? Number(byteCount) > LIMITS.highlightMaxBytes : text.length > LIMITS.highlightMaxBytes) {
    return DEFAULT_LANGUAGE;
  }

  const { sample, truncated } = boundedPrefix(text);
  const trimmed = sample.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return DEFAULT_LANGUAGE;
  const lines = sample.split('\n').slice(0, MAX_LINES);

  // These are high-confidence and cheap. JSON.parse only sees a complete,
  // capped document; an incomplete prefix is never reparsed repeatedly.
  if (!truncated && /^[\[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') return 'json';
    } catch {
      // A brace is not enough to call arbitrary text JSON.
    }
  }

  const diffLines = countLines(lines, /^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|(?:---|\+\+\+) |@@ .+ @@)/);
  if (/^diff --git /m.test(sample) || (diffLines >= 2 && countLines(lines, /^[-+]{3} /) >= 2)) return 'diff';

  const firstLine = lines.find((line) => line.trim() !== '')?.trim() || '';
  if (/^(?:#!.*\b(?:bash|sh|zsh|fish)\b|#!\/bin\/(?:ba)?sh\b)/i.test(firstLine)) return 'bash';
  if (/^#!.*\bpython(?:\d+(?:\.\d+)?)?\b/i.test(firstLine)) return 'python';
  if (/^#!.*\bruby\b/i.test(firstLine)) return 'ruby';
  if (/^#!.*\b(?:node|deno|bun)\b/i.test(firstLine)) return 'javascript';

  // Unambiguous document wrappers beat programming-language fingerprints.
  if (
    /^<!doctype\s+html\b/i.test(trimmed) ||
    /<html(?:\s|>)/i.test(trimmed) ||
    /<(?:head|body|div|span|p|a|ul|ol|li|table|section|article|script|style)(?:\s|>)/i.test(trimmed)
  ) return 'html';
  if (/^<\?xml\b/i.test(trimmed) || (/<[A-Za-z][\w:.-]*(?:\s[^<>]{0,120})?>/.test(trimmed) && /<\/[A-Za-z][\w:.-]*\s*>/.test(trimmed))) return 'xml';

  // Dockerfiles and Makefiles have distinctive line-oriented markers.
  if (countLines(lines, /^(?:FROM|RUN|CMD|ENTRYPOINT|COPY|ADD|WORKDIR|ARG|ENV)\s+/i) >= 2 || /^FROM\s+[^\s]+/i.test(firstLine)) return 'dockerfile';
  if (countLines(lines, /^(?:[A-Za-z0-9_.-]+\s*:\s*(?:[^=]|$)|[A-Z_][A-Z0-9_]*\s*:?=)/) >= 2 && countLines(lines, /^\t/) >= 1) return 'makefile';

  // Markdown needs more than a single leading #, otherwise a sentence such as
  // "#3 was the answer" would be needlessly highlighted.
  const markdownMarkers =
    countLines(lines, /^#{1,6}\s+/) +
    countLines(lines, /^(?:```|~~~)/) +
    countLines(lines, /^(?:[-*+]\s+|>\s+)/) +
    (/[[][^\]\n]{1,120}\]\([^\s)]+\)/.test(sample) ? 1 : 0);
  if (
    markdownMarkers >= 2 ||
    countLines(lines, /^#{1,6}\s+/) >= 2 ||
    (countLines(lines, /^#{1,6}\s+/) === 1 && lines.length >= 3 && lines[1].trim() === '')
  ) return 'markdown';

  // YAML and INI/TOML are line-oriented too. Require multiple structural
  // markers so a single colon in prose remains plaintext.
  const yamlKeys = countLines(lines, /^\s*[A-Za-z_][\w.-]*\s*:\s*(?:[^#].*)?$/);
  const yamlList = countLines(lines, /^\s*-\s+\S/);
  if (yamlKeys >= 2 || (yamlKeys >= 1 && yamlList >= 1) || (/^---\s*$/.test(firstLine) && yamlKeys >= 1)) return 'yaml';
  if (countLines(lines, /^\s*\[[^\]]+\]\s*$/) >= 1 && countLines(lines, /^\s*[A-Za-z_][\w.-]*\s*=\s*\S/) >= 1) return 'ini';

  /** @type {Map<string, number>} */
  const scores = new Map();
  const add = (id, amount) => scores.set(id, (scores.get(id) || 0) + amount);

  // Shell: a command-shaped line is enough for a useful answer, while prose
  // only wins when it also contains shell expansion/operators.
  if (countLines(lines, /^\s*(?:export|unset|set\s+-[eux]+|source|printf|echo|cd|chmod|curl|wget)\b/) >= 1) add('bash', 3);
  if (/[|&]{1,2}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(sample)) add('bash', 1);
  if (countLines(lines, /^\s*if\s+.+;\s*then\s*$/) >= 1 || countLines(lines, /^\s*(?:fi|done)\s*$/) >= 1) add('bash', 2);

  // Python.
  if (countLines(lines, /^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/) >= 1) add('python', 3);
  if (countLines(lines, /^\s*(?:from\s+\S+\s+import|import\s+[A-Za-z_][\w.]*)\b/) >= 1) add('python', 2);
  if (/if\s+__name__\s*==\s*["']__main__["']/.test(sample)) add('python', 2);
  if (/\b(?:print|len|range)\s*\(/.test(sample)) add('python', 2);

  // JavaScript / TypeScript. TypeScript-specific declarations get a head start;
  // a type annotation beats the otherwise identical JavaScript declaration.
  if (countLines(lines, /^\s*(?:interface|type)\s+[A-Za-z_$][\w$]*/) >= 1) add('typescript', 4);
  if (/\b(?:interface|type\s+[A-Za-z_$][\w$]*\s*=|enum)\b/.test(sample)) add('typescript', 2);
  if (/:\s*(?:string|number|boolean|unknown|void|never|[A-Z][A-Za-z_$][\w$]*)\b/.test(sample) || /\bas\s+const\b/.test(sample)) add('typescript', 3);
  if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(sample)) add('javascript', 2);
  if (/\bfunction\s+[A-Za-z_$][\w$]*\s*\(/.test(sample)) add('javascript', 3);
  if (/\b(?:console\.(?:log|error)|require|import\s+.+\s+from|export\s+(?:default\s+)?|await\s+)\b/.test(sample) || /=>/.test(sample)) add('javascript', 2);

  // SQL statements are deliberately anchored at the beginning of a line.
  if (countLines(lines, /^\s*(?:SELECT|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW)|ALTER\s+TABLE|WITH\s+\w+\s+AS)\b/i) >= 1) add('sql', 4);
  if (countLines(lines, /^\s*(?:FROM|WHERE|GROUP BY|ORDER BY|JOIN|VALUES)\b/i) >= 2) add('sql', 2);

  // The remaining fingerprints are intentionally small and independent.
  if (/\b(?:using\s+System|namespace\s+\w+|Console\.WriteLine|public\s+class)\b/.test(sample)) add('csharp', 4);
  if (/\b(?:package\s+main|func\s+main\s*\(|fmt\.|:=)\b/.test(sample)) add('go', 4);
  if (/\b(?:fn\s+main\s*\(|use\s+std::|let\s+mut|println!\s*\()/.test(sample)) add('rust', 4);
  if (/\b(?:fun\s+main\s*\(|println!\s*\(|val\s+\w+\s*=|var\s+\w+\s*=)/.test(sample)) add('kotlin', 3);
  if (/\b(?:import\s+Foundation|struct\s+\w+\s*:\s*|guard\s+let|let\s+\w+\s*=|var\s+\w+\s*=)/.test(sample)) add('swift', 3);
  if (/\b(?:public\s+class|static\s+void\s+main|System\.out\.|package\s+[\w.]+;)/.test(sample)) add('java', 4);
  if (/<\?php\b/.test(sample)) add('php', 4);
  if (/\$[A-Za-z_]\w*\s*=|\brequire_once\s+/.test(sample)) add('php', 3);
  if (/\b(?:def\s+\w+\s*\([^)]*\)|puts\s+|require\s+["']|end\s*$)/m.test(sample)) add('ruby', 3);
  if (/\b(?:local\s+\w+\s*=|function\s+\w+\s*\(|then\s*$|end\s*$)/m.test(sample) && /\b(?:local|nil|lua)\b/.test(sample)) add('lua', 3);
  if (/#include\s*<[^>]+>|\bstd::|\b(?:printf|scanf)\s*\(/.test(sample)) add(/\bstd::|#include\s*<iostream>|\bcout\b/.test(sample) ? 'cpp' : 'c', 4);

  // CSS requires a declaration-shaped block; braces alone are too common in JS.
  if (/(?:^|[;}\n])\s*(?:[.#][\w-]+|[a-z][\w-]*)\s*\{[^{}]{0,500}:[^{};]{1,120}(?:;|\})/i.test(sample) || /@(?:media|supports|keyframes)\b/.test(sample)) add('css', 4);

  let best = DEFAULT_LANGUAGE;
  let bestScore = 0;
  let secondScore = 0;
  for (const [id, score] of scores) {
    if (score > bestScore) {
      secondScore = bestScore;
      best = id;
      bestScore = score;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  // A single weak fingerprint, or a tie between plausible languages, is not a
  // useful automatic answer. Plaintext is the safe and deterministic fallback.
  if (bestScore < 3 || bestScore - secondScore < 1) return DEFAULT_LANGUAGE;
  return best;
}
