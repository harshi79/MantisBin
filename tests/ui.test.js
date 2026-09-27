/** Presentation contracts and dependency-free client enhancement regressions. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createApp, form, pasteIdFrom } from './helpers.js';
import { editorPage } from '../src/views/editor.js';

const clientSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('workspace keeps one save action and every setting in the native form', async () => {
  const app = await createApp();
  try {
    const page = await (await app.request('/')).text();
    const workspace = page.match(/<form class="workspace"[\s\S]*?<\/form>/)?.[0];
    assert.ok(workspace);
    for (const name of ['title', 'content', 'language', 'font', 'font_size', 'expiration', 'burn_after', 'password']) {
      assert.match(workspace, new RegExp(`name="${name}"`));
      assert.match(workspace, new RegExp(`<label[^>]+for="${name}"`));
    }
    assert.equal((workspace.match(/type="submit"/g) || []).length, 1);
    assert.match(workspace, /<details class="settings-panel"[^>]+open>/);
    assert.match(workspace, /data-draft-restore hidden/);
    assert.match(workspace, /data-draft-clear hidden/);
    assert.match(workspace, /Shift\+Tab leaves the editor/);
    assert.doesNotMatch(page, /hero-chips|hero-cta|onclick=/);
  } finally {
    await app.close();
  }
});

test('server validation errors keep the mobile settings disclosure open', async () => {
  const app = await createApp();
  try {
    const response = await app.request('/p', { body: form({ title: 'note.txt', content: 'keep this text', password: 'abc' }) });
    assert.equal(response.status, 400);
    const page = await response.text();
    assert.match(page, /data-paste-settings data-keep-open open/);
    assert.match(page, /keep this text/);
    assert.doesNotMatch(page, /name="password"[^>]*value=/);
  } finally {
    await app.close();
  }
});

test('edit and duplicate use the same enhanced editor without touching new-paste drafts', () => {
  for (const mode of /** @type {const} */ (['edit', 'fork'])) {
    const page = String(editorPage({
      theme: 'light', user: { id: 1, username: 'owner' }, path: `/p/abc12345/${mode}`,
      mode, pasteId: 'abc12345', maxBytes: 10 * 1024 * 1024,
      values: { title: 'app.py', content: 'print("hello")', language: 'python', font: 'serif', font_size: 18, expiration: '1d', protected: true },
    }));
    assert.match(page, /data-editor-form/);
    assert.match(page, /<option value="serif" selected>/);
    assert.match(page, /<option value="18" selected>/);
    assert.doesNotMatch(page, /data-draft=|data-draft-status|data-remember/);
    assert.match(page, /href="\/p\/abc12345">Cancel/);
    if (mode === 'edit') assert.match(page, /name="remove_password"/);
  }
});

test('viewer keeps secondary actions in a no-JS disclosure and preserves labelled icons', async () => {
  const app = await createApp();
  try {
    const created = await app.request('/p', { body: form({ title: 'app.py', content: 'print("hello")' }) });
    const id = pasteIdFrom(created);
    const page = await (await app.request(`/p/${id}`)).text();
    const actions = page.match(/<details class="action-menu"[\s\S]*?<\/details>/)?.[0];
    assert.ok(actions);
    for (const suffix of ['/raw?download=1', '/fork', '/qr']) {
      assert.ok(actions.includes(`href="/p/${id}${suffix}"`));
    }
    assert.match(actions, /data-copy-location/);
    assert.match(actions, /More actions/);
    assert.doesNotMatch(actions, /data-confirm-button/, 'anonymous readers cannot delete');
    assert.match(page, /data-copy="#paste-content">[\s\S]*?data-button-label>Copy<\/span>/);
    assert.match(page, /data-wrap-toggle="#paste-content" aria-pressed="false"/);
    assert.match(page, /aria-hidden="true" focusable="false"/);
  } finally {
    await app.close();
  }
});

/** Minimal DOM surface for exercising the real client script without a framework.
 * @returns {any}
 */
function element(attributes = {}, text = '') {
  const attrs = new Map(Object.entries(attributes));
  const events = new Map();
  const classes = new Set();
  return {
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; },
    },
    focus() {},
    dispatchEvent(event) { return this.dispatch(event.type, event); },
    value: '', textContent: text, title: '',
    getAttribute: (name) => attrs.get(name) ?? null,
    hasAttribute: (name) => attrs.has(name),
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => attrs.delete(name),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (name, handler) => events.set(name, handler),
    dispatch: (name, event) => events.get(name)?.(event),
  };
}

