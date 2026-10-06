/**
 * One filename-first workspace for creating, editing and duplicating pastes.
 * Every control is an ordinary form input; JavaScript only enhances the editor.
 */
import { BURN_MODES, DEFAULT_FILENAME, DEFAULT_VISIBILITY, EMOJI_SHORTCODES, EXPIRATIONS, FILENAME_EXTENSIONS, FONTS, FORMAT, FORMAT_COLORS, FORMAT_FONTS, FORMAT_SIZES, FONT_SIZES, LANGUAGES, LANGUAGE_OPTIONS, LIMITS, MEDIA, SITE, THUMBNAIL, UNLOCK_TTL_SECONDS, VISIBILITY } from '../config.js';
import { icon } from '../assets/icons.js';
import { html } from '../lib/html.js';
import { formatBytes } from '../lib/validate.js';
import { alertBox, layout } from './layout.js';

/**
 * Everything the client-side formatting toolbar needs, serialised into a data
 * attribute. No inline script is emitted — the strict CSP forbids it.
 */
function formatPayload() {
  return JSON.stringify({
    v: FORMAT.version,
    maxLines: FORMAT.maxLines,
    fonts: FORMAT_FONTS.map((font) => ({ id: font.id, label: font.label })),
    sizes: FORMAT_SIZES.map((size) => ({ id: size.id, label: size.label, px: size.px })),
    colors: FORMAT_COLORS.map((color) => ({ id: color.id, label: color.label })),
    emoji: EMOJI_SHORTCODES,
  });
}

/**
 * The emoji vocabulary the media panel inserts, serialised the same way the
 * format toolbar is (a data attribute — never inline script).
 */
