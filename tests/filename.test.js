import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FILENAME, LANGUAGES } from '../src/config.js';
import { filenameExtension, languageFromFilename, resolvePasteLanguage } from '../src/lib/detect.js';
import { createApiKeyFor, createApp, form, jsonBody, pasteIdFrom, registerUser } from './helpers.js';

test('languageFromFilename maps common extensions (case-insensitive)', () => {
  const cases = [
    ['app.py', 'python'],
    ['APP.PY', 'python'],
    ['archive.tar.gz', null], // unknown extension falls through to content detection
    ['notes.txt', 'plaintext'],
    ['notes.md', 'markdown'],
    ['data.json', 'json'],
    ['config.yaml', 'yaml'],
    ['config.yml', 'yaml'],
    ['settings.toml', 'ini'],
    ['run.sh', 'bash'],
    ['run.bash', 'bash'],
    ['main.c', 'c'],
    ['main.h', 'c'],
    ['main.cpp', 'cpp'],
    ['main.hpp', 'cpp'],
    ['app.cs', 'csharp'],
    ['Main.java', 'java'],
    ['app.js', 'javascript'],
    ['app.mjs', 'javascript'],
    ['app.jsx', 'javascript'],
    ['app.ts', 'typescript'],
    ['app.tsx', 'typescript'],
    ['app.rb', 'ruby'],
    ['index.php', 'php'],
    ['main.go', 'go'],
    ['main.rs', 'rust'],
    ['Main.kt', 'kotlin'],
    ['App.swift', 'swift'],
    ['init.lua', 'lua'],
    ['query.sql', 'sql'],
    ['index.html', 'html'],
    ['feed.xml', 'xml'],
    ['diagram.svg', 'xml'],
    ['styles.css', 'css'],
    ['styles.scss', 'css'],
    ['fix.patch', 'diff'],
    ['rules.mk', 'makefile'],
    ['prod.dockerfile', 'dockerfile'],
  ];
  for (const [title, expected] of cases) assert.equal(languageFromFilename(title), expected, title);

  // Every mapping resolves to a stored language id.
  const known = new Set(LANGUAGES.map((lang) => lang.id));
  for (const [, expected] of cases) {
    if (expected !== null) assert.ok(known.has(expected), expected);
  }
});

test('languageFromFilename handles exact names, paths and non-filenames', () => {
  assert.equal(languageFromFilename('Dockerfile'), 'dockerfile');
  assert.equal(languageFromFilename('dockerfile'), 'dockerfile');
  assert.equal(languageFromFilename('Makefile'), 'makefile');
  assert.equal(languageFromFilename('GNUmakefile'), 'makefile');
  assert.equal(languageFromFilename('.bashrc'), 'bash');
  assert.equal(languageFromFilename('.zshrc'), 'bash');
  assert.equal(languageFromFilename('Gemfile'), 'ruby');

  // Basename wins over directories; surrounding whitespace is ignored.
  assert.equal(languageFromFilename('src/app.py'), 'python');
  assert.equal(languageFromFilename('  app.py  '), 'python');

  // Not filenames: no match, never throws.
  assert.equal(languageFromFilename('plain title'), null);
  assert.equal(languageFromFilename('release notes v1.2'), null);
  assert.equal(languageFromFilename('trailing dot.'), null);
  assert.equal(languageFromFilename('no-extension'), null);
  assert.equal(languageFromFilename(''), null);
  assert.equal(languageFromFilename(null), null);
  assert.equal(languageFromFilename(undefined), null);
  assert.equal(languageFromFilename(42), null);
});

test('filenameExtension returns the display badge or nothing', () => {
  assert.equal(filenameExtension('app.py'), '.py');
  assert.equal(filenameExtension('APP.PY'), '.py');
  assert.equal(filenameExtension('archive.tar.gz'), '.gz');
  assert.equal(filenameExtension('plain title'), '');
  assert.equal(filenameExtension('trailing dot.'), '');
  assert.equal(filenameExtension(''), '');
  assert.equal(filenameExtension(null), '');
});

test('resolvePasteLanguage: manual wins, extension beats content, content is the fallback', () => {
  const python = 'def greet(name):\n    print(name)';
  // Manual selection always wins, even over a conflicting extension.
  assert.equal(resolvePasteLanguage('javascript', 'app.py', python), 'javascript');
  // Extension wins over content fingerprints.
  assert.equal(resolvePasteLanguage('auto', 'app.py', '{"looks":"json"}'), 'python');
  // No recognised extension: content detection decides.
  assert.equal(resolvePasteLanguage('auto', 'no extension here', '{"a":1}'), 'json');
  assert.equal(resolvePasteLanguage('auto', 'no extension here', python), 'python');
  // Ambiguous content without an extension stays plaintext.
  assert.equal(resolvePasteLanguage('auto', 'notes', 'just a short sentence.'), 'plaintext');
  // The default filename resolves to plain text.
  assert.equal(languageFromFilename(DEFAULT_FILENAME), 'plaintext');
});

