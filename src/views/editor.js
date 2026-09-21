/**
 * One filename-first workspace for creating, editing and duplicating pastes.
 * Every control is an ordinary form input; JavaScript only enhances the editor.
 */
import { BURN_MODES, DEFAULT_FILENAME, DEFAULT_VISIBILITY, EXPIRATIONS, FILENAME_EXTENSIONS, FONTS, FONT_SIZES, LANGUAGES, LANGUAGE_OPTIONS, LIMITS, SITE, THUMBNAIL, UNLOCK_TTL_SECONDS, VISIBILITY } from '../config.js';
import { icon } from '../assets/icons.js';
import { html } from '../lib/html.js';
import { formatBytes } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

/** Extension → display label for the client-side filename hint. */
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
 *             burn_after?: string, protected?: boolean, visibility?: string, thumbnail_url?: string,
 *             thumbnail_remove?: boolean, had_thumbnail?: boolean },
 *   errors?: string[], okMessage?: string,
 *   maxBytes: number,
 *   uploads?: boolean,
 * }} options
 */
export function editorPage(options) {
  const { values, mode } = options;
  const isEdit = mode === 'edit';
  const isFork = mode === 'fork';
  const thumbnail = values.thumbnail_url || '';
  // The removal checkbox stays available (and checked) after a failed submit,
  // so a validation error elsewhere in the form never silently drops the
  // author's decision to take the picture down.
  const canRemoveThumbnail = isEdit && (Boolean(thumbnail) || Boolean(values.had_thumbnail) || Boolean(values.thumbnail_remove));
  const action = isEdit ? `/p/${options.pasteId}/edit` : '/p';
  const heading = isEdit ? 'Edit paste' : isFork ? 'Duplicate paste' : 'New paste';
  const tagline = isEdit
    ? 'Make a change. Keep the same link.'
    : isFork
      ? 'A fresh copy, with a link of its own.'
      : 'Your text or code. One link to share it.';
  const visibility = values.visibility || DEFAULT_VISIBILITY;

  const body = html`
    <div class="workspace-head">
      <div>
        <h1>${heading}</h1>
        <p class="tagline">${tagline}</p>
      </div>
      <span class="workspace-note">${icon('link')}${options.user ? html`Signed in as ${options.user.username}` : 'No account needed'}</span>
    </div>
    ${alertBox(options.errors, options.okMessage)}
    ${isFork
      ? html`<div class="notice fork-notice">
          Copying <b>${values.title}</b>. The copy gets its own URL, expiration and view count.
          The original is untouched. Passwords are never copied — set a new one if needed.
        </div>`
      : ''}
    <form class="workspace" action="${action}" method="post" data-editor-form ${isEdit || isFork ? '' : html`data-remember="1" data-draft="new" data-default-title="${DEFAULT_FILENAME}"`} autocomplete="off">
      <div class="workspace-main">
        <div class="editor-frame">
          <div class="editor-filebar">
            ${icon('file')}
            <label class="sr-only" for="title">Filename</label>
            <input class="title-input" id="title" name="title" type="text" value="${values.title}"
              maxlength="${LIMITS.titleMax}" required autocomplete="off" spellcheck="false"
              data-filename aria-describedby="filename-help" placeholder="${DEFAULT_FILENAME}">
            <span class="file-state">${isEdit ? 'Editing' : 'Not saved yet'}</span>
          </div>
          <p class="sr-only" id="filename-help">The filename extension picks the language when Auto detect is on. For example, app.py becomes Python.</p>
          <div class="editor-toolbar">
            <div class="language-control">
              ${icon('code')}
              <label class="sr-only" for="language">Language</label>
              <select class="inline-select" id="language" name="language" data-extensions="${extensionHintPayload()}" aria-describedby="lang-hint">
                ${LANGUAGE_OPTIONS.map((lang) => html`<option value="${lang.id}" ${values.language === lang.id ? html`selected` : ''}>${lang.label}</option>`)}
              </select>
              <span class="sr-only" id="lang-hint" data-lang-hint aria-live="polite"></span>
            </div>
            <div class="format-controls">
              <label class="sr-only" for="font">Font</label>
              <select class="inline-select" id="font" name="font">
                ${FONTS.map((font) => html`<option value="${font.id}" ${values.font === font.id ? html`selected` : ''}>${font.id === 'mono' ? 'Monospace' : font.label}</option>`)}
              </select>
              <label class="sr-only" for="font_size">Font size</label>
              <select class="inline-select" id="font_size" name="font_size">
                ${FONT_SIZES.map((size) => html`<option value="${size}" ${values.font_size === size ? html`selected` : ''}>${size} px</option>`)}
              </select>
            </div>
          </div>
          <div class="editor-writing">
            <div class="editor-gutter" data-line-gutter aria-hidden="true" hidden><pre data-line-numbers></pre></div>
            <label class="sr-only" for="content">Content</label>
            <textarea id="content" name="content" class="editor font-${values.font} fs-${values.font_size}"
              required spellcheck="false" autocapitalize="off" aria-describedby="editor-help"
              placeholder="Paste text or code here.&#10;Or start typing.">${values.content}</textarea>
          </div>
          <div class="editor-statusbar">
            <span data-line-count>Plain text &amp; code</span>
            <span class="counter" data-counter data-limit="${options.maxBytes}" aria-live="polite">${formatBytes(new TextEncoder().encode(values.content).byteLength)} / ${formatBytes(options.maxBytes)}</span>
          </div>
        </div>
        <div class="editor-below">
          <p id="editor-help">${icon('code')} Just text. Nothing here is executed.<span class="sr-only">Tab indents. Shift+Tab leaves the editor. Control or Command+Enter saves.</span></p>
          <span class="filename-tip">Tip: <span class="mono">.py</span>, <span class="mono">.js</span>, <span class="mono">.md</span> — the filename sets the language.</span>
        </div>
        ${!isEdit && !isFork
          ? html`<div class="draft-tools" role="status">
              <span data-draft-status>Drafts stay in this browser.</span>
              <button class="btn btn-sm btn-ghost" type="button" data-draft-restore hidden>Restore draft</button>
              <button class="btn btn-sm btn-ghost" type="button" data-draft-discard hidden>Discard</button>
              <button class="btn btn-sm btn-ghost" type="button" data-draft-clear hidden>Clear saved draft</button>
            </div>`
          : ''}
      </div>

      <aside class="paste-settings" aria-labelledby="paste-settings-heading">
        <details class="settings-panel" data-paste-settings ${options.errors?.length ? html`data-keep-open` : ''} open>
          <summary><span id="paste-settings-heading">Paste settings</span><span class="settings-summary" data-settings-summary></span>${icon('chevron')}</summary>
          <div class="settings-body">
          <div class="field">
            <label for="expiration">Expires in</label>
            <select id="expiration" name="expiration">
              ${EXPIRATIONS.map((exp) => html`<option value="${exp.id}" ${values.expiration === exp.id ? html`selected` : ''}>${exp.label}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="burn_after">After reading</label>
            <select id="burn_after" name="burn_after" aria-describedby="burn-help">
              ${BURN_MODES.map((burn) => html`<option value="${burn.id}" ${(values.burn_after ?? 'never') === burn.id ? html`selected` : ''}>${burn.label}</option>`)}
            </select>
            <p id="burn-help" class="field-note">One-time pastes are deleted for everyone, including you, after the first read.</p>
          </div>
          <div class="field password-field">
            <label for="password">${icon('lock')} Password <span class="label-optional">optional</span></label>
            <input id="password" name="password" type="password" maxlength="${LIMITS.passphraseMax}"
              autocomplete="new-password" spellcheck="false" aria-describedby="password-help"
              placeholder="${isEdit ? 'Leave empty to keep unchanged' : 'Add a password'}">
            <p id="password-help" class="field-note">${isEdit ? 'Leave empty to keep current protection. ' : ''}${LIMITS.passphraseMin}+ characters. Unlocks for ${Math.round(UNLOCK_TTL_SECONDS / 60)} minutes.</p>
            ${isEdit && values.protected
              ? html`<label class="check"><input type="checkbox" name="remove_password" value="1"><span>Remove the current password</span></label>`
              : ''}
          </div>
          <div class="field thumbnail-field" data-thumbnail-field data-max-width="${THUMBNAIL.width}"
            data-max-height="${THUMBNAIL.height}" data-quality="${THUMBNAIL.quality}" data-max-bytes="${THUMBNAIL.maxBytes}"
            ${options.uploads ? html`data-uploads="1"` : ''}>
            <label for="thumbnail_url">${icon('image')} Thumbnail <span class="label-optional">optional</span></label>
            <div class="thumbnail-preview" data-thumbnail-preview ${thumbnail ? '' : html`hidden`}>
              ${thumbnail
                ? html`<img src="${thumbnail}" alt="Current thumbnail" width="${THUMBNAIL.width}" height="${THUMBNAIL.height}" loading="lazy" data-thumbnail-image>`
                : html`<img alt="Thumbnail preview" width="${THUMBNAIL.width}" height="${THUMBNAIL.height}" loading="lazy" data-thumbnail-image>`}
            </div>
            ${options.uploads
              ? html`<div class="thumbnail-actions">
                  <label class="btn btn-sm thumbnail-pick">
                    ${icon('image')}<span>Choose image</span>
                    <input type="file" accept="${THUMBNAIL.types.join(',')}" data-thumbnail-input class="sr-only">
                  </label>
                  <button class="btn btn-sm btn-ghost" type="button" data-thumbnail-clear ${thumbnail ? '' : html`hidden`}>Remove</button>
                  <span class="thumbnail-status muted small" data-thumbnail-status role="status"></span>
                </div>`
              : ''}
            <input id="thumbnail_url" name="thumbnail_url" type="url" value="${thumbnail}"
              maxlength="${THUMBNAIL.maxUrlLength}" autocomplete="off" spellcheck="false"
              placeholder="https://files.catbox.moe/example.jpg" aria-describedby="thumbnail-help"
              data-thumbnail-url>
            <p id="thumbnail-help" class="field-note">
              <b>Anyone with the link can see the thumbnail</b> — it is stored on a public image host, so it stays
              visible even on a password-protected or one-time paste, and it remains on that host after this paste
              expires or is deleted. Never put anything private in it.
              ${options.uploads
                ? html`Images are resized to ${THUMBNAIL.width}×${THUMBNAIL.height} in your browser before upload; MantisBin stores only the link.`
                : html`Paste a link to an image on an allowed host.`}
            </p>
            ${canRemoveThumbnail
              ? html`<label class="check"><input type="checkbox" name="remove_thumbnail" value="1" data-thumbnail-remove ${values.thumbnail_remove ? html`checked` : ''}><span>Remove the current thumbnail</span></label>`
              : ''}
          </div>
          ${options.user
            ? html`<fieldset class="visibility-field">
                <legend class="legend">Visibility</legend>
                <div class="radio-row">
                  ${VISIBILITY.map((option) => html`<label class="radio">
                    <input type="radio" name="visibility" value="${option.id}" ${visibility === option.id ? html`checked` : ''}>
                    <span><b>${option.label}</b><span class="muted small">${option.hint}</span></span>
                  </label>`)}
                </div>
              </fieldset>`
            : html`<div class="privacy-note">${icon('link')}<p><b>Unlisted by default</b><span>Only people with the link can find your paste.</span></p></div>`}
          </div>
        </details>
        <div class="publish-actions">
          <button class="btn btn-primary btn-save" type="submit"><span>${isEdit ? 'Save changes' : isFork ? 'Save copy' : 'Save paste'}</span>${icon('arrow')}</button>
          ${isEdit || isFork ? html`<a class="btn btn-ghost" href="/p/${options.pasteId}">Cancel</a>` : ''}
          <span class="save-shortcut"><kbd data-shortcut-mod>Ctrl</kbd><kbd>Enter</kbd><span>to save</span></span>
        </div>
        ${!options.user && !isEdit && !isFork
          ? html`<p class="account-note">Want to edit your pastes later?<br><a href="/register">Create an account ${icon('external')}</a></p>`
          : ''}
      </aside>
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
