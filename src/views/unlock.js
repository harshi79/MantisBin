/**
 * Unlock screen for password-protected pastes (roadmap 2.2 §1).
 *
 * Conservative disclosure policy, decided once and applied to every entry point
 * (HTML view, /p/:id/raw, /api/pastes/:id, /api/pastes/:id/raw):
 *
 *   before unlock:  "This paste is password-protected" + safe metadata
 *   after unlock:   the paste
 *
 * The title, language, font, size and content are all treated as content — a
 * protected paste's title is usually as telling as its body — so none of them
 * are rendered here. Safe metadata is anything an unauthenticated visitor can
 * already derive from the URL and the fact that a paste exists: the paste id,
 * when it was created, when it expires, whether it expires at all, and the view
 * count (which only ever counts actual, unlocked views).
 *
 * No JavaScript is required to unlock; the form posts and the server sets the
 * HttpOnly unlock cookie.
 */

import { SITE, UNLOCK_TTL_SECONDS } from '../config.js';
import { html } from '../lib/html.js';
import { formatDateTime, formatNumber, relativeTime } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   paste: any,
 *   errors?: string[],
 *   locked?: boolean,
 *   burnLabel?: string | null,
 *   next?: string | null,
 * }} options
 */
export function unlockPage(options) {
  const { paste } = options;
  const expires = paste.expires_at !== null && paste.expires_at !== undefined;
  const minutes = Math.round(UNLOCK_TTL_SECONDS / 60);

  const body = html`
    <div class="page-head">
      <div>
        <h1>Password-protected paste</h1>
        <p class="tagline">This paste is protected. Enter the passphrase to read it.</p>
      </div>
    </div>

    ${alertBox(options.errors)}

    <form class="unlock-form" action="/p/${paste.id}/unlock" method="post" autocomplete="off">
      <div>
        <div class="field">
          <label for="password">Passphrase</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autofocus
            autocomplete="current-password"
            spellcheck="false"
            maxlength="256"
            aria-describedby="unlock-help">
          <p id="unlock-help" class="muted small">
            Unlocking lasts about ${minutes} minutes in this browser. The passphrase itself is never
            stored, never put in the URL and never visible to this page.
          </p>
        </div>
        ${options.next ? html`<input type="hidden" name="next" value="${options.next}">` : ''}
        <div class="submit-row">
          <div class="spacer"></div>
          <a class="btn" href="/">New paste</a>
          <button class="btn btn-primary" type="submit" data-unlock-button>Unlock</button>
        </div>
      </div>
    </form>

    <div class="meta">
      <span><b>protected</b></span>
      ${options.burnLabel ? html`<span>${options.burnLabel}</span>` : ''}
      <span title="${formatDateTime(paste.created_at)}">created ${relativeTime(paste.created_at)}</span>
      <span>${expires ? html`expires ${relativeTime(paste.expires_at)}` : 'never expires'}</span>
      <span>${formatNumber(paste.views)} ${paste.views === 1 ? 'view' : 'views'}</span>
      <span>unlisted</span>
      <span class="mono muted">/p/${paste.id}</span>
    </div>

    ${options.locked ? html`<div class="notice">Wrong passphrase. Try again, or ask the sender for the code.</div>` : ''}
  `;

  return layout({
    title: `Protected paste · ${SITE.name}`,
    description: `A password-protected paste on ${SITE.name}. Enter the passphrase to read it.`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    path: options.path,
    body,
  });
}
