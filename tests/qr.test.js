import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalPasteUrl, normalizeLineAnchor, qrMatrix, qrSvg } from '../src/lib/qr.js';
import { createApp, form, pasteIdFrom } from './helpers.js';

test('canonical QR URLs contain only the paste path and an optional safe line anchor', () => {
  assert.equal(canonicalPasteUrl('https://mantisbin.test/', 'Abc12345'), 'https://mantisbin.test/p/Abc12345');
  assert.equal(canonicalPasteUrl('https://mantisbin.test///', 'Abc12345', '#line-7'), 'https://mantisbin.test/p/Abc12345#line-7');
  assert.equal(canonicalPasteUrl('https://mantisbin.test', 'Abc12345', '7'), 'https://mantisbin.test/p/Abc12345#line-7');
  assert.equal(canonicalPasteUrl('https://mantisbin.test', 'A&B"<>', 'javascript:alert(1)'), 'https://mantisbin.test/p/A%26B%22%3C%3E');
  assert.equal(normalizeLineAnchor('#line-0007'), '', 'anchors are normalized from line selections, not arbitrary fragments');
  assert.equal(normalizeLineAnchor('line-8'), 'line-8');
  assert.equal(normalizeLineAnchor('0'), '');
});

test('the local encoder makes a QR image without embedding raw URL markup', () => {
  const url = 'https://mantisbin.test/p/Abc12345#line-3';
  const matrix = qrMatrix(url);
  assert.ok(matrix.length >= 21);
  assert.equal(matrix.length % 4, 1);
  assert.match(qrSvg(url), /^<svg /);
  assert.doesNotMatch(qrSvg(url), /mantisbin\.test|<script|onerror/i);
});

test('paste views offer a no-JS QR action and the page has an escaped URL fallback', async () => {
  const app = await createApp();
  try {
    const created = await app.request('/p', {
      body: form({ title: '<QR & share>', content: 'secret body', language: 'plaintext', expiration: '1w' }),
    });
    const id = pasteIdFrom(created);
    const view = await app.request(`/p/${id}`);
    const viewHtml = await view.text();
    assert.match(viewHtml, new RegExp(`href="/p/${id}/qr"`));
    assert.match(viewHtml, /data-qr-link/);
    assert.doesNotMatch(viewHtml, /onclick=/i);

    const page = await app.request(`/p/${id}/qr?line=2`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /QR code/);
    assert.match(pageHtml, new RegExp(`https:\\/\\/mantisbin\\.test\\/p\\/${id}#line-2`));
    assert.match(pageHtml, new RegExp(`/p/${id}/qr\.svg\\?line=2&amp;download=1`));
    assert.match(pageHtml, /&lt;QR &amp; share&gt;/);
    assert.doesNotMatch(pageHtml, /secret body/);

    const image = await app.request(`/p/${id}/qr.svg?line=2&download=1`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /image\/svg/);
    assert.match(image.headers.get('content-disposition'), /attachment; filename="mantisbin-[A-Za-z0-9]+-qr\.svg"/);
    assert.match(await image.text(), /<svg /);
  } finally {
    await app.close();
  }
});

test('QR links disappear with expired pastes and do not burn one-time reads', async () => {
  const app = await createApp();
  try {
    const expiring = await app.request('/p', { body: form({ title: 'expires', content: 'gone', expiration: '1h' }) });
    const expiringId = pasteIdFrom(expiring);
    await app.db.run('UPDATE pastes SET expires_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - 1, expiringId]);
    assert.equal((await app.request(`/p/${expiringId}/qr`)).status, 404);
    assert.equal((await app.request(`/p/${expiringId}/qr.svg`)).status, 404);

    const oneTime = await app.request('/p', { body: form({ title: 'one time', content: 'still there', burn_after: 'view' }) });
    const oneTimeId = pasteIdFrom(oneTime);
    const qr = await app.request(`/p/${oneTimeId}/qr`);
    assert.equal(qr.status, 200);
    assert.equal((await app.db.get('SELECT burned FROM pastes WHERE id = ?', [oneTimeId])).burned, 0);
    assert.equal((await app.request(`/p/${oneTimeId}`)).status, 200);
    assert.equal((await app.request(`/p/${oneTimeId}`)).status, 404);
  } finally {
    await app.close();
  }
});

test('protected QR pages reveal no protected title, content or passphrase before unlock', async () => {
  const app = await createApp();
  try {
    const passphrase = 'qr-secret-code';
    const title = 'private handoff title';
    const content = 'private handoff content';
    const created = await app.request('/p', {
      body: form({ title, content, password: passphrase, expiration: '1w' }),
    });
    const id = pasteIdFrom(created);
    const locked = await app.request(`/p/${id}/qr`);
    assert.equal(locked.status, 200);
    const lockedHtml = await locked.text();
    assert.match(lockedHtml, /protected paste/);
    assert.doesNotMatch(lockedHtml, new RegExp(title));
    assert.doesNotMatch(lockedHtml, new RegExp(content));
    assert.doesNotMatch(lockedHtml, new RegExp(passphrase));
    assert.match(lockedHtml, new RegExp(`/p/${id}`));

    const image = await app.request(`/p/${id}/qr.svg`);
    assert.equal(image.status, 200);
    assert.doesNotMatch(await image.text(), new RegExp(content));
  } finally {
    await app.close();
  }
});
