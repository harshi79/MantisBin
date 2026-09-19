/** Shared page chrome. No external fonts, scripts or icon requests. */
import { SITE } from '../config.js';
import { inlineMark } from '../assets/mark.js';
import { icon } from '../assets/icons.js';
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
<meta name="theme-color" content="#141716" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f8f6" media="(prefers-color-scheme: light)">
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
      <span class="brand-symbol">${inlineMark({ size: 28 })}</span>
      <span class="brand-word">Mantis<b>Bin</b></span>
    </a>
    <nav class="nav" aria-label="Main">
      <div class="nav-primary">
        <a class="nav-link" href="/" ${active === 'home' ? html`aria-current="page"` : ''}>${icon('plus')}<span>New paste</span></a>
        ${user ? html`<a class="nav-link" href="/me" ${active === 'me' ? html`aria-current="page"` : ''}>My pastes</a>` : ''}
        <a class="nav-link nav-docs" href="/docs" ${path === '/docs' ? html`aria-current="page"` : ''}>API docs</a>
      </div>
      <div class="nav-account">
        ${user
          ? html`<a class="nav-link nav-settings" href="/me/settings" ${active === 'settings' ? html`aria-current="page"` : ''}>Settings</a>
              <a class="nav-profile" href="/u/${user.username}" title="View your public profile">
                <img class="avatar avatar-nav" src="/u/${user.username}/avatar.svg" alt="" width="26" height="26" loading="lazy">
                <span class="nav-user">${user.username}</span>
              </a>
              <form action="/logout" method="post">
                <button class="btn btn-sm btn-ghost" type="submit">Sign out</button>
              </form>`
          : html`<a class="nav-link" href="/login" ${active === 'login' ? html`aria-current="page"` : ''}>Sign in</a>
              <a class="btn btn-sm nav-register" href="/register" ${active === 'register' ? html`aria-current="page"` : ''}>Create account</a>`}
        <form class="theme-form" data-theme-form action="/theme" method="post">
          <input type="hidden" name="theme" value="${nextTheme}">
          <input type="hidden" name="next" value="${path}">
          <button class="btn btn-icon theme-toggle" type="submit" title="Switch to ${nextTheme} theme" aria-label="Switch to ${nextTheme} theme">
            <span class="theme-symbol theme-auto">${icon('monitor')}</span>
            <span class="theme-symbol theme-light">${icon('sun')}</span>
            <span class="theme-symbol theme-dark">${icon('moon')}</span>
            <span class="theme-symbol theme-ocean">${icon('waves')}</span>
            <span class="sr-only" data-theme-label aria-hidden="true">${nextLabel}</span>
          </button>
        </form>
      </div>
    </nav>
  </div>
</header>
<main id="main">
  <div class="shell">${body}</div>
</main>
<footer class="footer">
  <div class="shell footer-inner">
    <span class="footer-mark"><span class="footer-name">${SITE.name}</span><span>${SITE.tagline}</span></span>
    <div class="footer-links">
      <span class="footer-privacy">${icon('link')} Unlisted by default</span>
      <a href="/docs">API documentation ${icon('external')}</a>
    </div>
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
