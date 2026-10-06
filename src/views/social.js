/**
 * Social pages (merge phase 3): notifications, bookmarks, follower lists.
 *
 * All three are plain server-rendered pages with plain form buttons — the same
 * convention as the rest of MantisBin, so they work without JavaScript. The
 * only client-side convenience is the CSS-only unread marker.
 */

import { SITE, SOCIAL } from '../config.js';
import { html } from '../lib/html.js';
import { formatBytes, formatDateTime, formatNumber, relativeTime } from '../lib/validate.js';
import { icon } from '../assets/icons.js';
import { alertBox, layout } from './layout.js';

/** Previous/next pager, used by every list here. */
function pager(path, page, hasNext) {
  if (page === 1 && !hasNext) return '';
  const separator = path.includes('?') ? '&' : '?';
  return html`<nav class="pager" aria-label="Pagination">
    ${page > 1 ? html`<a class="btn btn-sm" href="${`${path}${separator}page=${page - 1}`}">${icon('arrow')} Newer</a>` : ''}
    <span class="muted small">Page ${page}</span>
    ${hasNext ? html`<a class="btn btn-sm" href="${`${path}${separator}page=${page + 1}`}">Older ${icon('arrow')}</a>` : ''}
  </nav>`;
}

const NOTIFICATION_ICONS = {
  follow: 'user',
  reaction: 'heart',
  new_paste: 'file',
  admin: 'megaphone',
};

const NOTIFICATION_KINDS = {
  follow: 'New follower',
  reaction: 'New reaction',
  new_paste: 'New paste',
  admin: 'Announcement',
};

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   rows: any[], page: number, pageSize: number, hasNext: boolean,
 *   notice?: string | null,
 * }} options
 */
export function notificationsPage(options) {
  const { rows } = options;
  const unread = rows.filter((row) => Number(row.is_read) === 0).length;

  const list = rows.length
    ? html`<div class="feed">
        ${rows.map(
          (row) => html`<article class="feed-item${Number(row.is_read) === 0 ? ' is-unread' : ''}">
            <div class="feed-icon" aria-hidden="true">${icon(NOTIFICATION_ICONS[row.type] || 'bell')}</div>
            <div class="feed-main">
              <div class="feed-head">
                <span class="badge">${NOTIFICATION_KINDS[row.type] || 'Notification'}</span>
                <span class="muted small" title="${formatDateTime(row.created_at)}">${relativeTime(row.created_at)}</span>
              </div>
              <p class="feed-title">${row.title}</p>
              ${row.message ? html`<p class="muted small">${row.message}</p>` : ''}
              <div class="feed-actions">
                ${row.link ? html`<a class="btn btn-sm" href="${row.link}">Open</a>` : ''}
                ${Number(row.is_read) === 0
                  ? html`<form action="/notifications/read" method="post">
                      <input type="hidden" name="id" value="${row.id}">
                      <input type="hidden" name="next" value="/notifications">
                      <button class="btn btn-sm btn-ghost" type="submit">Mark read</button>
                    </form>`
                  : ''}
              </div>
            </div>
          </article>`,
        )}
      </div>`
    : html`<div class="empty">
        <p>Nothing here yet.</p>
        <p class="muted small">Follow an account and you will hear about the pastes it publishes.</p>
      </div>`;

  const body = html`
    <div class="page-head">
      <div>
        <h1>Notifications</h1>
        <p class="tagline">${unread ? `${formatNumber(unread)} unread on this page.` : 'You are all caught up.'}</p>
      </div>
      ${unread
        ? html`<form action="/notifications/read" method="post">
            <input type="hidden" name="all" value="1">
            <button class="btn btn-sm btn-primary" type="submit">${icon('check')} Mark all read</button>
          </form>`
        : ''}
    </div>
    ${alertBox([], options.notice)}
    ${list}
    ${pager('/notifications', options.page, options.hasNext)}
  `;

  return layout({
    title: `Notifications · ${SITE.name}`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    active: 'notifications',
    path: options.path,
    body,
  });
}

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   rows: any[], page: number, pageSize: number, hasNext: boolean,
 *   notice?: string | null,
 * }} options
 */
