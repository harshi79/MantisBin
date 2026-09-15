/**
 * Dependency-free syntax highlighting.
 *
 * Runs on the server (Workers + Node) so paste pages ship fully rendered HTML:
 * no client JS, no highlight.js download, no flash of unstyled code.
 *
 * Three scanners cover everything:
 *   generic  — token scanner driven by a small per-language spec
 *   markup   — HTML/XML
 *   line     — line-oriented formats (diff, markdown)
 *
 * All output is escaped as it is produced; user content is never inserted raw.
 */

const CACHE = new Map();

/** @typedef {{ id: string, label: string }} LanguageOption */

/**
 * @typedef {object} LangSpec
 * @property {string} [mode]
 * @property {string[]} [lineComment]
 * @property {Array<[string, string]>} [blockComment]
 * @property {string[]} [quotes]
 * @property {string} [keywords]
 * @property {string} [literals]
 * @property {string} [builtins]
 * @property {boolean} [capitalTypes]
 * @property {boolean} [caseInsensitiveKeywords]
 * @property {boolean} [colonKeys]
 * @property {boolean} [assignKeys]
 * @property {boolean} [dollarVars]
 * @property {boolean} [atWords]
 * @property {boolean} [symbols]
 * @property {boolean} [tripleQuotes]
 */

/** @type {LangSpec} */
const C_LIKE = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  quotes: ['"', "'"],
};

