/**
 * Profile customiser — `/me/profile`.
 *
 * The form is plain HTML and works without JavaScript (submit, validate on the
 * server, re-render with what you typed). The island in `public/app.js` adds
 * three conveniences on top: a live preview, link rows, and counters.
 *
 * The live preview works by pointing the page's theme stylesheet at
 * `/u/:username/theme.css?preview=1&…` with the *unsaved* values — the same
 * generator that produces the real profile stylesheet, so what you see is
 * literally what will be served. No inline styles, so the strict CSP is intact.
 */

import { SITE } from '../config.js';
import { html } from '../lib/html.js';
import { nameEffectClass } from '../lib/nameEffects.js';
import { icon } from '../assets/icons.js';
import { formatDateTime, relativeTime } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

/** One accent choice: a swatch button that sets the colour input. */
function accentSwatch(preset) {
  return html`<button class="swatch swatch-${preset.id}" type="button" data-accent-preset="${preset.hex}" title="${preset.label}" aria-label="Accent: ${preset.label}"></button>`;
}

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   account: { username: string, created_at: number },
 *   profile: any,
 *   values: any,
 *   accents: Array<{ id: string, label: string, hex: string }>,
 *   bannerTypes: Array<{ id: string, label: string, hint: string }>,
 *   effectGroups: Array<{ category: string, effects: Array<{ id: string, label: string, emoji: string, className: string }> }>,
 *   limits: { displayName: number, bio: number, statusText: number, links: number, statusGraphemes: number, linkLabel: number },
 *   themeHash: string,
 *   errors?: string[] | null,
 *   notice?: string | null,
 * }} options
 */
