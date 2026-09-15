/**
 * Read authorisation for a single paste.
 *
 * One place decides "may this request see the content?", so the HTML view, the
 * web raw route, the JSON API and the API raw route cannot drift apart:
 *
 *  - unprotected paste  -> yes
 *  - protected paste    -> the owner (signed-in account that created it) always
 *                          gets access; everybody else needs a valid, unexpired
 *                          unlock cookie for this paste id
 *
 * It deliberately performs no writes: burning (2.2 §2) happens after this check,
 * so a failed, rate-limited or unauthorised request can never consume a paste.
 */

import { COOKIE } from '../config.js';
import { hasUnlock, isProtected } from './unlock.js';

/** @typedef {import('../app.js').Ctx} Ctx */

/** APP_SECRET with a dev fallback so local runs and tests need no secrets. */
export function appSecret(ctx) {
  return ctx.env.APP_SECRET || 'mantisbin-dev-secret';
}

/** @param {any} paste @param {{ id: number } | null} user */
export function isPasteOwner(paste, user) {
  if (!paste || !user) return false;
  if (paste.user_id === null || paste.user_id === undefined) return false;
  return Number(paste.user_id) === Number(user.id);
}

/** True when the visitor's unlock cookie carries a valid token for this paste. */
export async function hasUnlockFor(ctx, pasteId) {
  const cookieValue = ctx.cookies[COOKIE.unlock];
  if (!cookieValue) return false;
  return hasUnlock(appSecret(ctx), cookieValue, pasteId, ctx.now);
}

/**
 * May this request read the paste's title/content?
 * @param {Ctx} ctx
 * @param {any} paste a row that includes `password_hash`
 * @returns {Promise<boolean>}
 */
export async function canReadPaste(ctx, paste) {
  if (!isProtected(paste)) return true;
  if (isPasteOwner(paste, ctx.user)) return true;
  return hasUnlockFor(ctx, paste.id);
}