/** @type {Record<string, LangSpec>} */
const LANGS = {
  plaintext: { mode: 'none' },

  javascript: {
    ...C_LIKE,
    quotes: ['"', "'", '`'],
    dollarVars: true,
    keywords:
      'async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch this throw try typeof var void while with yield',
    literals: 'true false null undefined NaN Infinity',
    builtins:
      'Array ArrayBuffer Boolean BigInt JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet Date Error console document fetch globalThis process require window setTimeout setInterval clearTimeout clearInterval',
  },
  typescript: {
    ...C_LIKE,
    quotes: ['"', "'", '`'],
    dollarVars: true,
    keywords:
      'abstract as async await break case catch class const constructor continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace new of override package private protected public readonly return satisfies set static super switch this throw type typeof var void while with yield',
    literals: 'true false null undefined NaN Infinity',
    builtins:
      'Array ArrayBuffer Boolean BigInt JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol Record Partial Required Pick Omit ReturnType Awaited console document fetch globalThis process window',
    capitalTypes: true,
  },
  json: {
    quotes: ['"'],
    colonKeys: true,
    literals: 'true false null',
    mode: 'json',
  },
  css: {
    blockComment: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords:
      'media supports import keyframes font-face charset namespace page property layer container scope starting-style view-transition',
    builtins:
      'inherit initial unset revert none auto block inline flex grid absolute relative fixed sticky solid hidden visible scroll important root',
    colonKeys: true,
  },
  html: { mode: 'markup' },
  xml: { mode: 'markup' },

  bash: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    dollarVars: true,
    keywords:
      'if then else elif fi for while until do done case esac function in return exit break continue select time coproc local export readonly declare typeset shift source alias unalias trap eval exec set unset',
    builtins:
      'echo printf cd pwd ls cat grep sed awk curl wget git docker npm node python python3 pip ruby go make sudo chmod chown mkdir rm cp mv tar ssh scp find xargs sort uniq head tail cut tr tee kill ps top env true false test read wait',
  },
  dockerfile: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    dollarVars: true,
    keywords:
      'FROM AS RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL',
    caseInsensitiveKeywords: false,
  },
  makefile: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    assignKeys: true,
    dollarVars: true,
    keywords:
      'ifeq ifneq ifdef ifndef else endif define endef include export unexport override vpath .PHONY .DEFAULT .SUFFIXES',
    builtins: 'all clean install test build',
  },
  ini: {
    lineComment: ['#', ';'],
    quotes: ['"', "'"],
    assignKeys: true,
    colonKeys: true,
    literals: 'true false yes no on off null',
    mode: 'ini',
  },
  yaml: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    colonKeys: true,
    literals: 'true false null yes no on off',
    builtins: 'env secret',
    mode: 'yaml',
  },
  markdown: { mode: 'markdown' },
  diff: { mode: 'diff' },

  python: {
    lineComment: ['#'],
    quotes: ['"""', "'''", '"', "'"],
    atWords: true,
    keywords:
      'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
    literals: 'True False None',
    builtins:
      'abs all any bool bytes callable chr dict dir divmod enumerate eval filter float format frozenset getattr hasattr hash hex id input int isinstance issubclass iter len list map max min next object oct open ord pow print range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip self cls Exception ValueError TypeError KeyError RuntimeError OSError',
  },
  ruby: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    dollarVars: true,
    symbols: true,
    keywords:
      'alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return then undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer include extend',
    literals: 'true false nil self',
    builtins:
      'puts print p pp Array Hash String Symbol Integer Float Range Proc Lambda Object Class Module Kernel Comparable Enumerable Exception StandardError raise fail loop lambda proc rand format sleep',
  },
  lua: {
    lineComment: ['--'],
    blockComment: [['--[[', ']]']],
    quotes: ['"', "'"],
    keywords:
      'and break do else elseif end for function goto if in local not or repeat return then until while',
    literals: 'true false nil',
    builtins:
      'assert collectgarbage dofile error getmetatable ipairs load next pairs pcall print rawget rawset require select setmetatable tonumber tostring type unpack string table math io os coroutine package debug',
  },
  php: {
    lineComment: ['//', '#'],
    blockComment: [['/*', '*/']],
    quotes: ['"', "'"],
    dollarVars: true,
    capitalTypes: true,
    keywords:
      'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield',
    literals: 'true false null TRUE FALSE NULL',
    builtins: 'strlen strpos substr count array_map array_filter implode explode isset print_r var_dump json_encode json_decode',
  },

  c: {
    ...C_LIKE,
    capitalTypes: true,
    keywords:
      'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool _Alignas _Alignof _Atomic _Noreturn _Static_assert',
    literals: 'true false NULL',
    builtins:
      'printf scanf malloc calloc realloc free memcpy memmove memset strlen strcmp strcpy strcat fopen fclose fread fwrite fprintf fseek exit abort assert sizeof',
  },
  cpp: {
    ...C_LIKE,
    capitalTypes: true,
    keywords:
      'alignas alignof and asm auto bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor',
    literals: 'true false nullptr NULL',
    builtins:
      'std string vector map unordered_map set array list queue stack pair shared_ptr unique_ptr weak_ptr cout cin cerr endl printf malloc free memcpy sizeof move forward make_shared make_unique',
  },
  csharp: {
    ...C_LIKE,
    capitalTypes: true,
    keywords:
      'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in init int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield record get set value',
    literals: 'true false null',
    builtins:
      'Console String Math List Dictionary Task IEnumerable Exception Object Convert Enumerable Linq System Threading Collections',
  },
  java: {
    ...C_LIKE,
    capitalTypes: true,
    atWords: true,
    keywords:
      'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while yield record sealed permits non-sealed',
    literals: 'true false null',
    builtins:
      'String Integer Long Double Boolean Character Object System Math List ArrayList Map HashMap Set HashSet Optional Stream Collectors Thread Runnable Exception RuntimeException StringBuilder Arrays Collections Comparable Iterable Override',
  },
  kotlin: {
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: ['"', "'"],
    capitalTypes: true,
    atWords: true,
    keywords:
      'abstract actual annotation as break by catch class companion const constructor continue crossinline data do else enum expect external final finally for fun get if import in infix init inline interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend this throw try typealias val var vararg when where while',
    literals: 'true false null',
    builtins:
      'String Int Long Double Float Boolean Char Any Unit List MutableList Map MutableMap Set Array println require check listOf mapOf setOf arrayOf arrayOfNulls lazy sequenceOf CoroutineScope',
  },
  swift: {
    ...C_LIKE,
    capitalTypes: true,
    atWords: true,
    keywords:
      'actor associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in init inout internal is lazy let mutating open operator private protocol public repeat required rethrows return self set some static struct subscript super switch throw throws try typealias var weak where while',
    literals: 'true false nil',
    builtins:
      'String Int Double Float Bool Array Dictionary Set Optional Result Error UIView UIViewController Any AnyObject Void print fatalError assert precondition debugPrint',
  },
  go: {
    ...C_LIKE,
    quotes: ['"', "'", '`'],
    capitalTypes: true,
    keywords:
      'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
    literals: 'true false nil iota',
    builtins:
      'append bool byte cap clear close complex copy delete error float32 float64 int int8 int16 int32 int64 len make max min new panic print println real recover rune string uint uint8 uint16 uint32 uint64 uintptr any comparable fmt os strings strconv errors context sync time net http log json',
  },
  rust: {
    ...C_LIKE,
    capitalTypes: true,
    atWords: true,
    keywords:
      'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while union',
    literals: 'true false None Some Ok Err',
    builtins:
      'String str Vec Box Rc Arc Cell RefCell HashMap BTreeMap HashSet Option Result Ok Err println print eprintln format vec panic assert assert_eq debug_assert todo unimplemented unwrap expect iter Into From TryInto Default Clone Copy Debug Display PartialEq Eq Hash Ord PartialOrd Send Sync Sized ToString',
  },
  sql: {
    lineComment: ['--'],
    blockComment: [['/*', '*/']],
    quotes: ["'"],
    caseInsensitiveKeywords: true,
    keywords:
      'select from where insert into values update set delete create table alter drop index view database schema primary key foreign references unique check default not null and or in is like between join inner left right full outer cross on group by order having limit offset union all distinct as case when then else end count sum avg min max cast coalesce exists begin commit rollback transaction with recursive returning constraint autoincrement if',
      literals: 'true false null',
    builtins: 'int integer text varchar char blob real numeric decimal date datetime timestamp boolean',
  },
};

