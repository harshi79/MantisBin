/** Friendly error pages. Never leak stacks, SQL or secrets. */

import { SITE } from '../config.js';
import { html } from '../lib/html.js';
import { inlineMark } from '../assets/mark.js';
import { layout } from './layout.js';

const MESSAGES = {
  400: ['Bad request', 'The server could not understand that request. Check the input and try again.'],
  401: ['Sign in required', 'This action needs an account. Sign in and try again.'],
  403: ['Not allowed', 'You do not have permission to do that with this paste.'],
  404: ['Not found', 'This paste does not exist, or it expired and was deleted.'],
  405: ['Method not allowed', 'That HTTP method is not supported on this URL.'],
  409: ['Conflict', 'Something with that name already exists.'],
  413: ['Too large', 'That paste exceeds the size limit for your account type.'],
  429: ['Slow down', 'Too many requests in a short time. Wait a moment and try again.'],
  500: ['Something broke', 'An internal error occurred. Your data is probably fine — try again.'],
};

/**
 * @param {{
 *   status: number, message?: string, theme?: string, user?: any, path?: string,
 *   noindex?: boolean,
 * }} options
 */
export function errorPage(options) {
  const status = Number(options.status) || 500;
  const [title, fallback] = MESSAGES[status] || MESSAGES[500];
  const body = html`
    <div class="error-page">
      <div class="hero-mark">${inlineMark({ size: 44, title: 'MantisBin' })}</div>
      <div class="code">ERROR ${status}</div>
      <h1>${title}</h1>
      <p>${options.message || fallback}</p>
      <a class="btn btn-primary" href="/">New paste</a>
      <a class="btn" href="/docs">API docs</a>
    </div>
  `;
  return layout({
    title: `${status} ${title} · ${SITE.name}`,
    theme: options.theme || 'auto',
    user: options.user || null,
    noindex: options.noindex !== false && status !== 404 ? true : true,
    path: options.path || '/',
    body,
  });
}
