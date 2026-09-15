/** Unit tests for the security- and rendering-critical helpers. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, escapeWithLinks, renderCode, resolveLanguage } from '../src/lib/highlight.js';
import { esc, html, SafeHtml } from '../src/lib/html.js';
import {
  PBKDF2_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  hashPassword,
  randomToken,
  safeEqual,
  verifyPassword,
} from '../src/lib/crypto.js';
import { withWorkersPbkdf2Cap } from './helpers.js';
import {
  byteLength,
  formatBytes,
  isValidPasteId,
  normalizeExpiration,
  normalizeFont,
  normalizeFontSize,
  normalizeLanguage,
  relativeTime,
  safeFilename,
  validateContent,
  validateTitle,
  validateUsername,
  validatePassword,
} from '../src/lib/validate.js';
import { LANGUAGES } from '../src/config.js';

test('html templating escapes interpolated values by default', () => {
  const evil = '<script>alert(1)</script>';
  const out = String(html`<p title="${evil}">${evil}</p>`);
  assert.equal(out, '<p title="&lt;script&gt;alert(1)&lt;/script&gt;">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  const nested = String(html`${html`<b>ok</b>`}${[html`<i>a</i>`, '<i>b</i>']}`);
  assert.equal(nested, '<b>ok</b><i>a</i>&lt;i&gt;b&lt;/i&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.ok(html`x` instanceof SafeHtml);
});

test('linkify only trusts http(s) and survives entity escaping', () => {
  const out = escapeWithLinks('a https://x.example/a?b=1&c=2. b javascript:alert(1) c http://y.example/) d');
  assert.match(out, /<a href="https:\/\/x.example\/a\?b=1&amp;c=2" /);
  // `javascript:` may appear as inert escaped text, but never as a link target.
  assert.doesNotMatch(out, /href="javascript:/);
  // Trailing punctuation trimmed, unbalanced paren dropped.
  assert.match(out, /href="http:\/\/y.example\/"/);
  // Angle brackets still escaped.
  assert.equal(escapeWithLinks('<img src=x>'), '&lt;img src=x&gt;');
  assert.equal(escapeHtml(`"&'<>`), '&quot;&amp;&#39;&lt;&gt;');
});

test('highlighter escapes everything and never emits raw user markup', () => {
  const samples = [
    ['<script>alert(1)</script>', 'javascript'],
    ['</pre><img src=x onerror=alert(1)>', 'html'],
    ['```js\nalert("</pre>")\n```', 'markdown'],
    ['+ </pre>\n- <script>', 'diff'],
    ['"unterminated string', 'python'],
    ['/* unterminated comment', 'c'],
    ['\u0000\u0001binary\u0002', 'plaintext'],
  ];
  for (const [code, lang] of samples) {
    const out = renderCode(code, lang);
    assert.doesNotMatch(out, /<script/i, lang);
    assert.doesNotMatch(out, /onerror=/i, lang);
    assert.doesNotMatch(out, /<\/pre>/i, lang);
  }
});

test('highlighter covers the advertised language list without throwing', () => {
  const code = 'function f(x) { return "s" /* c */ + 1; } // t\n# hash\n-- sql\n<!-- xml -->';
  for (const lang of LANGUAGES) {
    const out = renderCode(code, lang.id);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  }
});

test('language resolution is manual and forgiving', () => {
  assert.equal(resolveLanguage('py'), 'python');
  assert.equal(resolveLanguage('TypeScript'), 'typescript');
  assert.equal(resolveLanguage(''), 'plaintext');
  assert.equal(resolveLanguage('nope'), 'plaintext');
});

