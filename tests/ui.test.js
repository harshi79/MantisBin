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
  return {
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

function runClient(selectors = {}, lists = {}) {
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
    document, URL, TextEncoder,
    window: { location: { href: 'https://mantisbin.test/' }, isSecureContext: true },
    navigator: { clipboard: { writeText: (value) => { copied.push(value); return Promise.resolve(); } } },
    setTimeout: (fn) => timers.push(fn), clearTimeout() {},
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
