/** Server-rendered QR share page. The image and text fallback contain only a URL. */

import { SITE } from '../config.js';
import { html, raw } from '../lib/html.js';
import { formatDateTime, relativeTime } from '../lib/validate.js';
import { layout } from './layout.js';

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   paste: any,
 *   unlocked: boolean,
 *   targetUrl: string,
 *   imagePath: string,
 *   downloadPath: string,
 *   qrSvg: string,
 * }} options
 */
export function qrPage(options) {
  const { paste } = options;
  const expires = paste.expires_at !== null && paste.expires_at !== undefined;
  const label = options.unlocked ? paste.title : 'this protected paste';
  const body = html`
    <div class="page-head">
      <div>
        <h1>QR share</h1>
        <p class="tagline">A QR code for the canonical paste link — never the paste contents.</p>
      </div>
    </div>

    <div class="qr-card">
      <div class="qr-image">${raw(options.qrSvg)}</div>
      <p class="qr-caption">Scan to open ${label}.</p>
      <p class="muted small">The code contains only the URL below. A protected paste still asks for its passphrase when opened.</p>
      <label for="qr-url">Accessible link fallback</label>
      <div class="share">
        <input id="qr-url" type="text" readonly value="${options.targetUrl}" data-select-all>
        <button class="btn btn-sm btn-primary" type="button" data-copy="#qr-url">Copy link</button>
      </div>
      <div class="qr-actions">
        <a class="btn btn-primary" href="${options.downloadPath}" download>Download SVG</a>
        <a class="btn" href="${options.targetUrl}">Open paste</a>
        <a class="btn" href="/p/${paste.id}">Back to paste</a>
      </div>
    </div>

    <div class="meta">
      ${options.unlocked ? html`<span><b>${paste.title}</b></span>` : html`<span><b>protected paste</b></span>`}
      ${expires ? html`<span title="${formatDateTime(paste.expires_at)}">expires ${relativeTime(paste.expires_at)}</span>` : 'never expires'}
      <span>unlisted</span>
    </div>
  `;

  return layout({
    title: `QR share · ${SITE.name}`,
    description: `A QR code for an unlisted paste on ${SITE.name}.`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    path: options.path,
    body,
  });
}