test('password hashing verifies and rejects', async () => {
  const stored = await hashPassword('a-long-password');
  assert.match(stored, /^pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(await verifyPassword('a-long-password', stored));
  assert.equal(await verifyPassword('a-long-password2', stored), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2-sha256$1000$not-base64!!$broken'), false);
  assert.ok(safeEqual('abc', 'abc'));
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(new Set([randomToken(16), randomToken(16), randomToken(16)]).size, 3);
});

// Cloudflare Workers cap PBKDF2 at 100 000 iterations and throw
// NotSupportedError above it. Local runtimes (Node, Miniflare) do not, so the
// ceiling has to be pinned by a test or it silently breaks production only.
test('password hashing stays inside the Cloudflare PBKDF2 iteration ceiling', () => {
  assert.ok(
    PBKDF2_ITERATIONS <= PBKDF2_MAX_ITERATIONS,
    `PBKDF2_ITERATIONS (${PBKDF2_ITERATIONS}) exceeds the Workers ceiling (${PBKDF2_MAX_ITERATIONS})`,
  );
  assert.equal(PBKDF2_ITERATIONS, 100_000);
});

test('hashing degrades instead of throwing when the runtime caps PBKDF2', async () => {
  const restore = withWorkersPbkdf2Cap(50_000);
  try {
    const stored = await hashPassword('a-long-password');
    const iterations = Number(stored.split('$')[1]);
    assert.ok(iterations <= 50_000, `asked for a supported count, got ${iterations}`);
    assert.ok(await verifyPassword('a-long-password', stored));
    assert.equal(await verifyPassword('a-long-password2', stored), false);
  } finally {
    restore();
  }
});

test('a legacy over-cap hash fails the login instead of returning 500', async () => {
  // A record written by a runtime with a higher ceiling (e.g. `npm run dev`).
  const overCap = await rawPasswordHash('a-long-password', 210_000);
  const restore = withWorkersPbkdf2Cap(100_000);
  try {
    assert.equal(await verifyPassword('a-long-password', overCap), false);
  } finally {
    restore();
  }
});

/** Build a `pbkdf2-sha256$…` record at an arbitrary iteration count, bypassing the cap. */
async function rawPasswordHash(password, iterations) {
  const subtle = globalThis.crypto.subtle;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

test('validation rules', () => {
  assert.equal(validateTitle('  hi  ').value, 'hi');
  assert.equal(validateTitle('').ok, false);
  assert.equal(validateTitle('x'.repeat(121)).ok, false);
  assert.equal(validateContent('', 100).ok, false);
  assert.equal(validateContent('x'.repeat(101), 100).ok, false);
  assert.equal(validateContent('a\r\nb', 100).value, 'a\nb');
  assert.equal(validateContent('a\u0000b', 100).value, 'ab');
  assert.equal(byteLength('é'), 2);

  assert.equal(validateUsername('abcd').ok, true);
  assert.equal(validateUsername('ab12').ok, true);
  assert.equal(validateUsername('abc').ok, false);
  assert.equal(validateUsername('abcdefg').ok, false);
  assert.equal(validateUsername('a_b-c').ok, false);
  assert.equal(validateUsername('a b c').ok, false);
  assert.equal(validatePassword('12345678').ok, true);
  assert.equal(validatePassword('1234567').ok, false);

  assert.equal(normalizeLanguage('PYTHON'), 'python');
  assert.equal(normalizeLanguage('zzz'), 'plaintext');
  assert.equal(normalizeFont('serif'), 'serif');
  assert.equal(normalizeFont('evil'), 'mono');
  assert.equal(normalizeFontSize('16'), 16);
  assert.equal(normalizeFontSize('999'), 14);

  const never = normalizeExpiration('never');
  assert.equal(never.expiresAt, null);
  const timed = normalizeExpiration('1h', 1000);
  assert.equal(timed.expiresAt, 4600);
  assert.equal(normalizeExpiration('bogus', 1000).id, '1w');

  assert.equal(isValidPasteId('a8Kx92Lm'), true);
  assert.equal(isValidPasteId('a8Kx92L'), false);
  assert.equal(isValidPasteId('../etc'), false);
  assert.equal(isValidPasteId('a8Kx92Lm/'), false);

  assert.equal(safeFilename('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeFilename('Hello World!'), 'hello-world');
  assert.equal(safeFilename(''), 'paste');

  assert.equal(formatBytes(512), '512 B');
  assert.match(relativeTime(Math.floor(Date.now() / 1000) - 7200), /2 hours ago/);
});
