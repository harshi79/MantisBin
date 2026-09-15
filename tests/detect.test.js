import test from 'node:test';
import assert from 'node:assert/strict';

import { LANGUAGE_DETECT_MAX_BYTES, LIMITS } from '../src/config.js';
import { detectLanguage } from '../src/lib/detect.js';
import { createApiKeyFor, createApp, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';

test('auto detection recognises bounded common formats without executing input', () => {
  const examples = [
    ['json', '{"name":"MantisBin","enabled":true}'],
    ['yaml', 'name: MantisBin\nitems:\n  - paste\n  - share'],
    ['markdown', '# Heading\n\n- one\n- two'],
    ['bash', '#!/usr/bin/env bash\nset -eu\necho "$HOME"'],
    ['python', 'def greet(name):\n    print(name)'],
    ['javascript', 'const answer = 42;\nconsole.log(answer);'],
    ['typescript', 'interface User { name: string }\nconst user: User = { name: "x" };'],
    ['sql', 'SELECT id, name\nFROM users\nWHERE id = 1;'],
    ['html', '<!doctype html>\n<html><body>Hello</body></html>'],
    ['xml', '<?xml version="1.0"?>\n<root><item>one</item></root>'],
    ['css', 'body { color: red;\n  margin: 0; }'],
    ['diff', 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@'],
  ];
  for (const [language, content] of examples) assert.equal(detectLanguage(content), language, content);

  // This looks like a YAML key but is too weak to call a format.
  assert.equal(detectLanguage('A note: keep this line as plain text.'), 'plaintext');
  assert.equal(detectLanguage('nothing special, just a short sentence.'), 'plaintext');
});

test('detection is bounded and reuses the large-paste plaintext fast path', () => {
  const prefix = '{"name":"detected"}';
  const withinPrefix = prefix + ' '.repeat(Math.max(0, LANGUAGE_DETECT_MAX_BYTES - prefix.length - 1));
  assert.equal(detectLanguage(withinPrefix), 'json', 'a complete capped document can be detected');

  const large = '{"name":"not parsed because the viewer fast path is active"}' + 'x'.repeat(LIMITS.highlightMaxBytes);
  assert.equal(detectLanguage(large), 'plaintext');

  // A truncated JSON prefix is not repeatedly parsed or guessed as a format.
  assert.equal(detectLanguage('{"items":[' + '1,'.repeat(LANGUAGE_DETECT_MAX_BYTES)), 'plaintext');
});

test('the web editor exposes Auto detect and stores the resolved language', async () => {
  const app = await createApp();
  try {
    const home = await app.request('/');
    const homeHtml = await home.text();
    assert.match(homeHtml, /<option value="auto"[^>]*>Auto detect<\/option>/);

    const content = '{"source":"web","ok":true}';
    const created = await app.request('/p', {
      body: form({ title: 'auto web', content, language: 'auto', expiration: '1w' }),
    });
    assert.equal(created.status, 303);
    const id = pasteIdFrom(created);
    const row = await app.db.get('SELECT language FROM pastes WHERE id = ?', [id]);
    assert.equal(row.language, 'json');

    const manual = await app.request('/p', {
      body: form({ title: 'manual wins', content, language: 'python', expiration: '1w' }),
    });
    const manualId = pasteIdFrom(manual);
    const manualRow = await app.db.get('SELECT language FROM pastes WHERE id = ?', [manualId]);
    assert.equal(manualRow.language, 'python');
  } finally {
    await app.close();
  }
});

test('the API resolves language auto, returns it, and stores no auto sentinel', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'autou');
    const key = await createApiKeyFor(app, 'autou');
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    const created = await app.request('/api/pastes', {
      method: 'POST',
      headers,
      body: jsonBody({ title: 'auto api', content: 'SELECT id\nFROM users;', language: 'auto' }),
    });
    assert.equal(created.status, 201);
    const data = await created.json();
    assert.equal(data.language, 'sql');
    assert.notEqual(data.language, 'auto');

    const stored = await app.db.get('SELECT language FROM pastes WHERE id = ?', [data.id]);
    assert.equal(stored.language, 'sql');

    const ambiguous = await app.request('/api/pastes', {
      method: 'POST',
      headers,
      body: jsonBody({ title: 'ambiguous', content: 'A note: keep it simple.', language: 'auto' }),
    });
    assert.equal(ambiguous.status, 201);
    assert.equal((await ambiguous.json()).language, 'plaintext');
  } finally {
    await app.close();
  }
});
