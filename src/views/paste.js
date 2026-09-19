/**
 * Paste view — title, metadata, actions and the pre-rendered code block.
 * Content arrives already escaped/highlighted server-side (see lib/highlight).
 */

import { LANGUAGES, SITE } from '../config.js';
import { burnLabel } from '../lib/burn.js';
import { filenameExtension } from '../lib/detect.js';
import { html, raw } from '../lib/html.js';
import { downloadFilename, formatBytes, formatDateTime, formatNumber, relativeTime } from '../lib/validate.js';
import { layout } from './layout.js';

function languageLabel(id) {
  return LANGUAGES.find((lang) => lang.id === id)?.label || 'Plain text';
}

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   paste: any,
 *   contentHtml: string,
 *   highlighted: boolean,
 *   lineNumbers?: boolean,
 *   share?: boolean,
 *   absoluteUrl: string,
 *   isOwner: boolean,
 *   notice?: string | null,
 * }} options
 */
export function pastePage(options) {
  const { paste } = options;
  const lines = String(paste.content ?? '').split('\n').length;
  const expired = paste.expires_at !== null && paste.expires_at !== undefined;

  const ext = filenameExtension(paste.title);
  const body = html`
    <div class="paste-head">
      <div class="file-title">
        <span class="file-dot" aria-hidden="true"></span>
        <h1>${paste.title}</h1>
        ${ext ? html`<span class="ext-chip mono">${ext}</span>` : ''}
      </div>
      <div class="actions">
        <button class="btn btn-sm" type="button" data-copy="#paste-content">Copy</button>
        <a class="btn btn-sm" href="/p/${paste.id}/raw">Raw</a>
        <a class="btn btn-sm" href="/p/${paste.id}/raw?download=1" download="${downloadFilename(paste.title)}">Download</a>
        <a class="btn btn-sm" href="/p/${paste.id}/fork" title="Create a copy of this paste">Duplicate</a>
        <button class="btn btn-sm" type="button" data-share>Share</button>
        <a class="btn btn-sm" href="/p/${paste.id}/qr" data-qr-link title="Share this paste as a QR code">QR</a>
        ${options.lineNumbers ? html`<button class="btn btn-sm" type="button" data-copy-location>Copy line link</button>` : ''}
        <button class="btn btn-sm" type="button" data-wrap-toggle="#paste-content" aria-pressed="false">Wrap</button>
        ${
          options.isOwner
            ? html`<a class="btn btn-sm" href="/p/${paste.id}/edit">Edit</a>
                <form action="/p/${paste.id}/delete" method="post" data-confirm="1">
                  <button class="btn btn-sm btn-danger" type="submit" data-confirm-button>Delete</button>
                </form>`
            : ''
        }
      </div>
    </div>

    <div class="meta">
      <span><b>${languageLabel(paste.language)}</b></span>
      ${paste.password_hash ? html`<span class="badge">password-protected</span>` : ''}
      ${burnLabel(paste) ? html`<span class="badge badge-warn">${burnLabel(paste)}</span>` : ''}
      <span>${formatBytes(paste.size)} bytes</span>
      <span>${formatNumber(lines)} lines</span>
      <span title="${formatDateTime(paste.created_at)}">created ${relativeTime(paste.created_at)}</span>
      ${paste.updated_at !== paste.created_at ? html`<span title="${formatDateTime(paste.updated_at)}">edited ${relativeTime(paste.updated_at)}</span>` : ''}
      <span>${formatNumber(paste.views)} ${paste.views === 1 ? 'view' : 'views'}</span>
      <span>${expired ? html`expires ${relativeTime(paste.expires_at)}` : 'never expires'}</span>
      <span>unlisted</span>
    </div>

    ${
      options.share
        ? html`<div class="alert alert-ok" role="status">
            <div class="share">
              <label class="sr-only" for="share-url">Paste URL</label>
              <input id="share-url" type="text" readonly value="${options.absoluteUrl}" data-select-all>
              <button class="btn btn-sm btn-primary" type="button" data-copy="#share-url">Copy link</button>
              <a class="btn btn-sm" href="/p/${paste.id}">Open</a>
            </div>
          </div>`
        : ''
    }

    <div class="code-wrap">
      <div class="code-bar">
        <span class="lang">${languageLabel(paste.language)}</span>
        <span class="file-name mono" title="${paste.title}">${paste.title}</span>
        <span class="grow"></span>
        <span class="muted small mono">/p/${paste.id}</span>
      </div>
      ${
        options.highlighted
          ? ''
          : html`<div class="notice">Large paste — syntax highlighting and link detection are skipped so the page stays fast. Use <a href="/p/${paste.id}/raw">raw</a> for the exact bytes.</div>`
      }
      <div class="code-scroll">
        <pre id="paste-content" class="code font-${paste.font} fs-${paste.font_size}" tabindex="0" aria-label="Paste content">${raw(options.contentHtml)}</pre>
      </div>
    </div>
  `;

  return layout({
    title: `${paste.title} · ${SITE.name}`,
    description: `Unlisted paste on ${SITE.name}.`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    path: options.path,
    body,
  });
}
