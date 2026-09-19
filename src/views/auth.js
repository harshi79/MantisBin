/** Sign in / register. Username + password only — no email, no recovery. */

import { LIMITS, SITE } from '../config.js';
import { inlineMark } from '../assets/mark.js';
import { icon } from '../assets/icons.js';
import { html } from '../lib/html.js';
import { alertBox, layout } from './layout.js';

/**
 * @param {{ theme: string, user: any, path: string, values?: any, errors?: string[], field?: string }} options
 */
export function loginPage(options) {
  const values = options.values || {};
  const body = html`
    <div class="card card-narrow">
      <div class="auth-mark">${inlineMark({ size: 34 })}</div>
      <h1>Sign in</h1>
      <p class="tagline">Your pastes, all in one place. No account needed to create a new one.</p>
      ${alertBox(options.errors)}
      <form action="/login" method="post" autocomplete="off">
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" value="${values.username || ''}" required
            autocomplete="username" autocapitalize="off" spellcheck="false"
            minlength="${LIMITS.usernameMin}" maxlength="${LIMITS.usernameMax}">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password">
        </div>
        <button class="btn btn-primary auth-submit" type="submit"><span>Sign in</span>${icon('arrow')}</button>
      </form>
      <p class="card-foot">New here? <a href="/register">Create an account</a>.</p>
    </div>
  `;
  return layout({
    title: `Sign in · ${SITE.name}`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    active: 'login',
    path: options.path,
    body,
  });
}

/**
 * @param {{ theme: string, user: any, path: string, values?: any, errors?: string[] }} options
 */
export function registerPage(options) {
  const values = options.values || {};
  const body = html`
    <div class="card card-narrow">
      <div class="auth-mark">${inlineMark({ size: 34 })}</div>
      <h1>Create an account</h1>
      <p class="tagline">Larger pastes, a place to keep them, and the freedom to make edits.</p>
      ${alertBox(options.errors)}
      <form action="/register" method="post" autocomplete="off">
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" value="${values.username || ''}" required
            autocomplete="username" autocapitalize="off" spellcheck="false" aria-describedby="username-rules"
            minlength="${LIMITS.usernameMin}" maxlength="${LIMITS.usernameMax}">
          <span id="username-rules" class="muted small">${LIMITS.usernameMin}–${LIMITS.usernameMax} letters or numbers. No spaces, _ - . or symbols.</span>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="new-password" aria-describedby="password-rules">
          <span id="password-rules" class="muted small">At least ${LIMITS.passwordMin} characters. There is no recovery — pick well.</span>
        </div>
        <button class="btn btn-primary auth-submit" type="submit"><span>Create account</span>${icon('arrow')}</button>
      </form>
      <p class="card-foot">Already registered? <a href="/login">Sign in</a>.</p>
    </div>
  `;
  return layout({
    title: `Register · ${SITE.name}`,
    theme: options.theme,
    user: options.user,
    noindex: true,
    active: 'register',
    path: options.path,
    body,
  });
}
