/**
 * Phase 1 tests: line-level formatting overlay + shortcode/sticker rendering.
 *
 * The contract these lock down:
 *
 *  - `content` is always the exact text: formatting rides beside it, never
 *    inside it. `/raw` (and fork, download, QR) must be byte-identical to what
 *    was typed, shortcodes included.
 *  - Stored styling is **ids only**. Anything unknown, out of range or
 *    hostile is dropped, never rendered, never a reason to fail a save.
 *  - Shortcodes resolve at render time, and a shortcode that lands inside a
 *    URL attribute must stay inert literal text rather than becoming markup.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMOJI_SHORTCODES, FORMAT, FORMAT_COLORS, FORMAT_FONTS, FORMAT_SIZES } from '../src/config.js';
import {
  formattingSummary,
  hasFormatting,
  hasShortcode,
  lineClassMap,
  lineClasses,
  loadStickers,
  normalizeFormatting,
  parseFormatting,
  renderStickers,
  safeStickerUrl,
  shortcodeName,
  stickerIndex,
  substituteShortcodes,
} from '../src/lib/formatting.js';
import { addLineAnchors, renderCode } from '../src/lib/highlight.js';
import { createApp, createApiKeyFor, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('normalizeFormatting accepts the object shape and canonicalises it', () => {
  const result = normalizeFormatting(
    { v: 1, lines: [{ line: 3, font: 'sans', size: 'lg', color: 'red' }] },
    { lineCount: 10 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.lines, 1);
  assert.deepEqual(JSON.parse(result.value), {
    v: 1,
    lines: [{ line: 3, font: 'sans', size: 'lg', color: 'red' }],
  });
});

test('normalizeFormatting accepts the JSON-string shape the editor posts', () => {
  const raw = JSON.stringify({ v: 1, lines: [{ line: 1, color: 'teal' }] });
  const result = normalizeFormatting(raw, { lineCount: 1 });
  assert.equal(result.lines, 1);
  assert.deepEqual(JSON.parse(result.value).lines, [{ line: 1, color: 'teal' }]);
});

test('normalizeFormatting treats absent, empty and unusable input as "no formatting"', () => {
  for (const raw of [undefined, null, '', '{truncated', 42, [], { v: 1 }, { v: 2, lines: [{ line: 1, color: 'red' }] }]) {
    const result = normalizeFormatting(raw, { lineCount: 5 });
    assert.equal(result.ok, true, `raw=${JSON.stringify(raw)}`);
    assert.equal(result.value, null, `raw=${JSON.stringify(raw)}`);
    assert.equal(result.lines, 0);
  }
});

test('normalizeFormatting drops unknown ids, out-of-range lines and CSS-shaped values', () => {
  const result = normalizeFormatting(
    {
      v: 1,
      lines: [
        { line: 1, font: 'comic-sans', size: 'huge', color: 'chartreuse' },
        { line: 99, color: 'red' },
        { line: 0, color: 'red' },
        { line: -2, color: 'red' },
        { line: 2, color: 'red; background: url(//evil)' },
        { line: 2, font: '<script>' },
        { line: 'x', color: 'red' },
        'nope',
        null,
      ],
    },
    { lineCount: 4 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value, null, 'an entry with nothing usable left does not occupy a slot');
});

test('normalizeFormatting keeps the valid parts of a partly invalid overlay', () => {
  const result = normalizeFormatting(
    { v: 1, lines: [{ line: 1, size: 'hellish' }, { line: 2, size: 'xl' }] },
    { lineCount: 4 },
  );
  assert.deepEqual(JSON.parse(result.value), { v: 1, lines: [{ line: 2, size: 'xl' }] });
});

test('normalizeFormatting collapses duplicates (last wins) and sorts by line', () => {
  const result = normalizeFormatting(
    {
      v: 1,
      lines: [
        { line: 3, color: 'red' },
        { line: 1, color: 'blue' },
        { line: 3, color: 'green' },
      ],
    },
    { lineCount: 3 },
  );
  assert.deepEqual(JSON.parse(result.value).lines, [
    { line: 1, color: 'blue' },
    { line: 3, color: 'green' },
  ]);
});

test('normalizeFormatting caps the overlay by line count and by stored size', () => {
  // Line count: three times the budget collapses to the budget, lowest lines first.
  const many = { v: 1, lines: Array.from({ length: FORMAT.maxLines * 3 }, (_, i) => ({ line: i + 1, color: 'red' })) };
  const capped = normalizeFormatting(many, { lineCount: FORMAT.maxLines * 3 });
  assert.equal(capped.ok, true);
  assert.equal(JSON.parse(capped.value).lines.length, FORMAT.maxLines);
  assert.equal(JSON.parse(capped.value).lines[0].line, 1, 'the visible top of a long paste keeps its formatting');

  // Stored size: a full-width overlay (every id set) is trimmed from the tail
  // instead of refused, so the paste still saves with the top styled.
  const dense = {
    v: 1,
    lines: Array.from({ length: FORMAT.maxLines }, (_, i) => ({
      line: i + 1,
      font: FORMAT_FONTS[0].id,
      size: FORMAT_SIZES.at(-1).id,
      color: FORMAT_COLORS.at(-1).id,
    })),
  };
  const trimmed = normalizeFormatting(dense, { lineCount: FORMAT.maxLines });
  assert.equal(trimmed.ok, true);
  assert.ok(trimmed.value.length <= FORMAT.maxBytes, 'the stored overlay respects the byte budget');
  assert.ok(trimmed.lines > 0 && trimmed.lines < FORMAT.maxLines, `trimmed to ${trimmed.lines} lines`);
  assert.equal(JSON.parse(trimmed.value).lines[0].line, 1, 'trimming drops the tail, not the head');
  assert.equal(
    JSON.parse(trimmed.value).lines.at(-1).line,
    trimmed.lines,
    'what is kept is a contiguous run from line 1',
  );

  // A string payload that cannot possibly become an overlay says so plainly.
  const rejected = normalizeFormatting('x'.repeat(FORMAT.maxBytes + 1), { lineCount: 3 });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /too large/i);
});

test('parseFormatting round-trips a stored overlay and never throws', () => {
  const stored = normalizeFormatting({ v: 1, lines: [{ line: 2, font: 'mono', color: 'orange' }] }, { lineCount: 2 }).value;
  assert.deepEqual(parseFormatting(stored), { v: 1, lines: [{ line: 2, font: 'mono', color: 'orange' }] });
  for (const raw of [null, undefined, '', '{oops', '[]', '{"v":1,"lines":"no"}', '{"v":9,"lines":[{"line":1,"color":"red"}]}']) {
    const parsed = parseFormatting(raw);
    assert.deepEqual(parsed, { v: FORMAT.version, lines: [] }, `raw=${JSON.stringify(raw)}`);
    assert.equal(hasFormatting(parsed), false);
  }
});

test('lineClasses and lineClassMap produce CSS classes, never inline styles', () => {
  assert.equal(lineClasses({ line: 1 }), '');
  assert.equal(lineClasses({ line: 1, font: 'sans', size: 'lg', color: 'red' }), 'fmt-f-sans fmt-s-lg fmt-c-red');
  const map = lineClassMap({ v: 1, lines: [{ line: 2, color: 'red' }, { line: 5, size: 'sm' }] });
  assert.equal(map.get(2), 'fmt-c-red');
  assert.equal(map.has(3), false);
  assert.equal(lineClassMap(parseFormatting(null)).size, 0);
});

test('formattingSummary is empty without formatting and pluralises', () => {
  assert.equal(formattingSummary(parseFormatting(null)), '');
  assert.equal(formattingSummary({ v: 1, lines: [{ line: 1, color: 'red' }] }), '1 formatted line');
  assert.equal(formattingSummary({ v: 1, lines: [{ line: 1, color: 'red' }, { line: 2, size: 'sm' }] }), '2 formatted lines');
});

// ---------------------------------------------------------------------------
// Stickers
// ---------------------------------------------------------------------------

test('stickerIndex exposes the built-in emoji set and lets the pack override it', () => {
  const base = stickerIndex();
  assert.ok(base.size >= Object.keys(EMOJI_SHORTCODES).length);
  for (const [name, emoji] of Object.entries(EMOJI_SHORTCODES)) {
    assert.equal(base.get(name).emoji, emoji);
    assert.equal(base.get(name).url, null);
  }

  const withPack = stickerIndex([
    { token: ':wave:', url: 'https://cdn.example/wave.gif', emoji: '👋', label: 'Wave' },
    { token: ':fire:', url: 'javascript:alert(1)', emoji: '🔥', label: '' },
    { token: 'party', url: 'https://cdn.example/x.gif', emoji: '🫥', label: 'x' },
    { token: ':nosuchthing:', url: null, emoji: null, label: 'empty row' },
    { token: ': not a token :', url: 'https://cdn.example/y.gif', emoji: '🫥', label: 'y' },
  ]);
  const wave = withPack.get('wave');
  assert.equal(wave.url, 'https://cdn.example/wave.gif');
  assert.equal(wave.label, 'Wave');
  assert.equal(wave.token, ':wave:', 'tokens normalise to the :name: shape');
  assert.equal(withPack.get('party').url, 'https://cdn.example/x.gif', 'a bare token is accepted');
  assert.equal(withPack.get('nosuchthing'), undefined, 'a row with neither a usable URL nor an emoji is ignored');
  assert.equal(withPack.get('notatoken'), undefined, 'a name that cannot be typed as a shortcode is ignored');
  // A hostile URL degrades to the emoji rather than reaching the page.
  assert.equal(withPack.get('fire').url, null);
  assert.equal(withPack.get('fire').emoji, '🔥');
});

test('shortcodeName accepts :name:, ;name; and a bare name, and rejects everything else', () => {
  assert.equal(shortcodeName(':wave:'), 'wave');
  assert.equal(shortcodeName(';Wave;'), 'wave');
  assert.equal(shortcodeName('  :party_time: '), 'party_time');
  assert.equal(shortcodeName('wave'), 'wave', 'a pack row may omit the delimiters');
  assert.equal(shortcodeName(': wave :'), null);
  assert.equal(shortcodeName('a b'), null);
  assert.equal(shortcodeName(':' + 'a'.repeat(40) + ':'), null);
  assert.equal(shortcodeName('"><script>'), null);
  assert.equal(shortcodeName(null), null);
});

test('safeStickerUrl allows only bare https URLs', () => {
  assert.equal(safeStickerUrl('https://cdn.example/a.gif'), 'https://cdn.example/a.gif');
  for (const bad of [
    'javascript:alert(1)',
    'data:image/gif;base64,AAAA',
    'http://cdn.example/a.gif',
    'https://user:pass@cdn.example/a.gif',
    '//cdn.example/a.gif',
    '/a.gif',
    '',
    null,
    `https://cdn.example/${'a'.repeat(600)}.gif`,
  ]) {
    assert.equal(safeStickerUrl(bad), null, `value=${String(bad).slice(0, 40)}`);
  }
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('substituteShortcodes prefers the emoji, and the pack image when present', () => {
  const emojiOnly = substituteShortcodes('hi :wave: there', stickerIndex());
  assert.equal(emojiOnly.text, `hi ${EMOJI_SHORTCODES.wave} there`);
  assert.deepEqual(emojiOnly.stickers, []);

  const withPack = substituteShortcodes(
    'hi :wave: there',
    stickerIndex([{ token: 'wave', url: 'https://cdn.example/wave.gif', emoji: '👋', label: 'wave' }]),
  );
  assert.equal(withPack.stickers.length, 1);
  assert.equal(withPack.text, `hi \uE000 there`, 'a sticker rides as a private-use placeholder');

  // Unresolvable shortcodes stay literal, so an author keeps what they typed.
  assert.equal(substituteShortcodes(':notreal:', stickerIndex()).text, ':notreal:');
  assert.equal(hasShortcode('no codes here'), false);
  assert.equal(hasShortcode('yes :fire:'), true);
  assert.equal(hasShortcode('yes ;fire;'), true);
});

test('renderStickers swaps placeholders in text and skips tag attributes', () => {
  const stickers = [{ token: 'wave', url: 'https://cdn.example/wave.gif', emoji: null, label: 'Wave <script>' }];
  const html = renderStickers('<span class="line-content">a \uE000 b</span>', stickers);
  assert.match(html, /<img class="sticker" src="https:\/\/cdn\.example\/wave\.gif"/);
  assert.match(html, /alt="Wave &lt;script&gt;"/, 'the label is escaped');

  const inAttribute = renderStickers('<a href="https://x.test/\uE000">link</a>', stickers);
  assert.match(inAttribute, /href="https:\/\/x\.test\/\uE000"/, 'the attribute keeps the inert literal character');
  assert.doesNotMatch(inAttribute, /<img/);
  // The same character in a text segment is a sticker, so the split is what matters.
  assert.match(renderStickers('<a href="https://x.test/\uE000">x \uE000</a>', stickers), /x <img class="sticker"/);

  const stray = renderStickers('<p>\uE000</p>', []);
  assert.equal(stray, '<p>\uE000</p>', 'without a pack there is nothing to substitute');
});

test('a shortcode inside a URL never injects markup into the href', () => {
  const withPack = substituteShortcodes(
    'see https://x.test/:wave: now',
    stickerIndex([{ token: 'wave', url: 'https://cdn.example/wave.gif', emoji: null, label: 'wave' }]),
  );
  const html = renderStickers(renderCode(withPack.text, 'plaintext'), withPack.stickers);
  assert.doesNotMatch(html, /<a [^>]*>\s*<img/, 'no tag inside an attribute');
  assert.doesNotMatch(html, /href="[^"]*<img/, 'no tag inside an attribute');
  assert.match(html, /<img class="sticker"/, 'the visible text still shows the sticker');
  assert.match(html, /rel="noopener noreferrer nofollow"/, 'the link itself is unchanged');
});

test('a sticker image does not leak into the per-line tag balancing', () => {
  // Regression: `addLineAnchors` re-opens open tags on every line, so a void
  // element (an <img>) pushed onto its stack came back on every following line
  // with a bogus `</img>`.
  const pack = stickerIndex([{ token: ':fire:', url: 'https://cdn.example/f.gif', emoji: '🔥', label: 'fire' }]);
  const resolved = substituteShortcodes('a :fire:\nb\nc :fire:\nd', pack);
  // The real order: resolve -> highlight -> swap stickers -> line anchors.
  const html = addLineAnchors(renderStickers(renderCode(resolved.text, 'plaintext'), resolved.stickers), {
    classes: lineClassMap(parseFormatting(null)),
  });
  assert.equal(html.match(/<img/g)?.length, 2, 'one image per shortcode');
  assert.doesNotMatch(html, /<\/img>/, 'no closing tag for a void element');
  assert.equal(html.match(/code-line/g)?.length, 4, 'every line still opens exactly once');
  // Line 2 has no shortcode, so it must not contain a sticker.
  const line2 = /id="line-2"[\s\S]*?<\/span><\/span>/.exec(html)?.[0] ?? '';
  assert.doesNotMatch(line2, /<img/, 'the image does not reappear on the next line');
});
test('the full render pipeline applies line classes to the right lines', () => {
  const formatting = parseFormatting(
    normalizeFormatting({ v: 1, lines: [{ line: 1, font: 'sans' }, { line: 3, color: 'red' }] }, { lineCount: 3 }).value,
  );
  const content = 'one :fire:\ntwo\nthree';
  const resolved = substituteShortcodes(content, stickerIndex());
  const html = addLineAnchors(renderCode(resolved.text, 'plaintext'), { classes: lineClassMap(formatting) });
  assert.match(html, /class="code-line fmt-f-sans" id="line-1"/);
  assert.match(html, /class="code-line" id="line-2"/);
  assert.match(html, /class="code-line fmt-c-red" id="line-3"/);
  assert.doesNotMatch(html, /style="/, 'styling is classes only — no inline styles under the strict CSP');
});

// ---------------------------------------------------------------------------
// End to end: web form, API, /raw
// ---------------------------------------------------------------------------

test('web editor stores formatting and renders it, while /raw stays byte-exact', async () => {
  const app = await createApp();
  const content = 'line one :fire:\nline two\nline three';
  const formatting = JSON.stringify({ v: 1, lines: [{ line: 1, color: 'red', size: 'lg' }, { line: 3, font: 'sans' }] });

  const created = await app.request('/p', { body: form({ title: 'styled.txt', content, formatting, language: 'plaintext' }) });
  assert.equal(created.status, 303, await created.text());
  const id = pasteIdFrom(created);
  assert.ok(id, 'redirected to the new paste');

  const page = await (await app.request(`/p/${id}`)).text();
  assert.match(page, /class="code-line fmt-s-lg fmt-c-red" id="line-1"/);
  assert.match(page, /class="code-line" id="line-2"/);
  assert.match(page, /class="code-line fmt-f-sans" id="line-3"/);
  assert.match(page, /2 formatted lines/);
  assert.match(page, new RegExp(EMOJI_SHORTCODES.fire), 'the :fire: shortcode rendered as its emoji');
  assert.doesNotMatch(page, /style="/);

  const raw = await app.request(`/p/${id}/raw`);
  assert.equal(await raw.text(), content, '/raw is the exact text, shortcodes included');
  assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8');

  await app.close();
});

test('a curated sticker renders once per shortcode in the served page', async () => {
  const app = await createApp();
  // Two rows: a good one, and one whose URL must fall back to its emoji.
  await app.db.run('INSERT INTO stickers (token, url, emoji, label, created_at) VALUES (?,?,?,?,?)', [
    ':fire:', 'https://cdn.example/fire.gif', '🔥', 'fire', Date.now(),
  ]);
  await app.db.run('INSERT INTO stickers (token, url, emoji, label, created_at) VALUES (?,?,?,?,?)', [
    ':rocket:', 'javascript:alert(1)', '🚀', 'bad', Date.now(),
  ]);

  const content = 'start :fire:\nmiddle\nagain :fire: and :rocket:';
  const created = await app.request('/p', { body: form({ title: 'sticker.txt', content }) });
  assert.equal(created.status, 303, await created.text());
  const id = pasteIdFrom(created);
  const page = await (await app.request(`/p/${id}`)).text();
  const pre = /<pre id="paste-content"[\s\S]*?<\/pre>/.exec(page)?.[0] ?? '';

  assert.equal(pre.match(/<img/g)?.length, 2, 'one image per resolvable shortcode');
  assert.doesNotMatch(pre, /<\/img>/, 'a void element is never closed');
  assert.match(pre, /src="https:\/\/cdn\.example\/fire\.gif"/);
  assert.doesNotMatch(pre, /javascript:/, 'the hostile sticker URL never reaches the page');
  assert.match(pre, /🚀/, 'it degrades to the emoji instead');
  assert.equal(pre.match(/id="line-2"/)?.length, 1, 'each line still opens exactly once');

  // The stored text is untouched, so /raw and friends stay byte-exact.
  assert.equal(await (await app.request(`/p/${id}/raw`)).text(), content);
  await app.close();
});

test('an unconfigured or hostile overlay cannot break the save or the page', async () => {
  const app = await createApp();
  const content = 'alpha\nbeta';
  const created = await app.request('/p', {
    body: form({
      title: 'hostile.txt',
      content,
      formatting: JSON.stringify({
        v: 1,
        lines: [
          { line: 1, color: 'red;"></style><script>alert(1)</script>', font: 'system' },
          { line: 2, size: 'md' },
        ],
      }),
    }),
  });
  const id = pasteIdFrom(created);
  const page = await (await app.request(`/p/${id}`)).text();
  assert.match(page, /class="code-line fmt-s-md" id="line-2"/);
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.equal(await (await app.request(`/p/${id}/raw`)).text(), content);
  await app.close();
});

test('API create, read, meta and update handle the formatting overlay', async () => {
  const app = await createApp();
  await registerUser(app, 'apiuser');
  const key = await createApiKeyFor(app, 'apiuser');

  const created = await app.request('/api/pastes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: jsonBody({ title: 'formatted', content: 'one :wave:\ntwo', formatting: { v: 1, lines: [{ line: 2, color: 'red' }] } }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  const id = body.id;
  assert.equal(body.content, undefined, 'the create response stays lean');
  assert.equal(body.formatting, undefined, 'the overlay describes the content, so it travels with it');

  const read = await (await app.request(`/api/pastes/${id}`, { headers: { authorization: `Bearer ${key}` } })).json();
  assert.deepEqual(read.formatting, { v: 1, lines: [{ line: 2, color: 'red' }] });
  assert.equal(read.content, 'one :wave:\ntwo', 'the API returns the text as typed');

  const meta = await (await app.request('/api/meta')).json();
  assert.ok(meta.formatting.fonts.length >= 2);
  assert.ok(meta.formatting.sizes.some((size) => size.id === 'lg'));
  assert.ok(meta.formatting.colors.some((color) => color.id === 'red'));
  assert.equal(meta.formatting.shortcodes.wave, EMOJI_SHORTCODES.wave);
  assert.equal(meta.limits.formattingLines, FORMAT.maxLines);
  assert.equal(meta.limits.formattingBytes, FORMAT.maxBytes);

  // An update that does not mention formatting leaves it alone.
  const untouched = await app.request(`/api/pastes/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: jsonBody({ title: 'renamed' }),
  });
  assert.equal(untouched.status, 200);
  assert.deepEqual((await untouched.json()).formatting, { v: 1, lines: [{ line: 2, color: 'red' }] });

  // An explicit null clears it, and the read model says so.
  const cleared = await app.request(`/api/pastes/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: jsonBody({ formatting: null }),
  });
  assert.equal(cleared.status, 200);
  const after = await (await app.request(`/api/pastes/${id}`, { headers: { authorization: `Bearer ${key}` } })).json();
  assert.equal(after.formatting, null);
  assert.equal(after.content, 'one :wave:\ntwo');

  await app.close();
});

test('web edit keeps styling when the field is absent and clears it when empty', async () => {
  const app = await createApp();
  await registerUser(app, 'editor1');
  const content = 'one\ntwo';
  const created = await app.request('/p', {
    jar: 'editor1',
    body: form({ title: 'mine.txt', content, formatting: JSON.stringify({ v: 1, lines: [{ line: 2, color: 'green' }] }) }),
  });
  assert.equal(created.status, 303, await created.text());
  const id = pasteIdFrom(created);

  // The edit form itself is pre-filled with the stored overlay.
  const editForm = await (await app.request(`/p/${id}/edit`, { jar: 'editor1' })).text();
  assert.match(editForm, /name="formatting"[^>]*value="[^"]*green/);

  // A POST that never mentions formatting leaves it alone.
  const kept = await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'editor1',
    body: form({ title: 'mine v2', content, language: 'plaintext', expiration: 'never' }),
  });
  assert.equal(kept.status, 303, await kept.text());
  assert.match(await (await app.request(`/p/${id}`)).text(), /class="code-line fmt-c-green" id="line-2"/);

  // The editor sends the field explicitly, so an empty value clears it.
  const cleared = await app.request(`/p/${id}/edit`, {
    method: 'POST',
    jar: 'editor1',
    body: form({ title: 'mine v3', content, language: 'plaintext', expiration: 'never', formatting: '' }),
  });
  assert.equal(cleared.status, 303, await cleared.text());
  assert.match(await (await app.request(`/p/${id}`)).text(), /class="code-line" id="line-2"/);
  assert.equal(await (await app.request(`/p/${id}/raw`)).text(), content);
  await app.close();
});

test('the duplicate screen carries the source styling into the copy', async () => {
  const app = await createApp();
  const content = 'a :fire:\nb';
  const created = await app.request('/p', {
    body: form({
      title: 'source.txt',
      content,
      formatting: JSON.stringify({ v: 1, lines: [{ line: 2, color: 'blue' }] }),
    }),
  });
  assert.equal(created.status, 303, await created.text());
  const id = pasteIdFrom(created);

  // The duplicate screen is the ordinary editor, pre-filled from the source.
  const screen = await (await app.request(`/p/${id}/fork`)).text();
  const hidden = /name="formatting"[^>]*value="([^"]*)"/.exec(screen);
  assert.ok(hidden, 'the duplicate form carries a formatting field');
  const payload = hidden[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.deepEqual(JSON.parse(payload).lines, [{ line: 2, color: 'blue' }]);

  const forked = await app.request('/p', { body: form({ title: 'copy.txt', content, formatting: payload }) });
  assert.equal(forked.status, 303, await forked.text());
  const copyId = pasteIdFrom(forked);
  assert.notEqual(copyId, id);
  const copy = await (await app.request(`/p/${copyId}`)).text();
  assert.match(copy, /class="code-line fmt-c-blue" id="line-2"/);
  assert.equal(await (await app.request(`/p/${copyId}/raw`)).text(), content);
  await app.close();
});

test('loadStickers survives a database without the sticker table', async () => {
  const rows = await loadStickers(/** @type {any} */ ({ all: async () => { throw new Error('no such table'); } }));
  assert.deepEqual(rows, []);
  assert.equal(stickerIndex(rows).get('wave').emoji, EMOJI_SHORTCODES.wave);
});