function runClient(selectors = {}, lists = {}, globals = {}) {
  const root = element({ 'data-theme': 'auto' });
  const timers = [];
  const copied = [];
  const document = {
    documentElement: root, cookie: '',
    querySelector: (selector) => selectors[selector] || null,
    querySelectorAll: (selector) => lists[selector] || [],
    addEventListener() {},
  };
  runInNewContext(clientSource, {
    document, URL, TextEncoder, TextDecoder, Event,
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {},
    window: { location: { href: 'https://mantisbin.test/' }, isSecureContext: true, addEventListener() {} },
    navigator: { clipboard: { writeText: (value) => { copied.push(value); return Promise.resolve(); } } },
    setTimeout: (fn) => timers.push(fn), clearTimeout: (id) => { timers[id - 1] = null; },
    ...globals,
  });
  return { root, document, timers, copied };
}

test('instant theme switching updates the accessible label, tooltip and POST fallback', () => {
  const themeForm = element();
  const input = element();
  const label = element({}, 'Light');
  const button = element();
  themeForm.querySelector = (selector) => ({ 'input[name="theme"]': input, '[data-theme-label]': label, button })[selector];
  const client = runClient({}, { 'form[data-theme-form]': [themeForm] });
  for (const [theme, next] of [['light', 'dark'], ['dark', 'ocean'], ['ocean', 'auto'], ['auto', 'light']]) {
    let prevented = false;
    themeForm.dispatch('submit', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(client.root.getAttribute('data-theme'), theme);
    assert.equal(input.value, next);
    assert.equal(button.getAttribute('aria-label'), `Switch to ${next} theme`);
    assert.equal(button.title, `Switch to ${next} theme`);
    assert.match(client.document.cookie, new RegExp(`mb_theme=${theme};`));
  }
});

test('copy feedback changes only the text label, not the button icon', async () => {
  const label = element({}, 'Copy');
  const button = element({ 'data-copy': '#source' });
  button.querySelector = (selector) => selector === '[data-button-label]' ? label : null;
  // Replacing the parent's textContent would erase its SVG and other children.
  Object.defineProperty(button, 'textContent', {
    get: () => 'Copy',
    set: () => { throw new Error('The button icon was removed'); },
  });
  const source = element();
  source.value = 'exact text\nwith a newline';
  const client = runClient({ '#source': source }, { '[data-copy]': [button] });
  button.dispatch('click', { currentTarget: button });
  await Promise.resolve();
  assert.deepEqual(client.copied, [source.value]);
  assert.equal(label.textContent, 'Copied');
  assert.equal(button.getAttribute('aria-live'), 'polite');
  client.timers[0]();
  assert.equal(label.textContent, 'Copy');
});


/** @param {{ draft?: any, confirm?: () => boolean, content?: string }} options */
function editorClient({ draft = null, confirm = () => true, content = '' } = {}) {
  const editor = element();
  editor.value = content;
  const counter = element({ 'data-limit': '1024' });
  const filename = element();
  filename.value = 'untitled.txt';
  const language = element({ 'data-extensions': '{"py":"Python"}' });
  language.value = 'auto';
  const importButton = element();
  const importFile = element();
  const importStatus = element();
  const wrap = element();
  const status = element();
  const clear = element();
  const restore = element();
  const form = element({ 'data-draft': 'new', 'data-default-title': 'untitled.txt' });
  form.querySelector = (name) => ({
    '[name="title"]': filename, '[name="language"]': language,
    '[data-draft-status]': status, '[data-draft-clear]': clear, '[data-draft-restore]': restore,
  })[name] || null;
  const storage = new Map();
  const key = 'mantisbin:draft:v1';
  if (draft) storage.set(key, JSON.stringify(draft));
  const events = new Map();
  const client = runClient({
    'textarea[name="content"]': editor, '[data-counter]': counter,
    '[data-filename]': filename, 'select[name="language"][data-extensions]': language,
    '[data-import-button]': importButton, '[data-import-file]': importFile,
    '[data-import-status]': importStatus, '[data-editor-wrap]': wrap,
    'form[data-remember]': form,
  }, {}, {
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    window: {
      location: { href: 'https://mantisbin.test/' }, TextDecoder, confirm,
      addEventListener: (name, fn) => events.set(name, fn),
    },
  });
  return { ...client, editor, filename, language, importButton, importFile, importStatus, wrap,
    status, clear, restore, form, storage, key, events,
    flush() { const pending = client.timers.splice(0); pending.forEach((fn) => fn?.()); },
  };
}

test('local file import populates content and filename, resets detection and schedules a draft', async () => {
  const c = editorClient();
  c.language.value = 'javascript';
  c.importFile.files = [new File(['print("hello")'], 'hello.py')];
  await c.importFile.dispatch('change');
  assert.equal(c.editor.value, 'print("hello")');
  assert.equal(c.filename.value, 'hello.py');
  assert.equal(c.language.value, 'auto');
  assert.equal(c.importButton.disabled, false);
  assert.equal(c.importFile.value, '');
  assert.match(c.importStatus.textContent, /Nothing is uploaded until you save/);
  c.flush();
  assert.equal(JSON.parse(c.storage.get(c.key)).title, 'hello.py');
});

test('file import rejects oversized, invalid UTF-8, binary and empty files without changing text', async () => {
  for (const file of [
    new File(['x'.repeat(1025)], 'large.txt'),
    new File([new Uint8Array([0xff, 0xfe])], 'invalid.txt'),
    new File(['a\0b'], 'binary.bin'),
    new File(['  '], 'empty.txt'),
  ]) {
    const c = editorClient({ content: 'keep me' });
    c.importFile.files = [file];
    await c.importFile.dispatch('change');
    assert.equal(c.editor.value, 'keep me');
    assert.equal(c.filename.value, 'untitled.txt');
    assert.equal(c.importStatus.getAttribute('data-error'), 'true');
    assert.equal(c.importButton.disabled, false);
  }
});

test('oversized files are rejected before reading them into memory', async () => {
  const c = editorClient();
  c.importFile.files = [{ name: 'large.txt', size: 2048, arrayBuffer() { throw new Error('must not read'); } }];
  await c.importFile.dispatch('change');
  assert.match(c.importStatus.textContent, /too large/);
});

test('cancelling import protects current work, including changes made while a file is read', async () => {
  const c = editorClient({ confirm: () => false });
  let finish;
  c.importFile.files = [{ name: 'note.txt', size: 4, arrayBuffer: () => new Promise((resolve) => { finish = resolve; }) }];
  const reading = c.importFile.dispatch('change');
  c.editor.value = 'typed while reading';
  finish(new TextEncoder().encode('file').buffer);
  await reading;
  assert.equal(c.editor.value, 'typed while reading');
  assert.match(c.importStatus.textContent, /cancelled/);
});

test('editor wrap is an accessible toggle and does not modify the content', () => {
  const c = editorClient({ content: 'a long line' });
  c.wrap.dispatch('click');
  assert.equal(c.wrap.getAttribute('aria-pressed'), 'true');
  assert.equal(c.editor.classList.contains('editor-wrapped'), true);
  c.wrap.dispatch('click');
  assert.equal(c.wrap.getAttribute('aria-pressed'), 'false');
  assert.equal(c.editor.value, 'a long line');
});

test('visiting and leaving an untouched editor does not erase a recoverable draft', () => {
  const draft = { title: 'keep.py', content: 'important work' };
  const c = editorClient({ draft });
  c.events.get('pagehide')();
  assert.deepEqual(JSON.parse(c.storage.get(c.key)), draft);
  assert.match(c.status.textContent, /Unsaved draft found/);
});

test('clearing a draft cancels queued autosave and pagehide cannot recreate it', () => {
  const c = editorClient({ content: 'unsaved text' });
  c.editor.dispatch('input');
  c.clear.dispatch('click');
  c.flush();
  c.events.get('pagehide')();
  assert.equal(c.storage.has(c.key), false);
  c.editor.value = 'new work';
  c.editor.dispatch('input');
  c.flush();
  assert.equal(JSON.parse(c.storage.get(c.key)).content, 'new work');
});

test('filename/settings changes schedule autosave and back navigation re-enables it', () => {
  const c = editorClient({ content: 'draft' });
  c.filename.value = 'renamed.txt';
  c.form.dispatch('input');
  c.form.dispatch('submit');
  assert.equal(JSON.parse(c.storage.get(c.key)).title, 'renamed.txt');
  c.events.get('pageshow')();
  c.editor.value = 'after going back';
  c.editor.dispatch('input');
  c.flush();
  assert.equal(JSON.parse(c.storage.get(c.key)).content, 'after going back');
});

test('optional thumbnails use a native disclosure and existing images/errors stay visible', () => {
  for (const variant of ['empty', 'image', 'errors']) {
    const page = String(editorPage({
      theme: 'light', user: null, path: '/', mode: 'create', maxBytes: 1024,
      values: { title: 'untitled.txt', content: '', language: 'auto', font: 'mono', font_size: 14,
        expiration: '1w', thumbnail_url: variant === 'image' ? 'https://example.com/image.png' : '' },
      errors: variant === 'errors' ? ['Invalid image URL'] : [],
    }));
    const disclosure = page.match(/<details class="thumbnail-options"[^>]*>/)?.[0];
    assert.ok(disclosure);
    assert.equal(disclosure.includes('open'), variant !== 'empty');
    assert.match(page, /data-import-button hidden/);
    assert.match(page, /data-editor-wrap aria-pressed="false" hidden/);
    assert.match(page, /Anyone with the link can see the thumbnail/);
  }
});