function mediaEmojiPayload() {
  return JSON.stringify({ v: 1, emoji: EMOJI_SHORTCODES });
}

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
 *             thumbnail_remove?: boolean, had_thumbnail?: boolean,
 *             formatting?: string, formatting_lines?: number },
 *   errors?: string[], okMessage?: string,
 *   maxBytes: number,
 *   uploads?: boolean,
 *   uploadHosts?: { label: string, retention: string }[],
 *   stickers?: Array<{ token: string, url: string | null, emoji: string | null, label: string }>,
 *   gifCategories?: Array<{ id: string, label: string, emoji: string }>,
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
  // "catbox.moe, or 0x0.st as a fallback" — the author deserves to know which
  // public host their picture is about to live on, and for how long.
  const hosts = options.uploadHosts || [];
  const hostNames = hosts.map((host) => host.label);
  const whereUploadsGo = hostNames.length > 1
    ? `${hostNames.slice(0, -1).join(', ')} — or ${hostNames[hostNames.length - 1]} as a fallback`
    : hostNames[0] || '';
  const howLongHostsKeep = hosts.map((host) => `${host.label} ${host.retention}`).join('; ');

  const body = html`
    <div class="workspace-head">
      <div>
        <p class="eyebrow">A home for your text &amp; code</p>
        <h1>${heading}</h1>
        <p class="tagline">${tagline}</p>
      </div>
      <div class="workspace-context">
        <ol class="workspace-steps" aria-label="Paste workflow">
          <li class="is-current"><span>01</span> Write</li>
          <li><span>02</span> Save</li>
          <li><span>03</span> Share</li>
        </ol>
        <span class="workspace-note">${icon('link')}${options.user ? html`Signed in as ${options.user.username}` : 'No account needed. Just a link.'}</span>
      </div>
    </div>
    ${alertBox(options.errors, options.okMessage)}
    ${isFork
      ? html`<div class="notice fork-notice">
          Copying <b>${values.title}</b>. The copy gets its own URL, expiration and view count.
          The original is untouched. Passwords are never copied — set a new one if needed.
        </div>`
      : ''}
          <details class="media-panel" data-media-panel data-media-endpoint="/api/gifs" data-media-emoji='${mediaEmojiPayload()}'>
            <summary><span>${icon('image')} Stickers &amp; GIFs</span><span class="settings-summary">Insert at the cursor</span>${icon('chevron')}</summary>
            <div class="media-body">
              <div class="media-head">
                <div class="media-tabs" role="tablist" aria-label="Insert">
                  <button class="btn btn-sm" type="button" role="tab" aria-selected="true" data-media-tab="emoji">Emoji</button>
                  <button class="btn btn-sm" type="button" role="tab" aria-selected="false" data-media-tab="stickers">Stickers</button>
                  <button class="btn btn-sm" type="button" role="tab" aria-selected="false" data-media-tab="gifs">GIFs</button>
                </div>
                <span class="muted small" data-media-hint>Tap to insert at the cursor.</span>
              </div>

              <div class="media-pane" data-media-pane="emoji">
                <div class="media-grid media-grid-tight">
                  ${Object.entries(EMOJI_SHORTCODES).slice(0, 48).map(
                    ([name, emoji]) => html`<button class="media-chip" type="button" data-media-insert=":${name}:" title=":${name}:" aria-label="${name}">${emoji}</button>`,
                  )}
                </div>
              </div>

              <div class="media-pane" data-media-pane="stickers" hidden>
                ${options.stickers?.length
                  ? html`<div class="media-grid media-grid-tight">
                      ${options.stickers.map(
                        (sticker) => html`<button class="media-chip media-chip-sticker" type="button" data-media-insert="${sticker.token}" title="${sticker.label || sticker.token}" aria-label="${sticker.label || sticker.token}">
                          ${sticker.url
                            ? html`<img src="${sticker.url}" alt="" width="40" height="40" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
                            : html`<span>${sticker.emoji || '?'}</span>`}
                        </button>`,
                      )}
                    </div>`
                  : html`<p class="field-note">The pack is empty. An administrator can add curated stickers, and typing <span class="mono">:wave:</span> still renders the built-in emoji.</p>`}
              </div>

              <div class="media-pane" data-media-pane="gifs" hidden>
                <form class="media-search" action="/api/gifs" method="get" data-media-search>
                  <label class="sr-only" for="media-query">Search GIFs</label>
                  <input class="input" id="media-query" name="q" data-media-query maxlength="${MEDIA.queryMax}" placeholder="Search GIFs (or pick a category)" autocomplete="off" spellcheck="false">
                  <label class="sr-only" for="media-category">Anime category</label>
                  <select class="inline-select" id="media-category" name="category" data-media-category>
                    <option value="">Anime…</option>
                    ${(options.gifCategories || []).map((category) => html`<option value="${category.id}">${category.emoji} ${category.label}</option>`)}
                  </select>
                  <button class="btn btn-sm" type="submit">Search</button>
                </form>
                <p class="field-note">GIFs come from Giphy and Nekos.best through this site, never straight from your browser. A GIF is inserted as its own line, and renders as a picture in the paste.</p>
                <p class="media-status" data-media-status role="status" aria-live="polite"></p>
                <div class="media-grid" data-media-grid></div>
              </div>

              <noscript><p class="field-note">Inserting needs JavaScript. Typing <span class="mono">:wave:</span>, or an image URL on its own line, works without it.</p></noscript>
            </div>
          </details>
    <form class="workspace" action="${action}" method="post" data-editor-form ${isEdit || isFork ? '' : html`data-remember="1" data-draft="new" data-default-title="${DEFAULT_FILENAME}"`} autocomplete="off">
      <div class="workspace-main">
        <div class="editor-frame">
          <div class="editor-filebar">
            ${icon('file')}
            <label class="sr-only" for="title">Filename</label>
            <input class="title-input" id="title" name="title" type="text" value="${values.title}"
              maxlength="${LIMITS.titleMax}" required autocomplete="off" spellcheck="false"
              data-filename aria-describedby="filename-help" placeholder="${DEFAULT_FILENAME}">
            <button class="btn btn-sm btn-ghost import-button" type="button" data-import-button hidden title="Open a UTF-8 text or code file locally">${icon('upload')}<span>Open file</span></button>
            <input type="file" data-import-file hidden aria-label="Open a text or code file">
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
          <div class="editor-formatbar" data-format-toolbar hidden data-format='${formatPayload()}' data-format-limit="${FORMAT.maxLines}">
            <div class="format-lead">
              ${icon('palette')}
              <span class="format-status" data-format-status aria-live="polite">Select text, then pick a style.</span>
            </div>
            <div class="format-actions">
              <label class="sr-only" for="format_font">Line font</label>
              <select class="inline-select" id="format_font" data-format-font>
                <option value="">Font</option>
                ${FORMAT_FONTS.map((font) => html`<option value="${font.id}">${font.id === 'mono' ? 'Monospace' : font.label}</option>`)}
              </select>
              <label class="sr-only" for="format_size">Line size</label>
              <select class="inline-select" id="format_size" data-format-size>
                <option value="">Size</option>
                ${FORMAT_SIZES.map((size) => html`<option value="${size.id}">${size.label}</option>`)}
              </select>
              <div class="format-swatches" role="group" aria-label="Line colour">
                ${FORMAT_COLORS.map((color) => html`<button class="swatch fmt-c-${color.id}" type="button" data-format-color="${color.id}" title="${color.label}" aria-label="${color.label}"></button>`)}
              </div>
              <button class="btn btn-sm btn-ghost" type="button" data-format-clear title="Remove styling from the selected lines">${icon('trash')}Clear</button>
              <button class="btn btn-sm btn-ghost" type="button" data-format-preview-toggle aria-pressed="false" title="Preview the styled lines">${icon('eye')}Preview</button>
            </div>
            <input type="hidden" name="formatting" value="${values.formatting || ''}" data-format-input>
          </div>
          <div class="format-preview" data-format-preview hidden>
            <div class="format-preview-head">
              <span>Preview — styling only, the text is unchanged</span>
              <span class="muted small" data-format-preview-note></span>
            </div>
            <div class="format-preview-body" data-format-preview-body></div>
          </div>
          <div class="editor-writing">
            <div class="editor-gutter" data-line-gutter aria-hidden="true" hidden><pre data-line-numbers></pre></div>
            <label class="sr-only" for="content">Content</label>
            <textarea id="content" name="content" class="editor font-${values.font} fs-${values.font_size}"
              required spellcheck="false" autocapitalize="off" aria-describedby="editor-help"
              placeholder="Paste text or code here.&#10;Or start typing.">${values.content}</textarea>
          </div>
          <div class="editor-statusbar">
            <div class="editor-status-left">
              <span data-line-count>Plain text &amp; code</span>
              <button class="btn btn-sm btn-ghost editor-wrap" type="button" data-editor-wrap aria-pressed="false" hidden title="Wrap long lines (hides line numbers)">${icon('wrap')} Wrap</button>
            </div>
            <span class="counter" data-counter data-limit="${options.maxBytes}" aria-live="polite">${formatBytes(new TextEncoder().encode(values.content).byteLength)} / ${formatBytes(options.maxBytes)}</span>
          </div>
        </div>
        <p class="import-status" data-import-status role="status" hidden></p>
        <div class="editor-below">
          <p id="editor-help">${icon('code')} Just text. Nothing here is executed. Type <span class="mono">:fire:</span> or <span class="mono">:wave:</span> for an emoji or sticker.<span class="sr-only">Tab indents. Shift+Tab leaves the editor. Control or Command+Enter saves.</span></p>
          <span class="filename-tip">Tip: <span class="mono">.py</span>, <span class="mono">.js</span>, <span class="mono">.md</span> — the filename sets the language.</span>
        </div>
        ${!isEdit && !isFork
          ? html`<div class="draft-tools" role="status">
              <span data-draft-status>Drafts are saved as plain text in this browser.</span>
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
          <details class="thumbnail-options" ${thumbnail || canRemoveThumbnail || options.errors?.length ? html`open` : ''}>
            <summary>${icon('image')}<span>Link preview image</span><span class="label-optional">optional</span>${icon('plus')}</summary>
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
                ? html`Choose an image to upload it to ${whereUploadsGo} (resized to ${THUMBNAIL.width}×${THUMBNAIL.height} in your browser first), or paste any image URL — MantisBin stores only the link.${howLongHostsKeep ? html` ${howLongHostsKeep}.` : ''}`
                : html`Paste any https image URL.`}
            </p>
            ${canRemoveThumbnail
              ? html`<label class="check"><input type="checkbox" name="remove_thumbnail" value="1" data-thumbnail-remove ${values.thumbnail_remove ? html`checked` : ''}><span>Remove the current thumbnail</span></label>`
              : ''}
          </div>
          </details>
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
