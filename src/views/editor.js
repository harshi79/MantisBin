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

import { BURN_MODES, EXPIRATIONS, FONTS, FONT_SIZES, LANGUAGES, LIMITS, SITE, UNLOCK_TTL_SECONDS } from '../config.js';
import { html } from '../lib/html.js';
import { formatBytes } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   mode: 'create' | 'edit' | 'fork',
 *   pasteId?: string,
 *   values: { title: string, content: string, language: string, font: string, font_size: number, expiration: string,
 *             burn_after?: string, protected?: boolean },
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

  const body = html`
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
    <form action="${action}" method="post" ${isEdit || isFork ? '' : html`data-remember="1" data-draft="new"`} autocomplete="off">
      <div class="field">
        <label for="title">Title <span class="muted" aria-hidden="true">· required</span></label>
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
          placeholder="config-diff, stack-trace, recipe.txt …">
      </div>

      <div class="toolbar editor-block">
        <div class="field">
          <label for="language">Language</label>
          <select id="language" name="language">
            ${LANGUAGES.map(
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

      <div class="submit-row">
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
