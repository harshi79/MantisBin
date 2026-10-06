import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp, form, ORIGIN, registerUser, withWorkersPbkdf2Cap } from './helpers.js';
import {
  ACCENT_DEFAULT,
  ACCENT_PRESETS,
  badgesFor,
  detectPlatform,
  effectDuration,
  effectStrength,
  isCustomised,
  linksFromForm,
  normalizeAccentPreset,
  normalizeEffectValue,
  normalizeHex,
  normalizeStatusEmoji,
  parseProfileLinks,
  PROFILE_LIMITS,
  profileView,
  readProfileInput,
  resolveStatus,
  safeProfileLink,
  tagIdFromLabel,
  themeCss,
  themeHash,
} from '../src/lib/profiles.js';
import { NAME_EFFECTS, nameEffectClass } from '../src/lib/nameEffects.js';

const PASSWORD = 'correct-horse-1';

/** Sign in and hand back the response (which carries the session cookie). */
function signIn(app, username, password = PASSWORD) {
  return app.request('/login', {
    method: 'POST',
    body: form({ username, password }),
    jar: username,
  });
}

/** Create a paste through the plain HTML form, as the given jar. */
async function newPaste(app, jar, fields = {}) {
  const response = await app.request('/p', {
    method: 'POST',
    body: form({
      title: 'Paste',
      content: 'hello world',
      language: 'plaintext',
      visibility: 'unlisted',
      expiration: 'never',
      ...fields,
    }),
    jar,
  });
  const location = response.headers.get('location') || '';
  const id = /\/p\/([A-Za-z0-9]+)/.exec(location)?.[1];
  assert.ok(id, `expected a paste id in ${location}`);
  return id;
}

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

test('normalizeHex accepts #rgb, #rrggbb and rejects everything else', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('#8B5CF6'), '#8b5cf6');
  assert.equal(normalizeHex('  #22d3ee  '), '#22d3ee');
  assert.equal(normalizeHex('blue'), ACCENT_DEFAULT);
  assert.equal(normalizeHex('#12345'), ACCENT_DEFAULT);
  assert.equal(normalizeHex(null), ACCENT_DEFAULT);
  assert.equal(normalizeHex(42), ACCENT_DEFAULT);
  assert.equal(normalizeHex('red; }'), ACCENT_DEFAULT);
  assert.equal(normalizeHex('nope', '#000000'), '#000000');
  // No hex means no CSS-injection surface: only [0-9a-f] can leave this function.
  assert.match(normalizeHex('#a1b2c3'), /^#[0-9a-f]{6}$/);
});

test('accent presets resolve by id and by hex; the default is the first one', () => {
  assert.equal(ACCENT_PRESETS[0].hex, ACCENT_DEFAULT);
  assert.equal(normalizeAccentPreset('violet'), 'violet');
  assert.equal(normalizeAccentPreset(ACCENT_DEFAULT), 'violet');
  assert.equal(normalizeAccentPreset('nonexistent'), null);
  assert.equal(normalizeAccentPreset(null), null);
  for (const preset of ACCENT_PRESETS) {
    assert.equal(normalizeAccentPreset(preset.hex), preset.id);
  }
});

test('effect controls clamp to 0–100 and the duration curve is monotonic', () => {
  assert.equal(normalizeEffectValue(-50, 50), 0);
  assert.equal(normalizeEffectValue(500, 50), 100);
  assert.equal(normalizeEffectValue(undefined, 50), 50);
  assert.equal(effectDuration(100), 1.6);
  assert.ok(effectDuration(0) > effectDuration(100));
  assert.ok(effectStrength(100) > effectStrength(10));
});

test('normalizeStatusEmoji allows up to three graphemes and one shortcode', () => {
  assert.equal(normalizeStatusEmoji('🔥'), '🔥');
  assert.equal(normalizeStatusEmoji('🔥✨🚀'), '🔥✨🚀');
  assert.equal(normalizeStatusEmoji(':FIRE:'), ':fire:');
  assert.equal(normalizeStatusEmoji('a\u0000b'), '');
  assert.equal(normalizeStatusEmoji('<script>'), '');
  assert.equal(normalizeStatusEmoji('javascript:alert(1)'), '');
});

