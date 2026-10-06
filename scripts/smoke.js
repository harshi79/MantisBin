/**
 * Deploy smoke test.
 *
 * Point it at a deployed Worker (or a local dev server) and it walks the
 * surfaces a real visitor touches — the editor, the docs, the public profile
 * and the JSON API — and reports what answered. Run it after every deploy:
 *
 *   npm run smoke https://mantisbin.example.workers.dev
 *   npm run smoke http://localhost:8787
 *
 * Read-only by default. `--write` adds a full paste round-trip (create → read
 * back byte-exact → delete) and needs an API key, because writes are key-gated:
 *
 *   npm run smoke https://… --write --key mb_…
 *
 * Exit code 0 means every hard check passed; warnings (a GIF provider the
 * Worker cannot reach, an empty sticker pack, admin disabled) never fail the
 * run — they are states the app is designed to degrade into. Any `✗` exits 1.
 */

import process from 'node:process';

const USAGE = `MantisBin deploy smoke test

  npm run smoke <base-url> [--write] [--key mb_…] [--timeout 10000]

  --write         also create a paste, read it back and delete it (needs --key)
  --key <mb_…>    API key used by --write (create one on /me)
  --timeout <ms>  per-request timeout, default 10000`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { base: '', write: false, key: '', timeout: 10000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--write') {
      out.write = true;
      continue;
    }
    if (arg === '--key') {
      out.key = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--key=')) {
      out.key = arg.slice('--key='.length);
      continue;
    }
    if (arg === '--timeout') {
      out.timeout = Number(argv[i + 1]) || out.timeout;
      i += 1;
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      out.timeout = Number(arg.slice('--timeout='.length)) || out.timeout;
      continue;
    }
    if (!arg.startsWith('-') && !out.base) {
      out.base = arg;
      continue;
    }
    console.error(`Unknown argument: ${arg}\n\n${USAGE}`);
    process.exit(2);
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const base = options.base.replace(/\/+$/, '');
if (!base) {
  console.error(USAGE);
  process.exit(2);
}

let passed = 0;
let warned = 0;
let failed = 0;

/** @param {string} symbol @param {string} name @param {string} note */
function line(symbol, name, note) {
  console.log(`  ${symbol} ${name.padEnd(30)} ${note}`);
}

/**
 * @param {string} name
 * @param {() => Promise<string | { warn: string } | void>} check
 */
