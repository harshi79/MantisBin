/**
 * Public profile — the opt-in discovery surface.
 *
 * Only `public` pastes of one account appear here, pinned first; no content is
 * embedded beyond titles, and each row links to the paste itself. Everything
 * else on this page is the owner's presentation: banner, accent, display name
 * (with a CSS-only name effect), status, badges, admin-awarded tags and links.
 *
 * The accent, effect speed/intensity and banner come from the profile's
 * generated stylesheet (`/u/:username/theme.css`), linked below. That is the
 * whole reason a profile can have an arbitrary colour without an inline style:
 * `style-src 'self'` allows this sheet, and the sheet only ever contains
 * validated values.
 */

import { LANGUAGES, SITE } from '../config.js';
import { burnLabel } from '../lib/burn.js';
import { html } from '../lib/html.js';
import { nameEffectClass } from '../lib/nameEffects.js';
import { formatBytes, formatDateTime, formatNumber, relativeTime } from '../lib/validate.js';
import { icon } from '../assets/icons.js';
import { layout } from './layout.js';

function languageLabel(id) {
  return LANGUAGES.find((lang) => lang.id === id)?.label || 'Plain text';
}

/** One link chip: the platform class paints it, the label is the text. */
function linkChip(link) {
  return html`<a class="link-chip link-${link.platform}" href="${link.url}" rel="me noopener noreferrer nofollow" target="_blank">
    ${icon(link.platform === 'github' ? 'code' : link.platform === 'generic' ? 'globe' : 'link')}
    <span>${link.label}</span>
  </a>`;
}

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   account: { username: string, created_at: number },
 *   profile: any,
 *   pastes: any[],
 *   stats: { pastes: number, views: number, bytes: number, publicPastes: number },
 *   counts: { followers: number, following: number, pastes: number, reactions: number },
 *   tags: Array<{ id: string, label: string, color: string, effect: string }>,
 *   badges: Array<{ id: string, label: string, emoji: string, hint: string }>,
 *   status?: { kind: string, text: string, sticker?: any | null },
 *   isOwner: boolean,
 *   isFollowing?: boolean,
 *   themeHash: string,
 * }} options
 */
export function profilePage(options) {
  const { account, profile, pastes, tags, badges, isOwner } = options;
  const effectClass = nameEffectClass(profile.nameEffect);
  const name = profile.displayName || account.username;
  const hasBanner = Boolean(profile.bannerUrl) || profile.bannerType === 'gradient';

  const list = pastes.length
    ? html`<div class="list">
        ${pastes.map(
          (paste) => html`<div class="list-item${paste.pinned ? ' is-pinned' : ''}">
            ${paste.thumbnail
              ? html`<a class="list-thumb" href="/p/${paste.id}" tabindex="-1" aria-hidden="true">
                  <img src="${paste.thumbnail}" alt="" width="80" height="42" loading="lazy" decoding="async" referrerpolicy="no-referrer">
                </a>`
              : ''}
            <div class="list-main">
              <a class="list-title${paste.title_color ? ` fmt-c-${paste.title_color}` : ''}" href="/p/${paste.id}">${paste.title}</a>
              <div class="list-sub">
                ${paste.pinned ? html`<span class="badge badge-pin">${icon('pin')} pinned</span>` : ''}
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
  <div class="profile-theme">
    <div class="panel-card profile-hero${hasBanner ? ' has-banner' : ''}">
      ${hasBanner ? html`<div class="profile-banner" aria-hidden="true"></div>` : ''}
      <div class="profile-hero-body">
        <img class="avatar avatar-xl avatar-accent" src="/u/${account.username}/avatar.svg" alt="" width="80" height="80">
        <div class="profile-id">
          <h1 class="profile-name"><span class="${effectClass}">${name}</span></h1>
          <p class="profile-handle">
            <span class="mono">@${account.username}</span>
            ${options.status && options.status.kind !== 'empty'
              ? html`<span class="status-pill">
                  ${options.status.kind === 'sticker'
                    ? html`<img class="sticker status-sticker" src="${options.status.sticker.url}" alt="${options.status.text}" title="${options.status.text}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
                    : html`<span class="status-emoji">${options.status.text}</span>`}
                  ${profile.statusText ? html`<span>${profile.statusText}</span>` : ''}
                </span>`
              : ''}
          </p>
          <p class="muted small" title="${formatDateTime(account.created_at)}">Member ${relativeTime(account.created_at, Math.floor(Date.now() / 1000))}</p>
        </div>
        <div class="profile-actions">
          ${isOwner
            ? html`<a class="btn btn-sm btn-primary" href="/me/profile">${icon('palette')} Customize profile</a>
                <a class="btn btn-sm" href="/me">My pastes</a>
                <a class="btn btn-sm" href="/me/settings">Settings</a>`
            : options.user
              ? html`<form action="/u/${account.username}/follow" method="post">
                  <input type="hidden" name="follow" value="${options.isFollowing ? '0' : '1'}">
                  <input type="hidden" name="next" value="/u/${account.username}">
                  <button class="btn btn-sm${options.isFollowing ? ' btn-ghost' : ' btn-primary'}" type="submit">
                    ${options.isFollowing ? html`${icon('check')} Following` : html`${icon('user')} Follow`}
                  </button>
                </form>`
              : html`<a class="btn btn-sm" href="/login?next=${encodeURIComponent(`/u/${account.username}`)}">${icon('user')} Sign in to follow</a>`}
        </div>
      </div>

      ${badges.length
        ? html`<div class="profile-badges">
            ${badges.map((badge) => html`<span class="badge badge-${badge.id}" title="${badge.hint}">${badge.emoji} ${badge.label}</span>`)}
          </div>`
        : ''}

      ${profile.bio && profile.bioEnabled ? html`<p class="profile-bio">${profile.bio}</p>` : ''}

      ${profile.links.length ? html`<div class="profile-links">${profile.links.map(linkChip)}</div>` : ''}

      ${tags.length
        ? html`<div class="profile-tags">
            ${tags.map((tag) => html`<span class="tag tag-${tag.color}${tag.effect ? ` tag-fx-${tag.effect}` : ''}">${tag.label}</span>`)}
          </div>`
        : ''}

      <div class="stat-chips profile-stats">
        <span class="stat"><b>${formatNumber(options.stats.publicPastes)}</b> public ${options.stats.publicPastes === 1 ? 'paste' : 'pastes'}</span>
        <span class="stat"><b>${formatNumber(options.stats.views)}</b> paste views</span>
        <span class="stat"><b>${formatNumber(profile.views)}</b> profile ${profile.views === 1 ? 'view' : 'views'}</span>
        <a class="stat stat-link" href="/u/${account.username}/followers"><b>${formatNumber(options.counts.followers)}</b> ${options.counts.followers === 1 ? 'follower' : 'followers'}</a>
        <a class="stat stat-link" href="/u/${account.username}/following"><b>${formatNumber(options.counts.following)}</b> following</a>
      </div>
    </div>

    <h2 class="section-title">Public pastes</h2>
    ${list}
  </div>
  `;

  return layout({
    title: `${name} (@${account.username}) · ${SITE.name}`,
    description: `${account.username} on ${SITE.name} — public pastes, newest first.`,
    theme: options.theme,
    user: options.user,
    path: options.path,
    styles: [`/u/${account.username}/theme.css?v=${options.themeHash}`],
    body,
  });
}