test('the create form starts filename-first: untitled.txt + Auto detect', async () => {
  const app = await createApp();
  try {
    const html = await (await app.request('/')).text();
    assert.match(html, /value="untitled\.txt"/);
    assert.match(html, /<option value="auto" selected>Auto detect<\/option>/);
    assert.match(html, /data-filename/);
    assert.match(html, /data-lang-hint/);
    assert.match(html, /data-default-title="untitled\.txt"/);
  } finally {
    await app.close();
  }
});

test('web create resolves auto from the filename, manual choice still wins', async () => {
  const app = await createApp();
  try {
    const fromExt = await app.request('/p', {
      body: form({ title: 'app.py', content: '{"looks":"json"}', language: 'auto', expiration: '1w' }),
    });
    assert.equal(fromExt.status, 303);
    const extRow = await app.db.get('SELECT language FROM pastes WHERE id = ?', [pasteIdFrom(fromExt)]);
    assert.equal(extRow.language, 'python');

    const view = await app.request(`/p/${pasteIdFrom(fromExt)}`);
    const viewHtml = await view.text();
    assert.match(viewHtml, /ext-chip[^>]*>\.py</);
    assert.match(viewHtml, /Python/);

    const manual = await app.request('/p', {
      body: form({ title: 'app.py', content: 'x = 1', language: 'rust', expiration: '1w' }),
    });
    const manualRow = await app.db.get('SELECT language FROM pastes WHERE id = ?', [pasteIdFrom(manual)]);
    assert.equal(manualRow.language, 'rust');

    const fromContent = await app.request('/p', {
      body: form({ title: 'no extension here', content: '{"a":1}', language: 'auto', expiration: '1w' }),
    });
    const contentRow = await app.db.get('SELECT language FROM pastes WHERE id = ?', [pasteIdFrom(fromContent)]);
    assert.equal(contentRow.language, 'json');
  } finally {
    await app.close();
  }
});

test('API create/fork/update resolve auto from the filename', async () => {
  const app = await createApp();
  try {
    await registerUser(app, 'fileu');
    const key = await createApiKeyFor(app, 'fileu');
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    const created = await app.request('/api/pastes', {
      method: 'POST',
      headers,
      body: jsonBody({ title: 'main.rs', content: 'nothing special here', language: 'auto' }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).language, 'rust');

    const meta = await (await app.request('/api/meta')).json();
    assert.equal(meta.defaultFilename, 'untitled.txt');
    assert.equal(meta.filenameExtensions.py, 'python');
    assert.equal(meta.filenameExtensions.rs, 'rust');

    const id = (await app.db.get('SELECT id FROM pastes WHERE title = ?', ['main.rs'])).id;
    const forked = await app.request(`/api/pastes/${id}/fork`, {
      method: 'POST',
      headers,
      body: jsonBody({ title: 'copy.sql', language: 'auto' }),
    });
    assert.equal(forked.status, 201);
    assert.equal((await forked.json()).language, 'sql');

    const updated = await app.request(`/api/pastes/${id}`, {
      method: 'PATCH',
      headers,
      body: jsonBody({ title: 'renamed.go', language: 'auto' }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).language, 'go');
  } finally {
    await app.close();
  }
});

test('downloads keep a real extension and gain .txt otherwise', async () => {
  const app = await createApp();
  try {
    const withExt = await app.request('/p', {
      body: form({ title: 'app.py', content: 'x = 1', language: 'python', expiration: '1w' }),
    });
    const id = pasteIdFrom(withExt);
    const raw = await app.request(`/p/${id}/raw?download=1`);
    assert.match(raw.headers.get('content-disposition'), /attachment; filename="app\.py"/);

    const plain = await app.request('/p', {
      body: form({ title: 'hello world', content: 'x = 1', language: 'plaintext', expiration: '1w' }),
    });
    const plainRaw = await app.request(`/p/${pasteIdFrom(plain)}/raw?download=1`);
    assert.match(plainRaw.headers.get('content-disposition'), /attachment; filename="hello-world\.txt"/);
  } finally {
    await app.close();
  }
});

test('missing pastes get the friendly Paste not found page', async () => {
  const app = await createApp();
  try {
    const missing = await app.request('/p/AAAAAAAA');
    assert.equal(missing.status, 404);
    const html = await missing.text();
    assert.match(html, /Paste Not Found/);
    assert.match(html, /gone-numeral/);
    assert.match(html, /New paste/);
  } finally {
    await app.close();
  }
});