async function check(name, check) {
  try {
    /** @type {string | { warn: string } | void} */
    const note = await check();
    if (note && typeof note === 'object') {
      warned += 1;
      line('!', name, note.warn);
    } else {
      passed += 1;
      line('✓', name, typeof note === 'string' ? note : '');
    }
  } catch (error) {
    failed += 1;
    line('✗', name, error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
function request(path, init = {}) {
  return fetch(base + path, {
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeout),
    ...init,
  });
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {Response} response @param {number} status */
function expectStatus(response, status) {
  assert(response.status === status, `expected ${status}, got ${response.status}`);
  return response;
}

/** @param {string} path @param {(body: any) => void} inspect */
async function json(path, inspect) {
  const response = await request(path);
  expectStatus(response, 200);
  const body = await response.json();
  inspect(body);
  return body;
}

console.log(`\nMantisBin smoke test — ${base}\n`);

await check('GET /api/health', async () => {
  const body = await json('/api/health', (data) => {
    assert(data.status === 'ok', `status field is ${JSON.stringify(data.status)}`);
  });
  return `200, ${body.service} at ${body.time}`;
});

await check('GET /api/meta', async () => {
  const body = await json('/api/meta', (data) => {
    assert(Array.isArray(data.visibilities) && data.visibilities.length > 0, 'no visibilities');
    assert(data.formatting && Array.isArray(data.formatting.fonts), 'no formatting vocabulary');
    assert(data.rateLimits && data.rateLimits.media, 'no media rate limit advertised');
    assert(data.limits && data.limits.formattingLines > 0, 'no formatting line cap');
  });
  return `200, ${body.rateLimits ? Object.keys(body.rateLimits).length : 0} rate-limit buckets advertised`;
});

await check('GET / (editor)', async () => {
  const response = expectStatus(await request('/'), 200);
  const html = await response.text();
  assert(html.includes('data-media-panel'), 'the merged media panel is missing from the editor');
  assert(html.includes('class="workspace"'), 'the editor form is missing');
  return '200, editor + media panel render';
});

await check('GET /docs', async () => {
  const response = expectStatus(await request('/docs'), 200);
  const html = await response.text();
  for (const id of ['formatting', 'profiles', 'social', 'media', 'limits']) {
    assert(html.includes(`id="${id}"`), `the #${id} section is missing`);
  }
  return '200, every merged section documented';
});

await check('GET /api/stickers', async () => {
  const response = expectStatus(await request('/api/stickers'), 200);
  assert(response.headers.get('x-robots-tag') === 'noindex, nofollow', 'missing X-Robots-Tag: noindex');
  assert(/(^|,)\s*max-age=\d+/.test(response.headers.get('cache-control') || ''), 'not cacheable');
  const body = await response.json();
  assert(Array.isArray(body.stickers), 'no stickers array');
  if (body.stickers.length === 0) {
    return { warn: '200, but the pack is empty — curate it at /admin/stickers' };
  }
  return `200, ${body.stickers.length} sticker(s)`;
});

await check('GET /api/gifs (trending)', async () => {
  const response = expectStatus(await request('/api/gifs'), 200);
  const body = await response.json();
  assert(Array.isArray(body.gifs), 'no gifs array');
  if (body.degraded) {
    return { warn: `200, provider unreachable from the Worker (degraded:true) — the editor falls back to the pack` };
  }
  return `200, ${body.gifs.length} trending GIF(s) from ${body.provider}`;
});

await check('GET /api/gifs?q=cat (search)', async () => {
  const response = expectStatus(await request('/api/gifs?q=cat'), 200);
  const body = await response.json();
  assert(Array.isArray(body.gifs), 'no gifs array');
  if (body.degraded) {
    return { warn: '200, search degraded (degraded:true) — a provider key or quota may be the cause' };
  }
  return `200, ${body.gifs.length} result(s) for "cat"`;
});

await check('GET /api/notifications/unread', async () => {
  const response = await request('/api/notifications/unread');
  expectStatus(response, 401);
  const body = await response.json();
  assert(typeof body.error === 'string' || body.error, 'no error message for a signed-out poll');
  return '401 signed-out, as designed';
});

await check('GET /robots.txt', async () => {
  const response = expectStatus(await request('/robots.txt'), 200);
  const text = await response.text();
  for (const path of ['/p/', '/admin', '/notifications', '/api/']) {
    assert(new RegExp(`^Disallow: ${path}`, 'm').test(text), `robots.txt does not disallow ${path}`);
  }
  return '200, pastes and private surfaces stay out of search';
});

await check('GET /u/<unknown>', async () => {
  const response = await request('/u/mantisbin-smoke-no-such-user');
  expectStatus(response, 404);
  return '404 for an unknown profile';
});

await check('GET /admin', async () => {
  const response = await request('/admin');
  if (response.status === 303 || response.status === 302) return `${response.status} to the login form`;
  if (response.status === 503) return { warn: '503 — administration is disabled (no ADMIN_PASSWORD), which is the default' };
  throw new Error(`expected a redirect or 503, got ${response.status}`);
});

if (options.write) {
  await check('paste round-trip (--write)', async () => {
    assert(options.key.startsWith('mb_'), '--write needs --key mb_…; create one on /me');
    const content = `mantisbin smoke ${new Date().toISOString()}\n`;
    const headers = { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' };
    const created = await request('/api/pastes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'mantisbin-smoke.txt', content, language: 'plaintext' }),
    });
    if (created.status !== 201) {
      throw new Error(`create returned ${created.status}: ${(await created.text()).slice(0, 140)}`);
    }
    const paste = await created.json();
    assert(paste && paste.id, 'no paste id in the response');
    try {
      const raw = await request(`/api/pastes/${paste.id}/raw`, { headers });
      expectStatus(raw, 200);
      const text = await raw.text();
      assert(text === content, 'the bytes read back differ from the bytes uploaded');
      const found = await request(`/api/pastes/${paste.id}`);
      expectStatus(found, 200);
    } finally {
      const gone = await request(`/api/pastes/${paste.id}`, { method: 'DELETE', headers });
      assert(gone.status === 200, `cleanup delete returned ${gone.status}`);
    }
    return `created, read back byte-exact, deleted ${paste.id}`;
  });
} else {
  line('·', 'paste round-trip', 'skipped (read-only) — add --write --key mb_… to include it');
}

console.log(`\n${passed} passed, ${warned} warning(s), ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