/** Alias lookup so callers can pass a few common alternative names. */
const ALIASES = {
  js: 'javascript',
  mjs: 'javascript',
  jsx: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  toml: 'ini',
  conf: 'ini',
  patch: 'diff',
  udiff: 'diff',
  vue: 'html',
  svelte: 'html',
  'c++': 'cpp',
  golang: 'go',
  rs: 'rust',
  'c#': 'csharp',
  cs: 'csharp',
  docker: 'dockerfile',
  txt: 'plaintext',
  text: 'plaintext',
  none: 'plaintext',
};

/** Resolve any user-supplied language id to a known one. */
export function resolveLanguage(value) {
  const id = String(value || '')
    .trim()
    .toLowerCase();
  if (!id) return 'plaintext';
  const aliased = ALIASES[id] || id;
  return Object.hasOwn(LANGS, aliased) ? aliased : 'plaintext';
}

function getSpec(languageId) {
  const cached = CACHE.get(languageId);
  if (cached) return cached;
  const spec = LANGS[languageId] || LANGS.plaintext;
  const prepared = {
    ...spec,
    kw: new Set(splitWords(spec.keywords)),
    lit: new Set(splitWords(spec.literals)),
    bi: new Set(splitWords(spec.builtins)),
    lineComment: spec.lineComment || [],
    blockComment: spec.blockComment || [],
    quotes: spec.quotes || [],
  };
  CACHE.set(languageId, prepared);
  return prepared;
}

