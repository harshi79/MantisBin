/**
 * Page chrome: <head>, header, footer. Every page on the site renders through
 * `layout()`, so the brand mark, navigation and theme handling live in exactly
 * one place.
 */

import { SITE } from '../config.js';
import { inlineMark } from '../assets/mark.js';
import { html } from '../lib/html.js';

/**
 * @param {{
 *   title: string,
 *   description?: string,
 *   theme?: string,
 *   user?: { id: number, username: string } | null,
 *   noindex?: boolean,
 *   active?: string,
 *   path?: string,
 *   body: import('../lib/html.js').SafeHtml,
 * }} options
 */
export function layout({ title, description, theme = 'auto', user = null, noindex = false, active = '', path = '/', body }) {
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'ocean' : theme === 'ocean' ? 'auto' : 'light';
  const nextLabel = nextTheme === 'auto' ? 'Auto' : nextTheme === 'light' ? 'Light' : nextTheme === 'dark' ? 'Dark' : 'Ocean';
  return html`<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description || SITE.description}">
${noindex ? html`<meta name="robots" content="noindex, nofollow">` : ''}
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0b0d0f" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/app.css">
<meta property="og:site_name" content="${SITE.name}">
<meta property="og:title" content="${title}">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <div class="shell topbar-inner">
    <a class="brand" href="/" aria-label="MantisBin home">
      ${inlineMark({ size: 22 })}
      <span class="brand-word">Mantis<b>Bin</b></span>
    </a>
    <nav class="nav" aria-label="Main">
      <a href="/" ${active === 'home' ? html`aria-current="page"` : ''}>New paste</a>
      ${
        user
          ? html`<a href="/me" ${active === 'me' ? html`aria-current="page"` : ''}>My pastes</a>
              <a href="/me/settings" ${active === 'settings' ? html`aria-current="page"` : ''}>Settings</a>
              <a class="nav-profile" href="/u/${user.username}" title="Signed in as ${user.username} — view public profile">
                <img class="avatar avatar-nav" src="/u/${user.username}/avatar.svg" alt="" width="22" height="22" loading="lazy">
                <span class="nav-user">${user.username}</span>
              </a>
              <form action="/logout" method="post">
                <button class="btn btn-sm" type="submit">Sign out</button>
              </form>`
          : html`<a href="/login" ${active === 'login' ? html`aria-current="page"` : ''}>Sign in</a>
              <a href="/register" ${active === 'register' ? html`aria-current="page"` : ''}>Register</a>`
      }
      <form data-theme-form action="/theme" method="post">
        <input type="hidden" name="theme" value="${nextTheme}">
        <input type="hidden" name="next" value="${path}">
        <button class="btn btn-sm btn-icon" type="submit" title="Switch to ${nextTheme} theme" aria-label="Switch to ${nextTheme} theme">
          <span data-theme-label aria-hidden="true">${nextLabel}</span>
        </button>
      </form>
    </nav>
  </div>
</header>
<main id="main">
  <div class="shell">${body}</div>
</main>
<footer class="footer">
  <div class="shell footer-inner">
    <span class="footer-mark">${inlineMark({ size: 15 })}<span>${SITE.name} — ${SITE.tagline}</span></span>
    <span aria-hidden="true">·</span>
    <a href="/docs">API docs</a>
    <span aria-hidden="true">·</span>
    <span>Pastes are unlisted and never indexed.</span>
  </div>
</footer>
<script src="/app.js" defer></script>
</body>
</html>
`;
}

/** Small shared helper for form error boxes. */
export function alertBox(errors, okMessage) {
  const list = Array.isArray(errors) ? errors : errors ? [errors] : [];
  if (list.length) {
    return html`<div class="alert alert-error" role="alert">
      ${list.length === 1 ? html`${list[0]}` : html`<ul>${list.map((e) => html`<li>${e}</li>`)}</ul>`}
    </div>`;
  }
  if (okMessage) {
    return html`<div class="alert alert-ok" role="status">${okMessage}</div>`;
  }
  return '';
}