test('safeProfileLink insists on https and drops credentials', () => {
  assert.equal(safeProfileLink('github.com/a'), 'https://github.com/a');
  assert.equal(safeProfileLink('https://x.test/a'), 'https://x.test/a');
  assert.equal(safeProfileLink('http://insecure.test/a'), null);
  assert.equal(safeProfileLink('javascript:alert(1)'), null);
  assert.equal(safeProfileLink('https://user:pass@x.test/'), null);
  assert.equal(safeProfileLink(''), null);
  assert.equal(safeProfileLink('not a url at all'), null);
  assert.equal(safeProfileLink(`https://x.test/${'a'.repeat(600)}`), null);
});

test('parseProfileLinks dedupes, caps at the limit and labels by platform', () => {
  const raw = JSON.stringify([
    { url: 'https://github.com/me' },
    { url: 'https://github.com/me' },
    { url: 'http://nope.test/a' },
    { url: 't.me/me' },
    ...Array.from({ length: 5 }, (_, index) => ({ url: `https://x.test/${index}` })),
  ]);
  const links = parseProfileLinks(raw);
  assert.equal(links.length, PROFILE_LIMITS.links);
  assert.equal(links[0].platform, 'github');
  assert.equal(links[1].platform, 'telegram');
  assert.equal(links[1].label, 'Telegram');
  assert.equal(new Set(links.map((link) => link.url)).size, links.length);
  assert.deepEqual(parseProfileLinks('not json'), []);
  assert.deepEqual(parseProfileLinks(null), []);
});

test('detectPlatform knows the big platforms and refuses lookalikes', () => {
  assert.equal(detectPlatform('https://github.com/a').id, 'github');
  assert.equal(detectPlatform('https://github.com.evil.test/a').id, 'generic');
  assert.equal(detectPlatform('https://x.com/a').id, 'x');
  assert.equal(detectPlatform('https://twitter.com/a').id, 'x');
  assert.equal(detectPlatform('https://youtu.be/abc').id, 'youtube');
  assert.equal(detectPlatform('totally-not-a-url').id, 'generic');
});

// ---------------------------------------------------------------------------
// Form → stored values
// ---------------------------------------------------------------------------

test('readProfileInput normalises a good form', () => {
  const { errors, values } = readProfileInput({
    display_name: 'Harsh',
    bio: 'hello <world>',
    accent: '#22d3ee',
    name_effect: 'neon',
    effect_speed: '70',
    effect_intensity: '40',
    banner_type: 'gradient',
    banner_url: '',
    status_emoji: '🔥',
    status_text: 'shipping',
    link_url: ['github.com/harsh', 'https://t.me/harsh'],
    link_label: ['GitHub', ''],
  });
  assert.deepEqual(errors, []);
  assert.equal(values.displayName, 'Harsh');
  assert.equal(values.accent, '#22d3ee');
  assert.equal(values.nameEffect, 'neon');
  assert.equal(values.effectSpeed, 70);
  assert.equal(values.bannerType, 'gradient');
  assert.equal(values.statusEmoji, '🔥');
  assert.equal(values.links.length, 2);
  assert.equal(values.links[0].label, 'GitHub');
  // Everything the form produces is re-validated on the way out.
  const view = profileView({
    display_name: values.displayName,
    bio: values.bio,
    bio_enabled: 1,
    accent: values.accent,
    name_effect: values.nameEffect,
    banner_type: values.bannerType,
    status_emoji: values.statusEmoji,
    status_text: values.statusText,
    links: JSON.stringify(values.links),
  });
  assert.equal(view.accent, '#22d3ee');
  assert.equal(view.bannerType, 'gradient');
  assert.equal(view.links.length, 2);
  assert.equal(view.links[0].platform, 'github');
});

