/**
 * Unit tests for the unlock-token layer (roadmap 2.2 §1).
 *
 * The token is stateless — an HMAC over (paste id, expiry) — so these tests are
 * what stands between "signed cookie" and "attacker-minted cookie".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNLOCK_MAX_TOKENS, UNLOCK_TTL_SECONDS } from '../src/config.js';
import {
  hasUnlock,
  hashPassphrase,
  isProtected,
  issueUnlockToken,
  rememberUnlock,
  unlockBucketKey,
  unlockCookieString,
  verifyPassphrase,
  verifyUnlockEntry,
} from '../src/lib/unlock.js';
import { validatePassphrase } from '../src/lib/validate.js';

const SECRET = 'test-secret-value';
const NOW = 1_700_000_000;

test('an issued unlock token verifies for its own paste and expiry', async () => {
  const entry = await issueUnlockToken(SECRET, 'a8Kx92Lm', NOW + UNLOCK_TTL_SECONDS);
  assert.match(entry, /^a8Kx92Lm:[0-9a-z]+:[0-9a-f]{32}$/);
  assert.ok(await verifyUnlockEntry(entry, SECRET, 'a8Kx92Lm', NOW));
  assert.ok(await hasUnlock(SECRET, entry, 'a8Kx92Lm', NOW));
});

test('an unlock token is bound to its paste, its expiry and the app secret', async () => {
  const entry = await issueUnlockToken(SECRET, 'a8Kx92Lm', NOW + UNLOCK_TTL_SECONDS);
  // Another paste id: the signature no longer matches.
  assert.equal(await verifyUnlockEntry(entry, SECRET, 'b9Lz13Mn', NOW), false);
  assert.equal(await hasUnlock(SECRET, entry, 'b9Lz13Mn', NOW), false);
  // Rotated APP_SECRET.
  assert.equal(await verifyUnlockEntry(entry, 'other-secret', 'a8Kx92Lm', NOW), false);
  assert.equal(await hasUnlock('other-secret', entry, 'a8Kx92Lm', NOW), false);
  // After expiry (and far past it).
  assert.equal(await verifyUnlockEntry(entry, SECRET, 'a8Kx92Lm', NOW + UNLOCK_TTL_SECONDS + 1), false);
  assert.equal(await verifyUnlockEntry(entry, SECRET, 'a8Kx92Lm', NOW + 10_000_000), false);
});

test('tampered, truncated and malformed tokens are rejected without throwing', async () => {
  const entry = await issueUnlockToken(SECRET, 'a8Kx92Lm', NOW + 600);
  const [id, expiry, mac] = entry.split(':');
  const flip = (hex) => (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1);
  const cases = [
    `${id}:${expiry}:${flip(mac)}`,
    `${id}:${expiry}`,
    `${id}:${expiry}:${mac}:extra`,
    `${id}::${mac}`,
    `:${expiry}:${mac}`,
    `${id}:${expiry}:${mac.toUpperCase()}`,
    `${id}:${expiry}:${mac.slice(0, 31)}`,
    `${id}:!!!:${mac}`,
    '',
    'garbage',
    `${id}:${expiry}:${'0'.repeat(32)}`,
    `../etc/passwd:${expiry}:${mac}`,
  ];
  for (const value of cases) {
    assert.equal(await verifyUnlockEntry(value, SECRET, 'a8Kx92Lm', NOW), false, value);
    assert.equal(await hasUnlock(SECRET, value, 'a8Kx92Lm', NOW), false, value);
  }
  assert.equal(await hasUnlock(SECRET, undefined, 'a8Kx92Lm', NOW), false);
});

test('the unlock cookie remembers several pastes, newest first and bounded', async () => {
  const ids = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee'];
  let cookie = '';
  for (const id of ids) {
    const entry = await issueUnlockToken(SECRET, id, NOW + UNLOCK_TTL_SECONDS);
    cookie = rememberUnlock(cookie, entry, NOW, UNLOCK_MAX_TOKENS);
  }
  const entries = cookie.split('~');
  assert.equal(entries.length, UNLOCK_MAX_TOKENS, 'the cookie stays bounded');
  assert.equal(entries[0].split(':')[0], 'eeeeeeee', 'newest unlock first');
  // The three most recent pastes stay unlocked; the evicted ones need a re-unlock.
  for (const id of ['eeeeeeee', 'dddddddd', 'cccccccc']) {
    assert.ok(await hasUnlock(SECRET, cookie, id, NOW), id);
  }
  for (const id of ['bbbbbbbb', 'aaaaaaaa']) {
    assert.equal(await hasUnlock(SECRET, cookie, id, NOW), false, id);
  }

  // Re-unlocking an already remembered paste replaces its entry, never duplicates it.
  const again = await issueUnlockToken(SECRET, 'cccccccc', NOW + UNLOCK_TTL_SECONDS + 60);
  const refreshed = rememberUnlock(cookie, again, NOW, UNLOCK_MAX_TOKENS);
  assert.equal(refreshed.split('~').filter((entry) => entry.startsWith('cccccccc:')).length, 1);
  assert.equal(refreshed.split('~')[0], again);
});

test('expired entries inside a cookie are dropped on read', async () => {
  const stale = await issueUnlockToken(SECRET, 'a8Kx92Lm', NOW + 60);
  const fresh = await issueUnlockToken(SECRET, 'b9Lz13Mn', NOW + 600);
  const cookie = `${stale}~${fresh}`;
  assert.equal(await hasUnlock(SECRET, cookie, 'a8Kx92Lm', NOW + 61), false);
  assert.ok(await hasUnlock(SECRET, cookie, 'b9Lz13Mn', NOW + 61));
  const rewritten = rememberUnlock(cookie, await issueUnlockToken(SECRET, 'cccccccc', NOW + 900), NOW + 61);
  assert.doesNotMatch(rewritten, /a8Kx92Lm/, 'expired entries are not carried forward');
});

test('unlock cookies are HttpOnly, SameSite=Lax and short-lived', () => {
  const cookie = unlockCookieString('a8Kx92Lm:abc:def');
  assert.match(cookie, /^mb_unlock=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, new RegExp(`Max-Age=${UNLOCK_TTL_SECONDS}`));
  // Secure by default (fail closed); the routes pass the real scheme through, so
  // plain-http localhost still works while production stays TLS-only.
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(unlockCookieString('x', { secure: false }), /Secure/);
  assert.match(unlockCookieString('x', { secure: true, maxAge: 60 }), /Max-Age=60/);
});

test('passphrases hash like account passwords and reject bad input', async () => {
  const stored = await hashPassphrase('correct-horse-battery-staple');
  assert.match(stored, /^pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(stored.startsWith(`pbkdf2-sha256$${100_000}$`), 'stays inside the Workers PBKDF2 ceiling');
  assert.ok(await verifyPassphrase('correct-horse-battery-staple', stored));
  assert.equal(await verifyPassphrase('correct-horse-battery-stapl3', stored), false);
  assert.equal(await verifyPassphrase('', stored), false);
  assert.equal(await verifyPassphrase(undefined, stored), false);
  assert.equal(await verifyPassphrase('x'.repeat(5000), stored), false, 'over-long input is capped, never an error');
  assert.equal(await verifyPassphrase('anything', null), false);
  assert.equal(await verifyPassphrase('anything', 'plain-text-record'), false);
  assert.equal(await verifyPassphrase('anything', 'pbkdf2-sha256$notanumber$aa$bb'), false);
});

test('passphrase validation: non-blank, minimum length, hard cap', () => {
  assert.equal(validatePassphrase('hunter2').ok, true, 'six characters is the floor');
  assert.equal(validatePassphrase('abcde').ok, false);
  assert.equal(validatePassphrase('').ok, false);
  assert.equal(validatePassphrase('      ').ok, false, 'whitespace does not count as a passphrase');
  assert.equal(validatePassphrase('abc def').value, 'abc def', 'spaces are part of the secret');
  assert.equal(validatePassphrase('x'.repeat(256)).ok, true);
  assert.equal(validatePassphrase('x'.repeat(257)).ok, false);
  assert.equal(validatePassphrase(undefined).ok, false);
  assert.equal(validatePassphrase(123456).ok, false);
});

test('protection detection and rate-limit buckets', async () => {
  assert.equal(isProtected({ password_hash: null }), false);
  assert.equal(isProtected({}), false);
  assert.equal(isProtected(null), false);
  const stored = await hashPassphrase('hunter2');
  assert.equal(isProtected({ password_hash: stored }), true);
  // One bucket per paste + visitor, so hammering one paste locks nothing else.
  assert.equal(unlockBucketKey('a8Kx92Lm', '1.2.3.4'), 'unlock:a8Kx92Lm:1.2.3.4');
  assert.notEqual(unlockBucketKey('a8Kx92Lm', '1.2.3.4'), unlockBucketKey('b9Lz13Mn', '1.2.3.4'));
  assert.notEqual(unlockBucketKey('a8Kx92Lm', '1.2.3.4'), unlockBucketKey('a8Kx92Lm', '5.6.7.8'));
});
