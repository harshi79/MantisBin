/**
 * The paste editor — the entire homepage is this form.
 * Shared by "new paste" and "edit paste".
 */

import { EXPIRATIONS, FONTS, FONT_SIZES, LANGUAGES, LIMITS, SITE } from '../config.js';
import { html } from '../lib/html.js';
import { formatBytes } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

/**
 * @param {{
 *   theme: string, user: any, path: string,
 *   mode: 'create' | 'edit',
 *   pasteId?: string,
 *   values: { title: string, content: string, language: string, font: string, font_size: number, expiration: string },
 *   errors?: string[], okMessage?: string,
 *   maxBytes: number,
 * }} options
 */
export function editorPage(options) {
  const { values, mode } = options;
  const isEdit = mode === 'edit';
  const action = isEdit ? `/p/${options.pasteId}/edit` : '/p';
  const heading = isEdit ? 'Edit paste' : 'New paste';

  const body = html`
    <div class="home-head">
      <h1>${heading}</h1>
      <span class="tagline">${isEdit ? 'Same rules, same limits — save to update.' : SITE.tagline}</span>
    </div>
    ${alertBox(options.errors, options.okMessage)}
    <form action="${action}" method="post" ${isEdit ? '' : html`data-remember="1" data-draft="new"`} autocomplete="off">
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
        <div class="spacer"></div>
        <span class="muted small">Tip: <kbd>Ctrl</kbd> + <kbd>Enter</kbd> saves</span>
        ${isEdit ? html`<a class="btn" href="/p/${options.pasteId}">Cancel</a>` : ''}
        <button class="btn btn-primary" type="submit">${isEdit ? 'Save changes' : 'Save paste'}</button>
      </div>
    </form>
  `;

  return layout({
    title: isEdit ? `Edit — ${values.title || 'paste'} · ${SITE.name}` : `${SITE.name} — ${SITE.tagline}`,
    description: SITE.description,
    theme: options.theme,
    user: options.user,
    active: 'home',
    path: options.path,
    body,
  });
}