test('readProfileInput reports every bad field and degrades the accent', () => {
  const { errors, values } = readProfileInput({
    bio: 'y'.repeat(400),
    accent: 'chartreuse',
    name_effect: 'wave',
    banner_url: 'http://insecure.test/b.jpg',
    status_emoji: '🔥✨🚀🎉',
    status_text: 'x'.repeat(90),
    link_url: ['ftp://nope', 'https://ok.test/1'],
    link_label: ['', ''],
  });
  assert.ok(errors.some((error) => /at most 280/.test(error)), 'bio length');
  assert.ok(errors.some((error) => /https image URL/.test(error)), 'banner scheme');
  assert.ok(errors.some((error) => /unique https URL/.test(error)), 'link normalisation');
  assert.ok(errors.some((error) => /name effect/.test(error)), 'unknown effect');
  assert.ok(errors.length >= 4);
  // A junk accent is not an error: it degrades to the default, never to raw CSS.
  assert.equal(values.accent, ACCENT_DEFAULT);
});

// ---------------------------------------------------------------------------
// The generated stylesheet
// ---------------------------------------------------------------------------

test('themeCss escapes hard and only emits normalised values', async () => {
  const profile = profileView({
    accent: '#f472b6',
    name_effect: 'gold',
    effect_speed: 70,
    effect_intensity: 0,
    banner_type: 'image',
    banner_url: 'https://cdn.test/banner.png',
    status_text: 'hi',
  });
  const css = themeCss(profile, 'someone');
  assert.match(css, /--accent: #f472b6;/);
  assert.match(css, /--name-speed: 3\.8s;/);
  assert.match(css, /--name-strength: 0\.25;/);
  assert.match(css, /url\("https:\/\/cdn\.test\/banner\.png"\)/);
  assert.doesNotMatch(css, /<|>/);

  const hostile = themeCss(
    profileView({ accent: 'red; } body { display: none }', banner_url: 'https://x.test/a"});}body{display:none' }),
    'someone',
  );
  assert.doesNotMatch(hostile, /body\s*\{/);
  assert.match(hostile, /url\("https:\/\/x\.test\/a%22%7D\)/);
  // Exactly the two delimiters of one url(): the injected quote is escaped.
  assert.equal((hostile.match(/"/g) || []).length, 2);
  assert.match(hostile, new RegExp(`--accent: ${ACCENT_DEFAULT};`));
  assert.ok(await themeHash(profile));
  assert.notEqual(await themeHash(profile), await themeHash(profileView({ accent: '#f472b6' })));
});

// ---------------------------------------------------------------------------
// Pages (HTTP)
// ---------------------------------------------------------------------------

test('GET /u/:username/theme.css is versioned for the public and no-store for previews', async () => {
  const app = await createApp();
  await registerUser(app, 'cust04');
  const saved = await app.request('/me/profile', {
    method: 'POST',
    body: form({
      bio: 'theme test',
      accent: '#fb7185',
      name_effect: 'gold',
      effect_speed: '100',
      effect_intensity: '10',
    }),
    jar: 'cust04',
  });
  assert.equal(saved.status, 303);

  const page = await (await app.request('/u/cust04')).text();
  const href = /\/u\/cust04\/theme\.css\?v=([a-z0-9]+)/.exec(page);
  assert.ok(href, 'the profile links its stylesheet');
  const version = href[1];

  const sheet = await app.request(`/u/cust04/theme.css?v=${version}`);
  assert.equal(sheet.status, 200);
  assert.match(sheet.headers.get('content-type') || '', /text\/css/);
  const css = await sheet.text();
  assert.match(css, /--accent: #fb7185;/);
  assert.match(css, /--name-speed: 1\.6s;/);
  assert.match(sheet.headers.get('cache-control') || '', /max-age=31536000/);

  // The version tag is the only key: junk versions are simply not immutable.
  const junk = await app.request('/u/cust04/theme.css?v=deadbeef');
  assert.ok(!/max-age=31536000/.test(junk.headers.get('cache-control') || ''));

  const preview = await app.request('/u/cust04/theme.css?preview=1&accent=%23f472b6');
  assert.ok(!/#f472b6/.test(await preview.text()));

  const owner = await app.request(
    `/u/cust04/theme.css?preview=1&accent=%23f472b6&effect=gold&speed=100&intensity=10`,
    { jar: 'cust04' },
  );
  assert.match(owner.headers.get('cache-control') || '', /no-store/);
  assert.match(await owner.text(), /--accent: #f472b6;/);

  const hostile = await app.request(
    `/u/cust04/theme.css?preview=1&accent=red;}+body{display:none`,
    { jar: 'cust04' },
  );
  const hostileCss = await hostile.text();
  assert.doesNotMatch(hostileCss, /body\{/);
  assert.match(hostileCss, new RegExp(`--accent: ${ACCENT_DEFAULT};`));
});

test('only the anonymous copy of a public page is cacheable', async () => {
  const app = await createApp();
  await registerUser(app, 'cust23');
  await registerUser(app, 'cust24');

  // Signed out: the discovery pages are cacheable for crawlers and readers.
  assert.equal((await app.request('/u/cust23')).headers.get('cache-control'), 'public, max-age=60');
  assert.equal((await app.request('/docs')).headers.get('cache-control'), 'public, max-age=300');

  // Signed in, the same pages carry the viewer's own follow state and bell, so
  // they must never be shared between visitors.
  assert.equal((await app.request('/u/cust23', { jar: 'cust24' })).headers.get('cache-control'), 'private, no-store');
  assert.equal((await app.request('/u/cust23', { jar: 'cust23' })).headers.get('cache-control'), 'private, no-store');
  assert.equal((await app.request('/docs', { jar: 'cust23' })).headers.get('cache-control'), 'private, no-store');

  // A public profile is still an indexable discovery page — only its cacheable
  // copy is restricted to signed-out readers.
  for (const jar of [undefined, 'cust23', 'cust24']) {
    const profile = await app.request('/u/cust23', jar ? { jar } : {});
    assert.notEqual(profile.headers.get('x-robots-tag'), 'noindex, nofollow', `profile as ${jar || 'guest'}`);
  }

  // The JSON machine endpoints are noindex like the rest of the API surface.
  for (const path of ['/api/health', '/api/meta']) {
    assert.equal((await app.request(path)).headers.get('x-robots-tag'), 'noindex, nofollow', path);
  }
});

test('GET /u/:username renders saved fields, caps and escaping', async () => {
  const app = await createApp();
  await registerUser(app, 'cust05');
  const saved = await app.request('/me/profile', {
    method: 'POST',
    body: form({
      display_name: 'Test <b>Name</b>',
      bio: 'a nicely escaped bio </p><img src=x onerror=alert(1)>',
      accent: '#34d399',
      name_effect: 'gradient-flow',
      status_emoji: '🔥',
      status_text: 'shipping',
      link_url: ['https://github.com/cust05'],
      link_label: ['GitHub'],
    }),
    jar: 'cust05',
  });
  assert.equal(saved.status, 303);
  const html = await (await app.request('/u/cust05')).text();
  assert.match(html, /Test &lt;b&gt;Name&lt;\/b&gt;/);
  // The customisation is applied by the same-origin sheet, never inline.
  assert.doesNotMatch(html, /#34d399/);
  const sheet = await (await app.request('/u/cust05/theme.css')).text();
  assert.match(sheet, /--accent: #34d399;/);
  assert.match(html, /fx name-gradient-flow/);
  assert.match(html, /🔥/);
  assert.match(html, /https:\/\/github\.com\/cust05/);
  assert.match(html, /link-github/);
  assert.match(html, /badge-stylist/);
  // The only <img> on the page is our own avatar.
  const images = [...html.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(images.length, 1, `unexpected image markup: ${images.join(' | ')}`);
  assert.match(images[0], /\/u\/cust05\/avatar\.svg/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the owner-only customiser is behind a session and previews unsaved values', async () => {
  const app = await createApp();
  await registerUser(app, 'cust06');
  const anonymous = await app.request('/me/profile');
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/login?next=%2Fme%2Fprofile');

  const page = await app.request('/me/profile', { jar: 'cust06' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-preview-hero/);
  assert.match(html, /data-link-add/);
  assert.match(html, /data-banner-url/);
  assert.match(html, /data-accent-input/);
  assert.match(html, /data-effect-select/);
  assert.match(html, /data-profile-form/);
  assert.match(html, /<optgroup label="Neon &amp; glow">/);
});

test('profile stats count unique visitors and the owner is not one of them', async () => {
  const app = await createApp();
  await registerUser(app, 'cust07');
  await registerUser(app, 'cust08');
  await app.request('/u/cust07', { ip: '10.0.0.1' });
  await app.request('/u/cust07', { ip: '10.0.0.1' });
  const asCust08 = await (await app.request('/u/cust07', { jar: 'cust08', ip: '10.0.0.2' })).text();
  assert.match(asCust08, /<b>2<\/b> profile views/);
  const asOwner = await (await app.request('/u/cust07', { jar: 'cust07' })).text();
  assert.match(asOwner, /<b>2<\/b> profile views/);
  assert.doesNotMatch(asOwner, /action="\/u\/cust07\/follow"/);
});

test('pinned pastes lead the profile and the pin cap is enforced', async () => {
  const app = await createApp();
  await registerUser(app, 'cust09');
  const ids = [];
  for (const index of [0, 1, 2]) {
    ids.push(await newPaste(app, 'cust09', { title: `Pinned ${index}`, visibility: 'public' }));
  }
  // Pinned, newest first — the profile is a curated shop window, not a feed.
  await newPaste(app, 'cust09', { title: 'Hidden', visibility: 'unlisted' });
  for (const id of [ids[0], ids[2]]) {
    const pinned = await app.request(`/me/pastes/${id}/pin`, { method: 'POST', body: form({ pinned: '1' }), jar: 'cust09' });
    assert.equal(pinned.status, 303);
  }
  const profile = await (await app.request('/u/cust09')).text();
  const order = [...profile.matchAll(/list-title" href="\/p\/([A-Za-z0-9]+)"/g)].map((match) => match[1]);
  // Pastes created in the same second share `created_at`, so only the pin
  // priority is contractual: the two pinned pastes lead, in either order.
  assert.deepEqual([...order.slice(0, 2)].sort(), [ids[0], ids[2]].sort());
  assert.equal(order[2], ids[1]);
  assert.match(profile, /badge-pin/);
  assert.equal(profile.includes(ids[3]), false);

  const mine = await (await app.request('/me', { jar: 'cust09' })).text();
  assert.match(mine, new RegExp(`/me/pastes/${ids[2]}/pin`));

  // Three is the cap: fill it, then watch the fourth pin bounce.
  const third = await app.request(`/me/pastes/${ids[1]}/pin`, { method: 'POST', body: form({ pinned: '1' }), jar: 'cust09' });
  assert.equal(third.status, 303);
  const extra = await newPaste(app, 'cust09', { title: 'Extra', visibility: 'public' });
  const refused = await app.request(`/me/pastes/${extra}/pin`, { method: 'POST', body: form({ pinned: '1' }), jar: 'cust09' });
  assert.equal(refused.status, 303);
  assert.match(refused.headers.get('location') || '', /\?pin=limit$/);
  assert.equal((await app.db.get('SELECT pinned FROM pastes WHERE id = ?', [extra])).pinned, 0);

  const off = await app.request(`/me/pastes/${ids[0]}/pin`, { method: 'POST', body: form({ pinned: '0' }), jar: 'cust09' });
  assert.equal(off.status, 303);
  const row = await app.db.get('SELECT pinned FROM pastes WHERE id = ?', [ids[0]]);
  assert.equal(row.pinned, 0);
});

test('a paste can only be pinned by its owner', async () => {
  const app = await createApp();
  await registerUser(app, 'cust10');
  await registerUser(app, 'cust11');
  const id = await newPaste(app, 'cust10', { title: 'Mine', visibility: 'public' });
  const stolen = await app.request(`/me/pastes/${id}/pin`, { method: 'POST', body: form({ pinned: '1' }), jar: 'cust11' });
  assert.equal(stolen.status, 403);
  const row = await app.db.get('SELECT pinned FROM pastes WHERE id = ?', [id]);
  assert.equal(row.pinned, 0);
});

test('profile links render as rel="me" chips and reject javascript: URLs', async () => {
  const app = await createApp();
  await registerUser(app, 'cust12');
  const saved = await app.request('/me/profile', {
    method: 'POST',
    body: form({
      link_url: ['https://github.com/cust12', 'https://t.me/cust12'],
      link_label: ['GitHub', 'Telegram'],
    }),
    jar: 'cust12',
  });
  assert.equal(saved.status, 303);
  const html = await (await app.request('/u/cust12')).text();
  assert.match(html, /rel="me noopener noreferrer nofollow"/);
  assert.match(html, /link-github/);
  assert.match(html, /link-telegram/);
  const rejected = await app.request('/me/profile', {
    method: 'POST',
    body: form({ link_url: ['javascript:alert(1)'], link_label: ['bad'] }),
    jar: 'cust12',
  });
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /unique https URL/);
  assert.doesNotMatch(await (await app.request('/u/cust12')).text(), /javascript:/);
  const links = linksFromForm({ link_url: ['a', 'b'], link_label: ['A'] });
  assert.equal(links.length, 2);
  assert.equal(links[1].label, '');
});

// ---------------------------------------------------------------------------
// Pure helpers used by the pages above
// ---------------------------------------------------------------------------

test('profileView refuses junk rows and keeps defaults', () => {
  const view = profileView({
    display_name: '<script>alert(1)</script>ok',
    bio: 'bio',
    bio_enabled: 0,
    accent: 'not-a-colour',
    name_effect: 'nope',
    banner_url: 'javascript:alert(1)',
    banner_type: 'gradient',
    status_emoji: '🔥🔥🔥🔥',
    links: '[{"url":"https://github.com/x"}]',
  });
  assert.equal(view.accent, ACCENT_DEFAULT);
  assert.equal(view.nameEffect, 'none');
  assert.equal(view.bannerUrl, '');
  assert.equal(view.bannerType, 'gradient');
  assert.equal(view.bioEnabled, false);
  assert.equal(view.statusEmoji, '');
  assert.equal(view.links.length, 1);
  // `profileView` only validates; markup removal is the renderer's job (the
  // page test above asserts the escaping), so the string survives intact.
  assert.equal(view.displayName, '<script>alert(1)</script>ok');
  assert.equal(isCustomised(profileView({})), false);
  assert.equal(isCustomised(view), true);
});

test('resolveStatus falls back to emoji text instead of a broken image', () => {
  assert.equal(resolveStatus(':wave:').kind, 'emoji');
  assert.equal(resolveStatus(':nosuchthing:').text, ':nosuchthing:');
  assert.equal(resolveStatus('').kind, 'empty');
  const index = new Map([['pack-fire', { token: ':pack-fire:', url: 'https://cdn.test/f.gif', emoji: '🔥', label: 'Fire' }]]);
  const sticker = resolveStatus(':pack-fire:', index);
  assert.equal(sticker.kind, 'sticker');
  assert.equal(sticker.sticker.url, 'https://cdn.test/f.gif');
  assert.equal(resolveStatus('✌️', new Map()).kind, 'emoji');
});

test('badges are computed from stats and deduped', () => {
  const bare = profileView({});
  const badges = badgesFor({ profile: bare, stats: { publicPastes: 10, views: 0, accountRank: 3 } });
  const ids = badges.map((badge) => badge.id);
  assert.ok(ids.includes('og'));
  assert.ok(ids.includes('prolific'));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(badgesFor({ profile: bare, stats: { publicPastes: 0, views: 0, accountRank: 999 } }).length, 0);
});

test('NAME_EFFECTS is a closed vocabulary with unique classes', () => {
  const classes = NAME_EFFECTS.map((effect) => effect.className);
  assert.equal(new Set(classes).size, classes.length);
  assert.ok(NAME_EFFECTS.length >= 40);
  assert.equal(nameEffectClass('none'), '');
  assert.equal(nameEffectClass('bogus-effect'), '');
  assert.match(nameEffectClass('neon'), /^fx name-neon$/);
  for (const effect of NAME_EFFECTS) {
    const expected = effect.className ? `fx ${effect.className}` : '';
    assert.equal(nameEffectClass(effect.id), expected, effect.id);
  }
});

// ---------------------------------------------------------------------------
// Phase-2 regressions and administration (kept from the first pass)
// ---------------------------------------------------------------------------

const ADMIN_PASSWORD = 'test-only-admin-password-123';
const ADMIN_ENV = { ADMIN_PASSWORD: ADMIN_PASSWORD };
const originHeader = { origin: ORIGIN };

function csrf(body) {
  const token = /name="csrf" value="([A-Za-z0-9]+)"/.exec(body)?.[1];
  assert.ok(token, 'the admin page must contain a CSRF token');
  return token;
}

async function signInAdmin(app, jar = 'admin') {
  const challenge = csrf(await (await app.request('/admin/login', { jar })).text());
  const response = await app.request('/admin/login', {
    jar,
    headers: originHeader,
    body: form({ csrf: challenge, password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 303);
  const token = csrf(await (await app.request('/admin', { jar })).text());
  return token;
}

test('the customiser lists every validation message instead of a lone "error"', async () => {
  const app = await createApp();
  await registerUser(app, 'cust13');
  const response = await app.request('/me/profile', {
    method: 'POST',
    body: form({
      display_name: 'Keeper',
      bio: 'b'.repeat(400),
      name_effect: 'not-an-effect',
      banner_url: 'http://insecure.test/banner.jpg',
      status_text: 's'.repeat(90),
    }),
    jar: 'cust13',
  });
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.match(html, /at most 280/);
  assert.match(html, /Pick a name effect/);
  assert.match(html, /https image URL/);
  assert.match(html, /at most 60 characters/);
  // The regression: a red box that said only “error”, with the list discarded.
  assert.doesNotMatch(html, />\s*error\s*</i);
  // A rejected save stores nothing.
  const profile = await app.db.get('SELECT bio FROM profiles WHERE user_id = (SELECT id FROM users WHERE username_key = ?)', ['cust13']);
  assert.equal(profile?.bio ?? '', '');
});

test('a repeated single field is refused rather than silently truncated', async () => {
  const app = await createApp();
  await registerUser(app, 'cust14');
  const response = await app.request('/me/profile', {
    method: 'POST',
    body: 'bio=first&bio=second&name_effect=neon',
    jar: 'cust14',
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /more than once/);
  const row = await app.db.get('SELECT bio FROM profiles WHERE user_id = (SELECT id FROM users WHERE username_key = ?)', ['cust14']);
  assert.notEqual(row?.bio, 'first');
});

test('both link rows survive the form round trip', async () => {
  const app = await createApp();
  await registerUser(app, 'cust15');
  const saved = await app.request('/me/profile', {
    method: 'POST',
    body: 'accent=%2334d399&link_url=https%3A%2F%2Fgithub.com%2Fone&link_label=One&link_url=https%3A%2F%2Ft.me%2Ftwo&link_label=Two',
    jar: 'cust15',
  });
  assert.equal(saved.status, 303);
  const html = await (await app.request('/u/cust15')).text();
  assert.match(html, /https:\/\/github\.com\/one/);
  assert.match(html, /https:\/\/t\.me\/two/);
  assert.match(html, /link-github/);
  assert.match(html, /link-telegram/);
  const row = await app.db.get('SELECT links FROM profiles WHERE user_id = (SELECT id FROM users WHERE username_key = ?)', ['cust15']);
  assert.equal(JSON.parse(row.links).length, 2);
});

test('profiles render with no APP_SECRET configured', async () => {
  const app = await createApp({ env: { APP_SECRET: undefined } });
  await registerUser(app, 'cust16');
  const saved = await app.request('/me/profile', {
    method: 'POST',
    body: form({ accent: '#fbbf24', name_effect: 'gradient-flow' }),
    jar: 'cust16',
  });
  assert.equal(saved.status, 303);
  assert.equal((await app.request('/u/cust16')).status, 200);
  assert.equal((await app.request('/u/cust16/theme.css?v=x')).status, 200);
  assert.equal((await app.request('/u/cust16/avatar.svg')).status, 200);
});

test('the avatar is deterministic, unique per account and cached forever', async () => {
  const app = await createApp();
  await registerUser(app, 'cust17');
  await registerUser(app, 'cust18');
  const first = await app.request('/u/cust17/avatar.svg');
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type') || '', /image\/svg\+xml/);
  assert.match(first.headers.get('cache-control') || '', /immutable/);
  const again = await (await app.request('/u/cust17/avatar.svg')).text();
  assert.equal(await first.text(), again);
  assert.notEqual(again, await (await app.request('/u/cust18/avatar.svg')).text());
  assert.equal((await app.request('/u/nobody/avatar.svg')).status, 404);
});

test('GET /api/users/:username exposes metadata but never content', async () => {
  const app = await createApp();
  await registerUser(app, 'cust19');
  const id = await newPaste(app, 'cust19', { title: 'Public', content: 'secret payload', visibility: 'public' });
  const response = await app.request('/api/users/cust19');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.username, 'cust19');
  assert.equal(body.pastes.length, 1);
  assert.equal(body.pastes[0].id, id);
  assert.equal('content' in body.pastes[0], false);
  assert.equal(body.status, null);
  // Lookups are case-insensitive: `username_key` is the identity.
  assert.equal((await app.request('/api/users/CUST19')).status, 200);
});

test('an administrator can award a tag and revoke it again', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  await registerUser(app, 'cust20');
  const token = await signInAdmin(app);
  const label = 'Beta tester';

  const awarded = await app.request('/admin/tags', {
    jar: 'admin',
    headers: originHeader,
    body: form({ csrf: token, action: 'award', username: 'cust20', label, color: 'emerald', effect: 'glow' }),
  });
  assert.equal(awarded.status, 303);
  assert.match(awarded.headers.get('location') || '', /\/admin\/tags\?done=1/);

  const profile = await (await app.request('/u/cust20')).text();
  assert.match(profile, /Beta tester/);
  assert.match(profile, /tag-emerald/);
  assert.match(profile, /tag-fx-glow/);

  const manager = await (await app.request('/admin/tags', { jar: 'admin' })).text();
  assert.match(manager, /Beta tester/);
  assert.match(manager, /@cust20/);

  const revoked = await app.request('/admin/tags', {
    jar: 'admin',
    headers: originHeader,
    body: form({ csrf: token, action: 'revoke', username: 'cust20', tag_id: tagIdFromLabel(label) }),
  });
  assert.equal(revoked.status, 303);
  assert.doesNotMatch(await (await app.request('/u/cust20')).text(), /tag-emerald/);
  const audit = await (await app.request('/admin/audit', { jar: 'admin' })).text();
  assert.match(audit, /tag award/);
  assert.match(audit, /tag revoke/);
});

test('tag administration is not reachable without an administrator', async () => {
  const app = await createApp({ env: ADMIN_ENV });
  await registerUser(app, 'cust21');
  const asUser = await app.request('/admin/tags', { jar: 'cust21' });
  assert.equal(asUser.status, 401);
  const post = await app.request('/admin/tags', {
    method: 'POST',
    jar: 'cust21',
    headers: originHeader,
    body: form({ csrf: 'anything', action: 'award', username: 'cust21', label: 'Sneak in' }),
  });
  assert.equal(post.status, 401);
  // `/admin` itself is the only one that bounces to the login page.
  const anonymous = await app.request('/admin/tags');
  assert.equal(anonymous.status, 401);
  const bounce = await app.request('/admin');
  assert.equal(bounce.headers.get('location'), '/admin/login');
});

test('deleting an account anonymises its pastes and keeps their URLs alive', async () => {
  const app = await createApp();
  await registerUser(app, 'cust22');
  const id = await newPaste(app, 'cust22', { title: 'Kept', content: 'still here', visibility: 'public' });
  const owned = await app.db.get('SELECT user_id FROM pastes WHERE id = ?', [id]);
  assert.ok(owned.user_id);

  const deleted = await app.request('/me/delete', {
    method: 'POST',
    body: form({ password: PASSWORD }),
    jar: 'cust22',
  });
  assert.equal(deleted.status, 200);
  const goodbye = await deleted.text();
  assert.match(goodbye, /Account deleted/);
  assert.match(goodbye, /anonymised/);

  const kept = await app.request(`/p/${id}`);
  assert.equal(kept.status, 200);
  assert.match(await kept.text(), /still here/);
  assert.equal((await app.request('/u/cust22')).status, 404);
  assert.equal((await app.request('/me', { jar: 'cust22' })).status, 303);
  const row = await app.db.get('SELECT user_id, visibility FROM pastes WHERE id = ?', [id]);
  assert.equal(row.user_id, null);
  assert.equal(row.visibility, 'unlisted');
});
