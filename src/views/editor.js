/**
 * The paste editor — the entire homepage is this form.
 *
 * Three modes share one form:
 *   create — the homepage, posts to /p
 *   edit   — an owned paste, posts to /p/:id/edit
 *   fork   — "duplicate this paste", pre-filled from the source and posting to
 *            the *normal* create endpoint, so a copy is an ordinary paste created
 *            by the actor (own id, own limits, own ownership, own expiration).
 *            Draft autosave is deliberately off here: the create form's draft
 *            slot belongs to the create form.
 */

import { BURN_MODES, DEFAULT_FILENAME, DEFAULT_VISIBILITY, EXPIRATIONS, FILENAME_EXTENSIONS, FONTS, FONT_SIZES, LANGUAGES, LANGUAGE_OPTIONS, LIMITS, SITE, UNLOCK_TTL_SECONDS, VISIBILITY } from '../config.js';
import { html } from '../lib/html.js';
import { formatBytes } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

/** Extension → display label, for the client-side “→ Python (from .py)” hint. */
function extensionHintPayload() {
  const labels = new Map(LANGUAGES.map((lang) => [lang.id, lang.label]));
  /** @type {Record<string, string>} */
  const payload = {};
  for (const [ext, id] of Object.entries(FILENAME_EXTENSIONS)) {
    payload[ext] = labels.get(id) || id;
  }
  return JSON.stringify(payload);
}

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   mode: 'create' | 'edit' | 'fork',
 *   pasteId?: string,
 *   values: { title: string, content: string, language: string, font: string, font_size: number, expiration: string,
 *             burn_after?: string, protected?: boolean, visibility?: string },
 *   errors?: string[], okMessage?: string,
 *   maxBytes: number,
 * }} options
 */
