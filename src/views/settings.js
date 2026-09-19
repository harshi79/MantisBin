/**
 * Account settings — the private side of the profile system.
 * Profile link + stats, password change, session management, delete account.
 * Everything here needs a signed-in account and stays `noindex`.
 */

import { LIMITS, SITE } from '../config.js';
import { html } from '../lib/html.js';
import { formatBytes, formatDateTime, formatNumber, relativeTime } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   account: { id: number, username: string, created_at: number },
 *   stats: { pastes: number, views: number, bytes: number, publicPastes: number },
 *   sessions: any[],
 *   currentSessionId: number | null,
 *   profileUrl: string,
 *   errors?: string[] | null, notice?: string | null,
 * }} options
 */
export function settingsPage(options) {
  const { account, stats, sessions } = options;

  const sessionList = sessions.length
    ? html`<div class="list">
        ${sessions.map(
          (session) => html`<div class="list-item">
            <div class="list-main">
              <span class="list-title">
                Session #${session.id}
                ${options.currentSessionId === Number(session.id) ? html` <span class="badge badge-ok">this session</span>` : ''}
              </span>
              <div class="list-sub">
                <span title="${formatDateTime(session.created_at)}">signed in ${relativeTime(session.created_at)}</span>
                <span title="${formatDateTime(session.expires_at)}">expires ${relativeTime(session.expires_at)}</span>
              </div>
            </div>
            <div class="list-actions">
              <form action="/me/sessions/revoke" method="post" data-confirm="1">
                <input type="hidden" name="id" value="${session.id}">
                <button class="btn btn-sm btn-danger" type="submit" data-confirm-button>
                  ${options.currentSessionId === Number(session.id) ? 'Sign out' : 'Revoke'}
                </button>
              </form>
            </div>
          </div>`,
        )}
      </div>`
    : html`<div class="empty"><p>No active sessions.</p></div>`;

  const body = html`
    <div class="account-settings">
    <div class="page-head">
      <div>
        <h1>Settings</h1>
        <p class="tagline">Your account, sessions and public profile.</p>
      </div>
      <div class="actions">
        <a class="btn" href="/u/${account.username}">View public profile</a>
        <a class="btn" href="/me">My pastes</a>
      </div>
    </div>
    ${alertBox(options.errors, options.notice)}

    <section class="panel-card settings-profile" aria-labelledby="profile-heading">
      <div class="profile-head">
        <img class="avatar avatar-lg" src="/u/${account.username}/avatar.svg" alt="" width="64" height="64" loading="lazy">
        <div class="profile-id">
          <h2 id="profile-heading">${account.username}</h2>
          <p class="muted small" title="${formatDateTime(account.created_at)}">Member ${relativeTime(account.created_at, Math.floor(Date.now() / 1000))}</p>
        </div>
      </div>
      <div class="stat-chips">
        <span class="stat"><b>${formatNumber(stats.pastes)}</b> pastes</span>
        <span class="stat"><b>${formatNumber(stats.publicPastes)}</b> public</span>
        <span class="stat"><b>${formatNumber(stats.views)}</b> views</span>
        <span class="stat"><b>${formatBytes(stats.bytes)}</b> stored</span>
      </div>
      <div class="share profile-link">
        <label class="sr-only" for="profile-url">Public profile URL</label>
        <input id="profile-url" type="text" readonly value="${options.profileUrl}" data-select-all>
        <button class="btn btn-sm btn-primary" type="button" data-copy="#profile-url">Copy link</button>
        <a class="btn btn-sm" href="/u/${account.username}">Open</a>
      </div>
      <p class="muted small">Only pastes you mark <b>Public</b> appear on your profile. Everything else stays unlisted, even from people who know your username.</p>
    </section>

    <section class="panel-card settings-section" aria-labelledby="password-heading">
      <h2 id="password-heading">Change password</h2>
      <p class="muted small">You will stay signed in here; every other session is signed out.</p>
      <form action="/me/password" method="post" autocomplete="off">
        <div class="field">
          <label for="current_password">Current password</label>
          <input id="current_password" name="current_password" type="password" required autocomplete="current-password">
        </div>
        <div class="field">
          <label for="new_password">New password</label>
          <input id="new_password" name="new_password" type="password" required autocomplete="new-password"
            minlength="${LIMITS.passwordMin}" maxlength="${LIMITS.passwordMax}" aria-describedby="new-password-rules">
          <span id="new-password-rules" class="muted small">At least ${LIMITS.passwordMin} characters. There is no recovery — pick well.</span>
        </div>
        <button class="btn btn-primary" type="submit">Change password</button>
      </form>
    </section>

    <section class="panel-card settings-section" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Sessions</h2>
      <p class="muted small">Browsers currently signed in as ${account.username}. Sessions last 30 days and slide forward on activity.</p>
      ${sessionList}
    </section>

    <section class="panel-card settings-section danger" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Delete account</h2>
      <p class="muted small">
        This deletes <b>${account.username}</b>, every session and every API key immediately. Your pastes are
        <b>kept but anonymised</b>: their links keep working with content, expirations and view counts intact,
        while the owner is cleared and anything public drops back to unlisted. There is no undo.
      </p>
      <form action="/me/delete" method="post" autocomplete="off" data-confirm="1">
        <div class="field">
          <label for="delete_password">Confirm with your password</label>
          <input id="delete_password" name="password" type="password" required autocomplete="current-password">
        </div>
        <button class="btn btn-danger" type="submit" data-confirm-button>Delete my account</button>
      </form>
    </section>
    </div>
  `;

  return layout({
    title: `Settings · ${SITE.name}`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    active: 'settings',
    path: options.path,
    body,
  });
}

/**
 * Goodbye page after self-serve deletion. The session cookie is already
 * cleared, so this renders the signed-out navigation.
 * @param {{ theme: string, user: any, path: string, pastes: number }} options
 */
export function goodbyePage(options) {
  const body = html`
    <div class="error-page">
      <div class="hero-mark">✓</div>
      <h1>Account deleted</h1>
      <p>
        ${options.pastes === 0
          ? 'Your account, sessions and API keys are gone.'
          : options.pastes === 1
            ? 'Your account, sessions and API keys are gone. Your 1 paste stays online, anonymised.'
            : `Your account, sessions and API keys are gone. Your ${formatNumber(options.pastes)} pastes stay online, anonymised.`}
        Thanks for pasting with us.
      </p>
      <a class="btn btn-primary" href="/">New paste</a>
      <a class="btn" href="/register">Register again</a>
    </div>
  `;
  return layout({
    title: `Account deleted · ${SITE.name}`,
    theme: options.theme,
    user: null,
    noindex: true,
    path: options.path,
    body,
  });
}