export function profileCustomiserPage(options) {
  const { account, values, limits } = options;
  const links = Array.isArray(values.links) && values.links.length ? values.links : [{ url: '', label: '' }];

  const linkRow = (link) => html`<div class="link-row">
    <label class="sr-only">Link URL</label>
    <input class="input" name="link_url" type="url" inputmode="url" autocomplete="off" placeholder="https://github.com/you" value="${link.url}">
    <label class="sr-only">Link label</label>
    <input class="input input-narrow" name="link_label" type="text" autocomplete="off" maxlength="${limits.linkLabel}" placeholder="Label" value="${link.label}">
    <button class="btn btn-sm btn-ghost" type="button" data-link-remove aria-label="Remove this link">${icon('trash')}</button>
  </div>`;

  const body = html`
  <div class="shell narrow">
    <div class="settings-head">
      <h1>Customize your profile</h1>
      <p class="muted">
        Everything here is optional and only ever shown on your public profile at
        <a href="/u/${account.username}">/u/${account.username}</a>. Your pastes stay unlisted until you publish them.
      </p>
    </div>

    ${options.errors?.length ? alertBox(options.errors) : ''}
    ${options.notice ? alertBox([], options.notice) : ''}

    <form class="customiser" action="/me/profile" method="post" data-profile-form>
      <div class="customiser-grid">
        <div class="customiser-fields">

          <section class="panel-card stack">
            <h2 class="section-title">${icon('user')} Identity</h2>
            <label class="field">
              <span class="field-label">Display name</span>
              <input class="input" name="display_name" type="text" maxlength="${limits.displayName}" value="${values.display_name}" placeholder="${account.username}" data-count-to="display-name-count">
              <span class="field-hint"><span data-count="display-name-count">0</span>/${limits.displayName} — shown instead of your handle. Leave empty to show <span class="mono">@${account.username}</span>.</span>
            </label>
            <label class="field">
              <span class="field-label">Bio</span>
              <textarea class="input" name="bio" rows="3" maxlength="${limits.bio}" data-count-to="bio-count" placeholder="A line or two about you.">${values.bio}</textarea>
              <span class="field-hint"><span data-count="bio-count">0</span>/${limits.bio}</span>
            </label>
            <label class="check">
              <input type="hidden" name="bio_enabled" value="0">
              <input type="checkbox" name="bio_enabled" value="1" ${values.bio_enabled ? 'checked' : ''}>
              <span>Show the bio on my profile</span>
            </label>
          </section>

          <section class="panel-card stack">
            <h2 class="section-title">${icon('eye')} Status</h2>
            <div class="field">
              <span class="field-label">Status emoji</span>
              <div class="status-picker">
                <input class="input input-tiny" name="status_emoji" type="text" maxlength="16" value="${values.status_emoji}" placeholder="🔥" data-status-input>
                <span class="status-quick">
                  ${['🔥', '✨', '🚀', '🎧', '🌙', '☕', '🌊', '🛠️', ':fire:', ':wave:', ':rocket:', ':coffee:'].map(
                    (emoji) => html`<button class="emoji-pick" type="button" data-status-emoji="${emoji}" title="${emoji}">${emoji}</button>`,
                  )}
                </span>
              </div>
              <span class="field-hint">Up to ${limits.statusGraphemes} emoji, or a shortcode such as <span class="mono">:fire:</span> — a shortcode uses the sticker pack, exactly like a paste.</span>
            </div>
            <label class="field">
              <span class="field-label">Status text</span>
              <input class="input" name="status_text" type="text" maxlength="${limits.statusText}" value="${values.status_text}" data-count-to="status-count" placeholder="Busy shipping.">
              <span class="field-hint"><span data-count="status-count">0</span>/${limits.statusText}</span>
            </label>
          </section>

          <section class="panel-card stack">
            <h2 class="section-title">${icon('palette')} Look</h2>

            <div class="field">
              <span class="field-label">Accent colour</span>
              <div class="accent-row">
                <input class="color-input" type="color" name="accent" value="${values.accent}" data-accent-input aria-label="Accent colour">
                <div class="swatches">${options.accents.map(accentSwatch)}</div>
              </div>
              <span class="field-hint">Used for your avatar ring, links and banner gradient. Any colour works — the image icons pick the presets.</span>
            </div>

            <label class="field">
              <span class="field-label">Name effect</span>
              <select class="input" name="name_effect" data-effect-select>
                ${options.effectGroups.map(
                  (group) => html`<optgroup label="${group.category}">
                    ${group.effects.map(
                      (effect) => html`<option value="${effect.id}" data-class="${nameEffectClass(effect.id)}" ${values.name_effect === effect.id ? 'selected' : ''}>${effect.emoji} ${effect.label}</option>`,
                    )}
                  </optgroup>`,
                )}
              </select>
              <span class="field-hint">CSS-only animations — nothing runs client-side, and they stop for visitors who prefer reduced motion.</span>
            </label>

            <div class="field-row">
              <label class="field">
                <span class="field-label">Effect speed</span>
                <input class="range" type="range" name="effect_speed" min="0" max="100" step="5" value="${values.effect_speed}" data-effect-speed>
                <span class="field-hint"><output data-effect-speed-out>${values.effect_speed}</output> — right is faster</span>
              </label>
              <label class="field">
                <span class="field-label">Effect strength</span>
                <input class="range" type="range" name="effect_intensity" min="0" max="100" step="5" value="${values.effect_intensity}" data-effect-intensity>
                <span class="field-hint"><output data-effect-intensity-out>${values.effect_intensity}</output> — right is stronger</span>
              </label>
            </div>

            <div class="field">
              <span class="field-label">Banner</span>
              <div class="radio-row">
                ${options.bannerTypes.map(
                  (type) => html`<label class="radio">
                    <input type="radio" name="banner_type" value="${type.id}" data-banner-type ${values.banner_type === type.id ? 'checked' : ''}>
                    <span>${type.label}</span>
                  </label>`,
                )}
              </div>
              <input class="input" name="banner_url" type="url" inputmode="url" autocomplete="off" placeholder="https://example.com/banner.jpg" value="${values.banner_url}" data-banner-url>
              <span class="field-hint">An https image URL, or “Gradient” for a wash built from your accent. Video banners are not supported.</span>
            </div>
          </section>

          <section class="panel-card stack">
            <h2 class="section-title">${icon('link')} Links</h2>
            <p class="muted small">Up to ${limits.links} links. GitHub, Telegram, Instagram, YouTube, X, Discord, Twitch, Reddit and TikTok get their own icon; anything else gets a globe.</p>
            <div class="link-rows" data-link-rows>${links.map(linkRow)}</div>
            <template data-link-template>${linkRow({ url: '', label: '' })}</template>
            <div class="actions">
              <button class="btn btn-sm" type="button" data-link-add>${icon('plus')} Add link</button>
            </div>
          </section>

          <div class="actions">
            <button class="btn btn-primary" type="submit">Save profile</button>
            <a class="btn" href="/u/${account.username}">View profile</a>
            <a class="btn btn-ghost" href="/me/settings">Settings</a>
          </div>
        </div>

        <aside class="customiser-preview">
          <div class="preview-head">
            <span>${icon('eye')} Live preview</span>
            <span class="muted small" data-preview-note>Unsaved</span>
          </div>
          <div class="profile-theme preview-frame">
            <div class="panel-card profile-hero has-banner" data-preview-hero>
              <div class="profile-banner" data-preview-banner aria-hidden="true"></div>
              <div class="profile-hero-body">
                <img class="avatar avatar-xl avatar-accent" src="/u/${account.username}/avatar.svg" alt="" width="80" height="80">
                <div class="profile-id">
                  <h1 class="profile-name"><span data-preview-name data-class=""></span></h1>
                  <p class="profile-handle">
                    <span class="mono">@${account.username}</span>
                    <span class="status-pill" data-preview-status hidden></span>
                  </p>
                  <p class="muted small">Member ${relativeTime(options.account.created_at, Math.floor(Date.now() / 1000))}</p>
                </div>
              </div>
              <p class="profile-bio" data-preview-bio hidden></p>
              <div class="profile-links" data-preview-links></div>
            </div>
          </div>
          <p class="muted small">
            The preview loads the same generated stylesheet your profile serves
            (<span class="mono">theme.css</span>) with your unsaved values, so nothing is written until you save.
          </p>
          ${options.profile.links.length || options.profile.statusEmoji || options.profile.bio
            ? html`<p class="muted small">Currently live: ${(
                [
                  options.profile.displayName ? 'display name' : '',
                  options.profile.bio ? 'bio' : '',
                  options.profile.statusEmoji ? 'status' : '',
                  options.profile.links.length ? `${options.profile.links.length} link${options.profile.links.length === 1 ? '' : 's'}` : '',
                  options.profile.bannerUrl || options.profile.bannerType === 'gradient' ? 'banner' : '',
                  options.profile.nameEffect !== 'none' ? 'name effect' : '',
                ].filter(Boolean).join(', ') || 'nothing yet'
              )}.</p>`
            : ''}
        </aside>
      </div>
    </form>
  </div>
  `;

  return layout({
    title: `Customize your profile · ${SITE.name}`,
    description: 'Banner, accent colour, name effect, status, links and bio for your MantisBin profile.',
    theme: options.theme,
    user: options.user,
    path: options.path,
    noindex: true,
    styles: [`/u/${account.username}/theme.css?v=${options.themeHash}`],
    body,
  });
}

/** Exported for tests: the customiser labels a profile by its real name. */
export function profileDisplayName(profile, username) {
  return profile?.displayName || username;
}

/** Machine-readable "member since" for the preview footer. */
export function memberSinceLabel(createdAt) {
  return formatDateTime(createdAt);
}