export function editorPage(options) {
  const { values, mode } = options;
  const isEdit = mode === 'edit';
  const isFork = mode === 'fork';
  const action = isEdit ? `/p/${options.pasteId}/edit` : '/p';
  const heading = isEdit ? 'Edit paste' : isFork ? 'Duplicate paste' : 'New paste';
  const tagline = isEdit
    ? 'Same rules, same limits — save to update.'
    : isFork
      ? 'Edit anything you like — saving creates a new paste, the original is untouched.'
      : SITE.tagline;

  const showHero = !isEdit && !isFork && !options.user;
  const visibility = options.values.visibility || DEFAULT_VISIBILITY;
  const body = html`
    ${showHero
      ? html`<section class="hero" aria-label="About MantisBin">
          <div class="hero-copy">
            <p class="hero-kicker">${SITE.tagline}</p>
            <p class="hero-title">Paste. Save. Share. Copy.</p>
            <p class="hero-sub">Unlisted by default. Passwords, burn-after-reading and opt-in public
              profiles when you need them — no ads, no tracking, no noise.</p>
            <div class="hero-cta">
              <a class="btn btn-primary" href="#title">New paste</a>
              <a class="btn" href="/register">Create account</a>
              <a class="btn btn-icon" href="/docs">API docs</a>
            </div>
          </div>
          <ul class="hero-chips">
            <li>Unlisted by default</li>
            <li>Passwords</li>
            <li>Burn after reading</li>
            <li>Public profiles</li>
            <li>JSON API</li>
          </ul>
        </section>`
      : ''}
    <div class="home-head">
      <h1>${heading}</h1>
      <span class="tagline">${tagline}</span>
    </div>
    ${alertBox(options.errors, options.okMessage)}
    ${
      isFork
        ? html`<div class="notice">
            Copying <b>${values.title}</b>. The copy gets its own URL, its own expiration and its own view
            count, and it belongs to whoever saves it now. Passwords are never copied (the server cannot read
            them back) — set a new one below if the copy should be protected too.
          </div>`
        : ''
    }
    <form action="${action}" method="post" ${isEdit || isFork ? '' : html`data-remember="1" data-draft="new" data-default-title="${DEFAULT_FILENAME}"`} autocomplete="off">
      <div class="field">
        <label for="title">Filename <span class="muted" aria-hidden="true">· required</span></label>
        <input
          class="title-input"
          id="title"
          name="title"
          type="text"
          value="${values.title}"
          maxlength="${LIMITS.titleMax}"
          required
          autocomplete="off"
          spellcheck="false"
          data-filename
          placeholder="${DEFAULT_FILENAME}">
        <p class="muted small field-note">The extension picks the language when Auto detect is on — <span class="mono">app.py</span> becomes Python.</p>
      </div>

      <div class="toolbar editor-block">
        <div class="field">
          <label for="language">Language <span class="lang-hint" data-lang-hint aria-live="polite"></span></label>
          <select id="language" name="language" data-extensions="${extensionHintPayload()}">
            ${LANGUAGE_OPTIONS.map(
              (lang) =>
                html`<option value="${lang.id}" ${values.language === lang.id ? html`selected` : ''}>${lang.label}</option>`,
            )}
          </select>
        </div>
        <div class="field">
          <label for="font">Font</label>
          <select id="font" name="font">
            ${FONTS.map(
              (font) =>
                html`<option value="${font.id}" ${values.font === font.id ? html`selected` : ''}>${font.label}</option>`,
            )}
          </select>
        </div>
        <div class="field field-size">
          <label for="font_size">Font size</label>
          <select id="font_size" name="font_size">
            ${FONT_SIZES.map(
              (size) =>
                html`<option value="${size}" ${values.font_size === size ? html`selected` : ''}>${size} px</option>`,
            )}
          </select>
        </div>
      </div>

      <div class="field editor-block">
        <label for="content">Content <span class="muted">· plain text or code, shown exactly as pasted</span></label>
        <textarea
          id="content"
          name="content"
          class="editor font-${values.font} fs-${values.font_size}"
          required
          spellcheck="false"
          autocapitalize="off"
          placeholder="Paste text or code here. URLs stay clickable, nothing is executed.">${values.content}</textarea>
        <div class="submit-row counter-row">
          <span class="counter" data-counter data-limit="${options.maxBytes}" aria-live="polite">0 B / ${formatBytes(options.maxBytes)}</span>
        </div>
        <div class="draft-tools" role="status">
          <span data-draft-status>Drafts stay in this browser.</span>
          <button class="btn btn-sm" type="button" data-draft-restore hidden>Restore draft</button>
          <button class="btn btn-sm" type="button" data-draft-discard hidden>Discard</button>
          <button class="btn btn-sm" type="button" data-draft-clear hidden>Clear saved draft</button>
        </div>
      </div>

      ${options.user
        ? html`<fieldset class="field editor-block visibility-field">
            <legend class="legend">Visibility</legend>
            <div class="radio-row">
              ${VISIBILITY.map(
                (option) => html`<label class="radio">
                  <input type="radio" name="visibility" value="${option.id}" ${visibility === option.id ? html`checked` : ''}>
                  <span><b>${option.label}</b><span class="muted small">${option.hint}</span></span>
                </label>`,
              )}
            </div>
          </fieldset>`
        : !isEdit && !isFork
          ? html`<p class="muted small editor-block">Signed-in bonus: <a href="/register">create an account</a> to publish pastes on your public profile.</p>`
          : ''}
      <div class="field editor-block">
        <label for="password">Password <span class="muted">· optional, hides the paste until it is entered</span></label>
        <input
          id="password"
          name="password"
          type="password"
          maxlength="${LIMITS.passphraseMax}"
          autocomplete="new-password"
          spellcheck="false"
          ${isEdit ? html`placeholder="Leave empty to keep the current password"` : html`placeholder="Leave empty for an unprotected paste"`}>
        <p class="muted small">
          ${
            isEdit
              ? html`Leaving this empty keeps the current protection. At least ${LIMITS.passphraseMin} characters to set a new one.`
              : html`At least ${LIMITS.passphraseMin} characters. Only a PBKDF2 hash is stored; the password never appears in the URL, in HTML or in logs.`
          }
          Unlocking lasts ${Math.round(UNLOCK_TTL_SECONDS / 60)} minutes.
        </p>
        ${
          isEdit && values.protected
            ? html`<label class="check">
                <input type="checkbox" name="remove_password" value="1">
                <span>Remove the current password (make this paste public again)</span>
              </label>`
            : ''
        }
      </div>

      <div class="submit-row submit-sticky">
        <div class="field">
          <label for="expiration">Expires</label>
          <select id="expiration" name="expiration">
            ${EXPIRATIONS.map(
              (exp) =>
                html`<option value="${exp.id}" ${values.expiration === exp.id ? html`selected` : ''}>${exp.label}</option>`,
            )}
          </select>
        </div>
        <div class="field">
          <label for="burn_after">After reading</label>
          <select id="burn_after" name="burn_after" aria-describedby="burn-help">
            ${BURN_MODES.map(
              (mode) =>
                html`<option value="${mode.id}" ${(values.burn_after ?? 'never') === mode.id ? html`selected` : ''}>${mode.label}</option>`,
            )}
          </select>
        </div>
        <p id="burn-help" class="muted small field-help">
          A one-time paste is deleted for everyone — including you — as soon as it is read.
        </p>
        <div class="spacer"></div>
        <span class="muted small">Tip: <kbd>Ctrl</kbd> + <kbd>Enter</kbd> saves</span>
        ${isEdit || isFork ? html`<a class="btn" href="/p/${options.pasteId}">Cancel</a>` : ''}
        <button class="btn btn-primary" type="submit">${isEdit ? 'Save changes' : isFork ? 'Save copy' : 'Save paste'}</button>
      </div>
    </form>
  `;

  return layout({
    title: isEdit
      ? `Edit — ${values.title || 'paste'} · ${SITE.name}`
      : isFork
        ? `Duplicate — ${values.title || 'paste'} · ${SITE.name}`
        : `${SITE.name} — ${SITE.tagline}`,
    description: isFork ? `Duplicate a paste on ${SITE.name}.` : SITE.description,
    noindex: isFork,
    theme: options.theme,
    user: options.user,
    active: 'home',
    path: options.path,
    body,
  });
}
