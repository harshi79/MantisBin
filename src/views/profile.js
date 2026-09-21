/**
 * Public profile — the opt-in discovery surface.
 * Only `public` pastes of one account, newest first. No content is embedded
 * here beyond titles; each row links to the paste itself.
 */

import { LANGUAGES, SITE } from '../config.js';
import { burnLabel } from '../lib/burn.js';
import { html } from '../lib/html.js';
import { formatBytes, formatDateTime, formatNumber, relativeTime } from '../lib/validate.js';
import { layout } from './layout.js';

function languageLabel(id) {
  return LANGUAGES.find((lang) => lang.id === id)?.label || 'Plain text';
}

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   account: { username: string, created_at: number },
 *   pastes: any[],
 *   stats: { pastes: number, views: number, bytes: number, publicPastes: number },
 *   isOwner: boolean,
 * }} options
 */
export function profilePage(options) {
  const { account, pastes, isOwner } = options;

  const list = pastes.length
    ? html`<div class="list">
        ${pastes.map(
          (paste) => html`<div class="list-item">
            ${paste.thumbnail
              ? html`<a class="list-thumb" href="/p/${paste.id}" tabindex="-1" aria-hidden="true">
                  <img src="${paste.thumbnail}" alt="" width="80" height="42" loading="lazy" decoding="async" referrerpolicy="no-referrer">
                </a>`
              : ''}
            <div class="list-main">
              <a class="list-title" href="/p/${paste.id}">${paste.title}</a>
              <div class="list-sub">
                <span>${languageLabel(paste.language)}</span>
                <span>${formatBytes(paste.size)}</span>
                <span title="${formatDateTime(paste.created_at)}">${relativeTime(paste.created_at)}</span>
                <span>${formatNumber(paste.views)} ${paste.views === 1 ? 'view' : 'views'}</span>
                ${paste.password_hash ? html`<span class="badge">password-protected</span>` : ''}
                ${burnLabel(paste) ? html`<span class="badge badge-warn">${burnLabel(paste)}</span>` : ''}
                ${paste.expires_at ? html`<span>expires ${relativeTime(paste.expires_at)}</span>` : html`<span>never expires</span>`}
              </div>
            </div>
            <div class="list-actions">
              <a class="btn btn-sm" href="/p/${paste.id}">Open</a>
              ${isOwner ? html`<a class="btn btn-sm" href="/p/${paste.id}/edit">Edit</a>` : ''}
            </div>
          </div>`,
        )}
      </div>`
    : html`<div class="empty">
        <p>${isOwner ? 'You have no public pastes yet.' : `@${account.username} has no public pastes yet.`}</p>
        ${isOwner ? html`<a class="btn btn-primary" href="/me">Publish one from My pastes</a>` : ''}
      </div>`;

  const body = html`
    <div class="panel-card profile-hero">
      <img class="avatar avatar-xl" src="/u/${account.username}/avatar.svg" alt="" width="80" height="80">
      <div class="profile-id">
        <h1>${account.username}</h1>
        <p class="muted small" title="${formatDateTime(account.created_at)}">Member ${relativeTime(account.created_at, Math.floor(Date.now() / 1000))}</p>
      </div>
      <div class="stat-chips">
        <span class="stat"><b>${formatNumber(pastes.length)}</b> public pastes</span>
        <span class="stat"><b>${formatNumber(options.stats.views)}</b> total views</span>
      </div>
      ${isOwner ? html`<div class="actions"><a class="btn btn-sm" href="/me">My pastes</a><a class="btn btn-sm" href="/me/settings">Settings</a></div>` : ''}
    </div>
    <h2 class="section-title">Public pastes</h2>
    ${list}
  `;

  return layout({
    title: `${account.username} · ${SITE.name}`,
    description: `Public pastes by ${account.username} on ${SITE.name}.`,
    theme: options.theme,
    user: options.user,
    noindex: false,
    path: options.path,
    body,
  });
}
