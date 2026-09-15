/** My Pastes — the only page that lists anything, and it lists only your own. */

import { LANGUAGES, SITE } from '../config.js';
import { html } from '../lib/html.js';
import { formatBytes, formatDateTime, relativeTime } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

function languageLabel(id) {
  return LANGUAGES.find((lang) => lang.id === id)?.label || 'Plain text';
}

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   pastes: any[],
 *   apiKeys: any[],
 *   newKey?: string | null,
 *   notice?: string | null,
 *   errors?: string[],
 * }} options
 */
export function myPastesPage(options) {
  const { pastes, apiKeys } = options;

  const list = pastes.length
    ? html`<div class="list">
        ${pastes.map(
          (paste) => html`<div class="list-item">
            <div class="list-main">
              <a class="list-title" href="/p/${paste.id}">${paste.title}</a>
              <div class="list-sub">
                <span>${languageLabel(paste.language)}</span>
                <span>${formatBytes(paste.size)}</span>
                <span title="${formatDateTime(paste.created_at)}">${relativeTime(paste.created_at)}</span>
                <span>${paste.views} ${paste.views === 1 ? 'view' : 'views'}</span>
                ${
                  paste.expires_at
                    ? html`<span class="badge ${relativeTime(paste.expires_at).startsWith('in') ? '' : 'badge-warn'}">expires ${relativeTime(paste.expires_at)}</span>`
                    : html`<span class="badge">never expires</span>`
                }
              </div>
            </div>
            <div class="list-actions">
              <a class="btn btn-sm" href="/p/${paste.id}">Open</a>
              <a class="btn btn-sm" href="/p/${paste.id}/edit">Edit</a>
              <form action="/p/${paste.id}/delete" method="post" data-confirm="1">
                <button class="btn btn-sm btn-danger" type="submit" data-confirm-button>Delete</button>
              </form>
            </div>
          </div>`,
        )}
      </div>`
    : html`<div class="empty">
        <p>You have no pastes yet.</p>
        <a class="btn btn-primary" href="/">Create your first paste</a>
      </div>`;

  const body = html`
    <div class="page-head">
      <div>
        <h1>My pastes</h1>
        <p class="tagline">Everything you have saved while signed in as <b>${options.user.username}</b>.</p>
      </div>
      <div class="actions"><a class="btn btn-primary" href="/">New paste</a></div>
    </div>
    ${alertBox(options.errors, options.notice)}
    ${
      options.newKey
        ? html`<div class="alert alert-ok" role="status">
            <b>Copy your new API key now — it is shown only once.</b>
            <div class="share">
              <label class="sr-only" for="new-key">New API key</label>
              <input id="new-key" type="text" readonly value="${options.newKey}" data-select-all>
              <button class="btn btn-sm btn-primary" type="button" data-copy="#new-key">Copy key</button>
            </div>
          </div>`
        : ''
    }
    ${list}

    <details class="panel" ${apiKeys.length || options.newKey ? html`open` : ''}>
      <summary>API keys <span class="muted small">(${apiKeys.length}/3)</span></summary>
      <div class="panel-body">
        <p class="muted small">
          API keys let scripts create pastes on your behalf (10 MB limit). Reads never need a key.
          See <a href="/docs">the API docs</a>.
        </p>
        ${
          apiKeys.length
            ? apiKeys.map(
                (key) => html`<div class="key-row">
                  <code class="mono">${key.prefix}</code>
                  <span class="muted">${key.label || 'unnamed'}</span>
                  <span class="muted">created ${relativeTime(key.created_at)}</span>
                  <span class="muted">${key.last_used_at ? html`last used ${relativeTime(key.last_used_at)}` : 'never used'}</span>
                  <span class="grow" aria-hidden="true"></span>
                  <form action="/me/keys/revoke" method="post" data-confirm="1">
                    <input type="hidden" name="id" value="${key.id}">
                    <button class="btn btn-sm btn-danger" type="submit" data-confirm-button>Revoke</button>
                  </form>
                </div>`,
              )
            : html`<p class="muted small">No keys yet.</p>`
        }
        <form action="/me/keys" method="post">
          <div class="submit-row">
            <div class="field">
              <label for="key-label">Label <span class="muted">(optional)</span></label>
              <input id="key-label" name="label" type="text" maxlength="40" placeholder="ci-server" autocomplete="off">
            </div>
            <button class="btn" type="submit">Create key</button>
          </div>
        </form>
      </div>
    </details>
  `;

  return layout({
    title: `My pastes · ${SITE.name}`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    active: 'me',
    path: options.path,
    body,
  });
}