export function bookmarksPage(options) {
  const { rows } = options;

  const list = rows.length
    ? html`<div class="list">
        ${rows.map(
          (paste) => html`<div class="list-item">
            ${paste.thumbnail
              ? html`<a class="list-thumb" href="/p/${paste.id}" tabindex="-1" aria-hidden="true">
                  <img src="${paste.thumbnail}" alt="" width="80" height="42" loading="lazy" decoding="async" referrerpolicy="no-referrer">
                </a>`
              : ''}
            <div class="list-main">
              <a class="list-title" href="/p/${paste.id}">${paste.locked ? 'Password-protected paste' : paste.title}</a>
              <div class="list-sub">
                ${paste.author ? html`<span>by <a href="/u/${paste.author}">@${paste.author}</a></span>` : html`<span>anonymous</span>`}
                ${paste.locked ? html`<span class="badge">${icon('lock')} locked</span>` : ''}
                <span>${formatBytes(paste.size)}</span>
                <span title="${formatDateTime(paste.saved_at)}">saved ${relativeTime(paste.saved_at)}</span>
                <span>${formatNumber(paste.views)} ${paste.views === 1 ? 'view' : 'views'}</span>
                ${paste.expires_at ? html`<span>expires ${relativeTime(paste.expires_at)}</span>` : ''}
              </div>
            </div>
            <div class="list-actions">
              <a class="btn btn-sm" href="/p/${paste.id}">Open</a>
              <form action="/p/${paste.id}/bookmark" method="post">
                <input type="hidden" name="saved" value="0">
                <input type="hidden" name="next" value="/me/bookmarks">
                <button class="btn btn-sm btn-ghost" type="submit">${icon('bookmark')} Remove</button>
              </form>
            </div>
          </div>`,
        )}
      </div>`
    : html`<div class="empty">
        <p>No saved pastes yet.</p>
        <p class="muted small">Use <b>Save</b> on any paste you can read — bookmarks are private to you.</p>
      </div>`;

  const body = html`
    <div class="page-head">
      <div>
        <h1>Saved pastes</h1>
        <p class="tagline">Private to your account. Up to ${SOCIAL.bookmarks} pastes.</p>
      </div>
    </div>
    ${alertBox([], options.notice)}
    ${list}
    ${pager('/me/bookmarks', options.page, options.hasNext)}
  `;

  return layout({
    title: `Saved pastes · ${SITE.name}`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    active: 'bookmarks',
    path: options.path,
    body,
  });
}

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   account: { username: string, created_at: number },
 *   direction: 'followers' | 'following',
 *   rows: any[], total: number, page: number, pageSize: number,
 *   isFollowing: boolean, isOwner: boolean,
 * }} options
 */
export function followListPage(options) {
  const { account, direction, rows } = options;
  const isFollowers = direction === 'followers';
  const heading = isFollowers ? 'Followers' : 'Following';
  const title = isFollowers ? `Followers of @${account.username}` : `Accounts @${account.username} follows`;

  const list = rows.length
    ? html`<div class="follow-grid">
        ${rows.map(
          (row) => html`<div class="follow-card">
            <a class="follow-id" href="/u/${row.username}">
              <img class="avatar avatar-md" src="/u/${row.username}/avatar.svg" alt="" width="44" height="44" loading="lazy">
              <span class="follow-names">
                <b>${row.display_name || row.username}</b>
                <span class="muted small mono">@${row.username}</span>
              </span>
            </a>
            ${row.status_emoji || row.status_text
              ? html`<span class="status-pill status-pill-sm">${row.status_emoji ? html`<span class="status-emoji">${row.status_emoji}</span>` : ''}${row.status_text ? html`<span>${row.status_text}</span>` : ''}</span>`
              : ''}
            <span class="muted small">${formatNumber(row.public_pastes)} public ${row.public_pastes === 1 ? 'paste' : 'pastes'}</span>
            ${options.user && Number(options.user.id) !== Number(row.id)
              ? html`<form action="/u/${row.username}/follow" method="post">
                  <input type="hidden" name="follow" value="${row.is_following ? '0' : '1'}">
                  <input type="hidden" name="next" value="/u/${account.username}/${direction}">
                  <button class="btn btn-sm${row.is_following ? ' btn-ghost' : ' btn-primary'}" type="submit">${row.is_following ? 'Following' : 'Follow'}</button>
                </form>`
              : ''}
          </div>`,
        )}
      </div>`
    : html`<div class="empty">
        <p>${options.isOwner ? (isFollowers ? 'No followers yet.' : 'You are not following anyone yet.') : `Nothing to show yet.`}</p>
        ${options.isOwner && !isFollowers && options.user
          ? html`<a class="btn btn-primary" href="/u/${options.user.username}">See who follows you</a>`
          : ''}
      </div>`;

  const body = html`
    <div class="page-head">
      <div>
        <h1>${heading}</h1>
        <p class="tagline">${formatNumber(options.total)} ${heading.toLowerCase()} for @${account.username}.</p>
      </div>
      <div class="actions">
        <a class="btn btn-sm" href="/u/${account.username}">Profile</a>
        <a class="btn btn-sm" href="/u/${account.username}/${isFollowers ? 'following' : 'followers'}">${
          isFollowers ? `Who @${account.username} follows` : `Followers of @${account.username}`
        }</a>
      </div>
    </div>
    ${list}
    ${pager(`/u/${account.username}/${direction}`, options.page, options.page * options.pageSize < options.total)}
  `;

  return layout({
    title: `${title} · ${SITE.name}`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    active: 'profile',
    path: options.path,
    body,
  });
}