function splitWords(text) {
  if (!text) return [];
  return String(text).split(/[\s,]+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Escaping + linkify
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape raw text (never returns anything that can break out of an element). */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

const URL_RE = /(?:https?:\/\/)[^\s<>"'`[\]{}|\\^]+/g;

/**
 * Escape text and turn http(s) URLs into links.
 * Operates on raw text so entity escaping cannot corrupt a URL.
 */
export function escapeWithLinks(text) {
  const source = String(text);
  if (!source.includes('://')) return escapeHtml(source);
  let out = '';
  let last = 0;
  URL_RE.lastIndex = 0;
  let match;
  while ((match = URL_RE.exec(source)) !== null) {
    const url = trimUrl(match[0]);
    if (!url) continue;
    const start = match.index;
    out += escapeHtml(source.slice(last, start));
    out += anchor(url);
    last = start + url.length;
    URL_RE.lastIndex = last;
  }
  out += escapeHtml(source.slice(last));
  return out;
}

function trimUrl(url) {
  let value = url;
  // Drop trailing sentence punctuation.
  value = value.replace(/[.,;:!?'"*_]+$/, '');
  // Drop trailing closers without a matching opener.
  for (let i = 0; i < 3 && value.length > 0; i++) {
    const lastChar = value[value.length - 1];
    if (lastChar === ')' || lastChar === ']' || lastChar === '}') {
      const opener = lastChar === ')' ? '(' : lastChar === ']' ? '[' : '{';
      const opens = (value.match(new RegExp(`\\${opener}`, 'g')) || []).length;
      const closes = (value.match(new RegExp(`\\${lastChar}`, 'g')) || []).length;
      if (closes > opens) value = value.slice(0, -1);
      else break;
    } else break;
  }
  if (!/^https?:\/\/[^\s]+$/i.test(value)) return '';
  return value;
}

function anchor(url) {
  const safe = escapeHtml(url);
  return `<a href="${safe}" rel="noopener noreferrer nofollow" target="_blank">${safe}</a>`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render paste content as safe HTML.
 * @param {string} content
 * @param {string} languageId
 * @param {{ linkify?: boolean }} [options]
 * @returns {string} escaped HTML
 */
export function renderCode(content, languageId, options = {}) {
  const linkify = options.linkify !== false;
  const language = resolveLanguage(languageId);
  const spec = getSpec(language);
  switch (spec.mode) {
    case 'none':
      return linkify ? escapeWithLinks(content) : escapeHtml(content);
    case 'markup':
      return renderMarkup(content, linkify);
    case 'diff':
      return renderDiff(content, linkify);
    case 'markdown':
      return renderMarkdown(content, linkify);
    default:
      return renderGeneric(content, spec, language, linkify);
  }
}

/**
 * Add lightweight, safe line wrappers around already-rendered highlighter HTML.
 *
 * The highlighter can emit a token span that crosses a newline (for example a
 * multiline comment). This helper closes and reopens those generated tags at
 * each line boundary, so every line can have its own stable anchor without
 * breaking the token markup. It only receives HTML produced by this module.
 *
 * @param {string} renderedHtml
 * @returns {string}
 */
export function addLineAnchors(renderedHtml) {
  const tokens = String(renderedHtml).split(/(<\/?[a-z][^>]*>)/gi);
  const openTags = [];
  let line = 1;
  let out = openLine(line);

  for (const token of tokens) {
    if (!token) continue;
    if (token[0] === '<') {
      const closing = /^<\/([a-z][a-z0-9]*)\s*>$/i.exec(token);
      if (closing) {
        out += token;
        if (openTags.length) openTags.pop();
        continue;
      }

      const opening = /^<([a-z][a-z0-9]*)\b[^>]*>$/i.exec(token);
      if (opening) {
        out += token;
        if (!/\/\s*>$/.test(token)) openTags.push({ name: opening[1], tag: token });
        continue;
      }

      // This is defensive: current renderers only emit span and a tags.
      out += token;
      continue;
    }

    const parts = token.split('\n');
    for (let index = 0; index < parts.length; index++) {
      out += parts[index];
      if (index === parts.length - 1) continue;

      for (let tagIndex = openTags.length - 1; tagIndex >= 0; tagIndex--) {
        out += `</${openTags[tagIndex].name}>`;
      }
      out += '</span></span>';
      line += 1;
      out += openLine(line);
      for (const tag of openTags) out += tag.tag;
    }
  }

  for (let tagIndex = openTags.length - 1; tagIndex >= 0; tagIndex--) {
    out += `</${openTags[tagIndex].name}>`;
  }
  return out + '</span></span>';
}

function openLine(line) {
  return `<span class="code-line" id="line-${line}" data-line="${line}"><a class="line-number" href="#line-${line}" aria-label="Line ${line}">${line}</a><span class="line-content">`;
}

// ---------------------------------------------------------------------------
// Generic token scanner
// ---------------------------------------------------------------------------

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER_RE =
  /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.?\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y;
const SPACE_RE = /\s+/y;

/** Characters that are operators/punctuation. Quotes are NOT included: they
 *  start string tokens, so a punctuation run must never swallow them. */
const PUNCT_CHARS = new Set('!#$%&()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function renderGeneric(content, spec, language, linkify) {
  const source = String(content);
  const len = source.length;
  let out = '';

  // One pending buffer with a class: plain text (null) or punctuation ('pun').
  let pending = '';
  let pendingClass = null;

  const flushPending = () => {
    if (!pending) return;
    if (pendingClass === 'pun') out += `<span class="t-pun">${escapeHtml(pending)}</span>`;
    else out += linkify ? escapeWithLinks(pending) : escapeHtml(pending);
    pending = '';
    pendingClass = null;
  };
  const push = (text, cls) => {
    if (pendingClass !== cls) flushPending();
    pending += text;
    pendingClass = cls;
  };
  const token = (cls, text) => {
    flushPending();
    out += `<span class="t-${cls}">${linkify ? escapeWithLinks(text) : escapeHtml(text)}</span>`;
  };

  let i = 0;
  while (i < len) {
    const ch = source[i];

    // Whitespace
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      SPACE_RE.lastIndex = i;
      const match = SPACE_RE.exec(source);
      push(match ? match[0] : ch, null);
      i += match ? match[0].length : 1;
      continue;
    }

    // Line comment
    let matched = false;
    for (const prefix of spec.lineComment) {
      if (source.startsWith(prefix, i)) {
        let end = source.indexOf('\n', i);
        if (end === -1) end = len;
        token('com', source.slice(i, end));
        i = end;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Block comment
    for (const [open, close] of spec.blockComment) {
      if (source.startsWith(open, i)) {
        const closeIdx = source.indexOf(close, i + open.length);
        const end = closeIdx === -1 ? len : closeIdx + close.length;
        token('com', source.slice(i, end));
        i = end;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Strings (quotes are ordered longest-first so """ beats ")
    const quotes = spec.quotes;
    for (let q = 0; q < quotes.length; q++) {
      const quote = quotes[q];
      if (!source.startsWith(quote, i)) continue;
      const end = scanString(source, i, quote);
      const text = source.slice(i, end);
      const cls = spec.mode === 'json' && nextNonSpaceIs(source, end, ':') ? 'key' : 'str';
      token(cls, text);
      i = end;
      matched = true;
      break;
    }
    if (matched) continue;

    // $variables
    if (spec.dollarVars && ch === '$' && /[A-Za-z_{(]/.test(source[i + 1] || '')) {
      let end = i + 1;
      if (source[end] === '{') {
        const close = source.indexOf('}', end);
        end = close === -1 ? len : close + 1;
      } else if (source[end] === '(') {
        const close = source.indexOf(')', end);
        end = close === -1 ? len : close + 1;
      } else {
        IDENT_RE.lastIndex = end;
        const match = IDENT_RE.exec(source);
        if (match) end = IDENT_RE.lastIndex;
      }
      token('var', source.slice(i, end));
      i = end;
      continue;
    }

    // Ruby symbols
    if (spec.symbols && ch === ':' && /[A-Za-z_]/.test(source[i + 1] || '')) {
      IDENT_RE.lastIndex = i + 1;
      const match = IDENT_RE.exec(source);
      if (match) {
        token('lit', source.slice(i, IDENT_RE.lastIndex));
        i = IDENT_RE.lastIndex;
        continue;
      }
    }

    // @annotations / @rules / decorators
    if (ch === '@') {
      IDENT_RE.lastIndex = i + 1;
      const match = IDENT_RE.exec(source);
      if (match) {
        const word = match[0];
        const atEnd = IDENT_RE.lastIndex;
        if (spec.atWords) {
          token('fn', source.slice(i, atEnd));
          i = atEnd;
          continue;
        }
        if (language === 'css' && spec.kw.has(word)) {
          token('kw', source.slice(i, atEnd));
          i = atEnd;
          continue;
        }
      }
    }

    // Numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      NUMBER_RE.lastIndex = i;
      const match = NUMBER_RE.exec(source);
      if (match && match[0].length > 0) {
        token('num', match[0]);
        i += match[0].length;
        continue;
      }
    }

    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      IDENT_RE.lastIndex = i;
      const match = IDENT_RE.exec(source);
      if (match) {
        const word = match[0];
        const end = IDENT_RE.lastIndex;
        const key = spec.caseInsensitiveKeywords ? word.toLowerCase() : word;
        let cls = null;
        if (spec.kw.has(key)) cls = 'kw';
        else if (spec.lit.has(key) || spec.lit.has(word)) cls = 'lit';
        else if (spec.bi.has(word) || spec.bi.has(key)) cls = 'typ';
        else if ((spec.colonKeys || spec.assignKeys) && nextNonSpaceIs(source, end, ':', '=')) cls = 'key';
        else if (nextNonSpaceIs(source, end, '(')) cls = 'fn';
        else if (spec.capitalTypes && /^[A-Z]/.test(word)) cls = 'typ';
        if (cls) token(cls, word);
        else push(word, null);
        i = end;
        continue;
      }
    }

    // INI/YAML section headers: [section]
    if (spec.mode === 'ini' && ch === '[' && (i === 0 || source[i - 1] === '\n')) {
      const end = source.indexOf(']', i);
      if (end !== -1 && end - i < 200) {
        token('key', source.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }

    // Punctuation / operators, one char at a time (merged into one span)
    if (PUNCT_CHARS.has(ch)) {
      push(ch, 'pun');
      i += 1;
      continue;
    }

    push(ch, null);
    i += 1;
  }

  flushPending();
  return out;
}

function nextNonSpaceIs(source, from, ...chars) {
  let j = from;
  while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;
  return chars.includes(source[j]);
}

function scanString(source, start, quote) {
  const len = source.length;
  let i = start + quote.length;
  while (i < len) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (source.startsWith(quote, i)) return i + quote.length;
    // Unterminated single-line string: stop at the newline.
    if (ch === '\n' && quote.length === 1 && quote !== '`') return i;
    i++;
  }
  return len;
}

// ---------------------------------------------------------------------------
// Markup (HTML / XML)
// ---------------------------------------------------------------------------

function renderMarkup(content, linkify) {
  const source = String(content);
  const len = source.length;
  let out = '';
  let i = 0;
  let text = '';

  const flushText = () => {
    if (!text) return;
    out += linkify ? escapeWithLinks(text) : escapeHtml(text);
    text = '';
  };
  const span = (cls, value) => {
    flushText();
    out += `<span class="t-${cls}">${escapeHtml(value)}</span>`;
  };

  while (i < len) {
    const ch = source[i];
    if (ch === '<') {
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i + 4);
        const stop = end === -1 ? len : end + 3;
        span('com', source.slice(i, stop));
        i = stop;
        continue;
      }
      if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
        const end = source.indexOf('>', i);
        const stop = end === -1 ? len : end + 1;
        span('meta', source.slice(i, stop));
        i = stop;
        continue;
      }
      const tagMatch = /^<\/?[A-Za-z][^\s>]*/.exec(source.slice(i, i + 200));
      if (tagMatch) {
        flushText();
        const nameEnd = i + tagMatch[0].length;
        span('pun', source[i] === '<' ? (source[i + 1] === '/' ? '</' : '<') : '<');
        span('tag', tagMatch[0].replace(/^<\/?/, ''));
        i = nameEnd;
        // Attributes
        while (i < len) {
          const c = source[i];
          if (c === '>') {
            span('pun', '>');
            i++;
            break;
          }
          if (c === '/' && source[i + 1] === '>') {
            span('pun', '/>');
            i += 2;
            break;
          }
          if (/\s/.test(c)) {
            out += escapeHtml(c);
            i++;
            continue;
          }
          if (c === '"' || c === "'") {
            const end = scanString(source, i, c);
            span('str', source.slice(i, end));
            i = end;
            continue;
          }
          if (c === '=') {
            span('pun', '=');
            i++;
            continue;
          }
            const attrMatch = /^[^\s=/>]+/.exec(source.slice(i, i + 200));
          if (attrMatch) {
            span('attr', attrMatch[0]);
            i += attrMatch[0].length;
            continue;
          }
          out += escapeHtml(c);
          i++;
        }
        continue;
      }
    }
    text += ch;
    i++;
  }
  flushText();
  return out;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function renderDiff(content, linkify) {
  const lines = String(content).split('\n');
  const out = [];
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) out.push(wrap('meta', line, linkify));
    else if (line.startsWith('@@')) out.push(wrap('hunk', line, linkify));
    else if (line.startsWith('+')) out.push(wrap('ins', line, linkify));
    else if (line.startsWith('-')) out.push(wrap('del', line, linkify));
    else if (/^(diff|index|new file|deleted file|similarity|rename|Binary files)/.test(line))
      out.push(wrap('meta', line, linkify));
    else out.push(line ? (linkify ? escapeWithLinks(line) : escapeHtml(line)) : '');
  }
  return out.join('\n');
}

function wrap(cls, text, linkify) {
  return `<span class="t-${cls}">${linkify ? escapeWithLinks(text) : escapeHtml(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Markdown (highlighted as source, never rendered)
// ---------------------------------------------------------------------------

const MD_INLINE_RE = /(`[^`\n]*`)|(\[[^\]\n]*\]\([^)\n]*\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

function renderMarkdown(content, linkify) {
  const lines = String(content).split('\n');
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(wrap('kw', line, false));
      continue;
    }
    if (inFence) {
      out.push(escapeHtml(line));
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      out.push(wrap('h', line, linkify));
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      out.push(wrap('com', line, linkify));
      continue;
    }
    if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(line)) {
      const marker = /^(\s{0,3}(?:[-*+]|\d+[.)]))(\s+)(.*)$/.exec(line);
      if (marker) {
        out.push(
          escapeHtml(marker[1]) + marker[2] + inlineMarkdown(marker[3], linkify),
        );
        continue;
      }
    }
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(wrap('pun', line, false));
      continue;
    }
    out.push(inlineMarkdown(line, linkify));
  }
  return out.join('\n');
}

function inlineMarkdown(line, linkify) {
  if (!line) return '';
  let out = '';
  let last = 0;
  MD_INLINE_RE.lastIndex = 0;
  let match;
  while ((match = MD_INLINE_RE.exec(line)) !== null) {
    out += escapeTextOrLinks(line.slice(last, match.index), linkify);
    const [full, code, link, bold, boldUnder, em, emUnder] = match;
    if (code) out += wrap('str', full, false);
    else if (link) {
      const parts = /^(\[[^\]\n]*\]\()([^)\n]*)(\))$/.exec(full);
      if (parts) out += `<span class="t-pun">${escapeHtml(parts[1])}</span><span class="t-var">${escapeHtml(parts[2])}</span><span class="t-pun">${escapeHtml(parts[3])}</span>`;
      else out += wrap('var', full, false);
    } else if (bold || boldUnder) out += wrap('h', full, false);
    else if (em || emUnder) out += wrap('attr', full, false);
    last = match.index + full.length;
    MD_INLINE_RE.lastIndex = last;
  }
  out += escapeTextOrLinks(line.slice(last), linkify);
  return out;
}

function escapeTextOrLinks(text, linkify) {
  if (!text) return '';
  return linkify ? escapeWithLinks(text) : escapeHtml(text);
}
