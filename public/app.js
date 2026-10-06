/* MantisBin — client enhancements.
 * The site is fully usable without JavaScript; this file only adds:
 *   - instant theme switching (cookie + attribute, no reload)
 *   - live byte counter + Tab/Ctrl+Enter niceties in the editor
 *   - remembered language/font/size for the create form
 *   - local UTF-8 file import and editor word wrap
 *   - local draft recovery for the create form
 *   - copy, share, select-all and delete-confirmation helpers
 * No frameworks or inline event handlers. Text-file import stays local;
 * only optional thumbnail uploads make enhancement-driven network requests.
 */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  /* ---- theme ------------------------------------------------------------ */

  function setThemeCookie(value) {
    doc.cookie =
      'mb_theme=' + encodeURIComponent(value) + '; path=/; max-age=31536000; samesite=lax';
  }

  var THEME_ORDER = ['light', 'dark', 'ocean', 'auto'];
  var THEME_LABELS = { light: 'Light', dark: 'Dark', ocean: 'Ocean', auto: 'Auto' };

  function nextTheme(value) {
    var index = THEME_ORDER.indexOf(value);
    return THEME_ORDER[(index + 1) % THEME_ORDER.length];
  }

  function applyTheme(value) {
    root.setAttribute('data-theme', value);
    var forms = doc.querySelectorAll('form[data-theme-form]');
    for (var i = 0; i < forms.length; i++) {
      var input = forms[i].querySelector('input[name="theme"]');
      if (input) input.value = nextTheme(value);
      var label = forms[i].querySelector('[data-theme-label]');
      if (label) label.textContent = THEME_LABELS[nextTheme(value)];
      var button = forms[i].querySelector('button');
      if (button) {
        var description = 'Switch to ' + nextTheme(value) + ' theme';
        button.setAttribute('aria-label', description);
        button.title = description;
      }
    }
  }

  var themeForms = doc.querySelectorAll('form[data-theme-form]');
  for (var t = 0; t < themeForms.length; t++) {
    themeForms[t].addEventListener('submit', function (event) {
      event.preventDefault();
      var next = nextTheme(root.getAttribute('data-theme'));
      setThemeCookie(next);
      applyTheme(next);
    });
  }

  /* ---- editor ------------------------------------------------------------ */

  var editorForm = doc.querySelector('[data-editor-form]');
  var editor = doc.querySelector('textarea[name="content"]');
  var counter = doc.querySelector('[data-counter]');
  var lineCount = doc.querySelector('[data-line-count]');
  var gutter = doc.querySelector('[data-line-gutter]');
  var gutterNumbers = doc.querySelector('[data-line-numbers]');
  var totalLines = 1;

  // Render only the visible line numbers, even for multi-megabyte pastes.
  function renderGutter() {
    if (!editor || !gutter || !gutterNumbers) return;
    gutter.hidden = editor.classList.contains('editor-wrapped');
    if (gutter.hidden) return;
    var style = window.getComputedStyle(editor);
    var height = parseFloat(style.lineHeight);
    if (!height) return;
    var first = Math.floor(editor.scrollTop / height);
    var visible = Math.ceil(editor.clientHeight / height) + 1;
    var numbers = [];
    for (var line = first + 1; line <= Math.min(totalLines, first + visible); line++) {
      numbers.push(line);
    }
    gutterNumbers.textContent = numbers.join('\n');
    gutterNumbers.style.fontSize = style.fontSize;
    gutterNumbers.style.lineHeight = style.lineHeight;
    gutterNumbers.style.transform = 'translateY(-' + (editor.scrollTop % height) + 'px)';
  }

  function byteLength(value) {
    if (/[^\x00-\x7F]/.test(value)) return new TextEncoder().encode(value).length;
    return value.length;
  }

  function updateCounter() {
    if (!editor || !counter) return;
    var bytes = byteLength(editor.value);
    var limit = Number(counter.getAttribute('data-limit')) || 0;
    counter.textContent = formatBytes(bytes) + ' / ' + formatBytes(limit);
    counter.setAttribute('data-over', bytes > limit ? 'true' : 'false');
    totalLines = 1;
    var newline = editor.value.indexOf('\n');
    while (newline !== -1) {
      totalLines++;
      newline = editor.value.indexOf('\n', newline + 1);
    }
    if (lineCount) lineCount.textContent = totalLines.toLocaleString() + (totalLines === 1 ? ' line' : ' lines');
    renderGutter();
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';
  }

  if (editor) {
    var timer = null;
    editor.addEventListener('input', function () {
      if (timer) cancelAnimationFrame(timer);
      timer = requestAnimationFrame(updateCounter);
      scheduleDraftSave();
    });
    updateCounter();

    // Tab indents; Shift+Tab always lets keyboard users leave the editor.
    editor.addEventListener('keydown', function (event) {
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        var spaces = '    ';
        editor.setRangeText(spaces, start, end, 'end');
        editor.dispatchEvent(new Event('input'));
      }
    });
    var gutterFrame = null;
    editor.addEventListener('scroll', function () {
      if (gutterFrame) cancelAnimationFrame(gutterFrame);
      gutterFrame = requestAnimationFrame(renderGutter);
    });
    if (window.ResizeObserver) new ResizeObserver(renderGutter).observe(editor);
    else window.addEventListener('resize', renderGutter);
  }

  if (editorForm) {
    editorForm.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        if (editorForm.requestSubmit) editorForm.requestSubmit();
      }
    });
    var modifier = doc.querySelector('[data-shortcut-mod]');
    if (modifier && /Mac|iPhone|iPad/.test(navigator.platform)) modifier.textContent = '⌘';
    var burnSelect = editorForm.querySelector('[name="burn_after"]');
    var burnHelp = doc.getElementById('burn-help');
    function updateBurnHelp() {
      if (burnSelect && burnHelp) burnHelp.hidden = burnSelect.value === 'never';
    }
    if (burnSelect) burnSelect.addEventListener('change', updateBurnHelp);
    updateBurnHelp();
    var settingsPanel = doc.querySelector('[data-paste-settings]');
    var expirationSelect = editorForm.querySelector('[name="expiration"]');
    var settingsSummary = doc.querySelector('[data-settings-summary]');
    function updateSettingsSummary() {
      if (settingsSummary && expirationSelect) {
        settingsSummary.textContent = expirationSelect.options[expirationSelect.selectedIndex].text;
      }
    }
    if (settingsPanel && !settingsPanel.hasAttribute('data-keep-open') && window.matchMedia('(max-width: 800px)').matches) {
      settingsPanel.open = false;
    }
    if (expirationSelect) expirationSelect.addEventListener('change', updateSettingsSummary);
    updateSettingsSummary();
  }

  /* ---- local file import and word wrap ---------------------------------- */

  var wrapEditorButton = doc.querySelector('[data-editor-wrap]');
  if (editor && wrapEditorButton) {
    wrapEditorButton.hidden = false;
    wrapEditorButton.addEventListener('click', function () {
      var wrapped = editor.classList.toggle('editor-wrapped');
      wrapEditorButton.setAttribute('aria-pressed', String(wrapped));
      renderGutter();
    });
  }

  var importButton = doc.querySelector('[data-import-button]');
  var importFile = doc.querySelector('[data-import-file]');
  var importStatus = doc.querySelector('[data-import-status]');
  function reportImport(message, failed) {
    if (!importStatus) return;
    importStatus.hidden = false;
    importStatus.textContent = message;
    importStatus.setAttribute('data-error', String(Boolean(failed)));
  }
  if (editor && importButton && importFile && window.TextDecoder) {
    importButton.hidden = false;
    importButton.addEventListener('click', function () { importFile.click(); });
    importFile.addEventListener('change', async function () {
      var file = importFile.files && importFile.files[0];
      if (!file) return;
      importButton.disabled = true;
      try {
        var limit = Number(counter && counter.getAttribute('data-limit'));
        if (!limit || file.size > limit) {
          reportImport('This file is too large. The limit is ' + formatBytes(limit) + '.', true);
          return;
        }
        var text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (/[\x00-\x08\x0e-\x1f]/.test(text)) {
          reportImport('Choose a UTF-8 text or code file, not a binary file.', true);
          return;
        }
        if (!text.trim()) {
          reportImport('This file is empty. Choose a file with some text.', true);
          return;
        }
        // Confirm after reading so text typed during the read is protected too.
        if (editor.value && !window.confirm('Replace the text currently in the editor with ' + file.name + '?')) {
          reportImport('Import cancelled. Your text is unchanged.');
          return;
        }
        editor.value = text;
        if (filenameInput) {
          filenameInput.value = file.name.slice(0, filenameInput.maxLength > 0 ? filenameInput.maxLength : 120);
          filenameInput.dispatchEvent(new Event('input'));
        }
        if (languageSelect) {
          languageSelect.value = 'auto';
          languageSelect.dispatchEvent(new Event('change'));
        }
        editor.dispatchEvent(new Event('input'));
        editor.focus();
        reportImport('Opened ' + file.name + ' locally. Nothing is uploaded until you save.');
      } catch (error) {
        reportImport('Could not read this file. Choose a UTF-8 text or code file.', true);
      } finally {
        importButton.disabled = false;
        importFile.value = '';
      }
    });
  }

  /* ---- remembered controls on the create form --------------------------- */

  var remember = doc.querySelector('form[data-remember]');
  if (remember) {
    var names = ['language', 'font', 'font_size'];
    var stored = null;
    try {
      stored = JSON.parse(localStorage.getItem('mantisbin:editor') || 'null');
    } catch (e) {
      stored = null;
    }
    names.forEach(function (name) {
      var select = remember.querySelector('[name="' + name + '"]');
      if (!select) return;
      if (stored && stored[name]) select.value = stored[name];
      select.addEventListener('change', function () {
        var next = {};
        try {
          next = JSON.parse(localStorage.getItem('mantisbin:editor') || '{}');
        } catch (e) {
          next = {};
        }
        next[name] = select.value;
        try {
          localStorage.setItem('mantisbin:editor', JSON.stringify(next));
        } catch (e) {
          /* private mode */
        }
        scheduleDraftSave();
      });
    });

  }

  // Preview controls work in create, edit and duplicate modes. Only create
  // remembers preferences; the other modes keep the source paste's settings.
  function previewFont() {
    if (!editorForm || !editor) return;
    var font = editorForm.querySelector('[name="font"]');
    var size = editorForm.querySelector('[name="font_size"]');
    if (!font || !size) return;
    editor.className = editor.className.replace(/\bfont-\S+/g, '').replace(/\bfs-\d+/g, '');
    editor.classList.add('font-' + font.value);
    editor.classList.add('fs-' + size.value);
    renderGutter();
  }
  if (editorForm) {
    var fontSelect = editorForm.querySelector('[name="font"]');
    var sizeSelect = editorForm.querySelector('[name="font_size"]');
    if (fontSelect) fontSelect.addEventListener('change', previewFont);
    if (sizeSelect) sizeSelect.addEventListener('change', previewFont);
    previewFont();
  }

  /* ---- filename → language hint ----------------------------------------- */

  // When the language choice is Auto detect, the server reads the filename
  // extension first (app.py → Python). Mirror that here as a live hint; the
  // server re-resolves everything, so this is display-only. The map arrives
  // in a data attribute to keep one source of truth in src/config.js.
  var filenameInput = doc.querySelector('[data-filename]');
  var languageSelect = doc.querySelector('select[name="language"][data-extensions]');
  var langHint = doc.querySelector('[data-lang-hint]');
  var extensionLabels = null;

  function readExtensionLabels() {
    if (extensionLabels || !languageSelect) return extensionLabels || {};
    try {
      extensionLabels = JSON.parse(languageSelect.getAttribute('data-extensions') || '{}');
    } catch (e) {
      extensionLabels = {};
    }
    return extensionLabels;
  }

  function updateLangHint() {
    if (!langHint || !languageSelect) return;
    var message = '';
    if (languageSelect.value === 'auto' && filenameInput) {
      var parts = filenameInput.value.split(/[\\/]/);
      var base = parts[parts.length - 1].trim().toLowerCase();
      var dot = base.lastIndexOf('.');
      if (dot > 0 && dot < base.length - 1) {
        var ext = base.slice(dot + 1);
        var label = readExtensionLabels()[ext];
        if (label) message = '→ ' + label + ' (from .' + ext + ')';
      }
    }
    langHint.textContent = message;
  }

  if (filenameInput && languageSelect) {
    filenameInput.addEventListener('input', updateLangHint);
    languageSelect.addEventListener('change', updateLangHint);
    updateLangHint();
  }

  /* ---- thumbnail: resize in the browser, upload, keep only the URL ------- */

  // Progressive enhancement. Without JS the field is an ordinary URL input and
  // the paste form still posts normally; with JS, picking a file resizes it to
  // fit the card box, POSTs it to /p/thumbnail and fills the URL in.
  //
  // The resize happens here, before anything leaves the browser, so the image
  // host only ever receives a small card — never the original photo with its
  // full resolution (and whatever EXIF a canvas re-encode drops on the way).
  var thumbField = doc.querySelector('[data-thumbnail-field]');
  if (thumbField && thumbField.getAttribute('data-uploads') === '1') {
    var thumbInput = thumbField.querySelector('[data-thumbnail-input]');
    var thumbUrl = thumbField.querySelector('[data-thumbnail-url]');
    var thumbStatus = thumbField.querySelector('[data-thumbnail-status]');
    var thumbPreview = thumbField.querySelector('[data-thumbnail-preview]');
    var thumbImage = thumbField.querySelector('[data-thumbnail-image]');
    var thumbClear = thumbField.querySelector('[data-thumbnail-clear]');
    var thumbRemove = thumbField.querySelector('[data-thumbnail-remove]');
    var boxWidth = Number(thumbField.getAttribute('data-max-width')) || 1200;
    var boxHeight = Number(thumbField.getAttribute('data-max-height')) || 630;
    var quality = Number(thumbField.getAttribute('data-quality')) || 0.82;
    var maxBytes = Number(thumbField.getAttribute('data-max-bytes')) || 2097152;

    function thumbSay(message) {
      if (thumbStatus) thumbStatus.textContent = message || '';
    }

    function showThumb(url) {
      if (thumbImage) thumbImage.src = url;
      if (thumbPreview) thumbPreview.hidden = !url;
      if (thumbClear) thumbClear.hidden = !url;
    }

    if (thumbUrl) {
      thumbUrl.addEventListener('input', function () {
        var value = thumbUrl.value.trim();
        if (/^https:\/\//i.test(value)) showThumb(value);
        else showThumb('');
        // Typing a new URL countermands an earlier "remove this thumbnail".
        if (thumbRemove && value) thumbRemove.checked = false;
      });
    }

    if (thumbClear) {
      thumbClear.addEventListener('click', function () {
        if (thumbUrl) thumbUrl.value = '';
        if (thumbInput) thumbInput.value = '';
        // On the edit form the checkbox is what actually clears a stored
        // thumbnail server-side; an empty URL input alone means "keep".
        if (thumbRemove) thumbRemove.checked = true;
        showThumb('');
        thumbSay('Thumbnail removed.');
      });
    }

    // Fit inside the card box without upscaling or cropping.
    function fitTo(width, height) {
      var scale = Math.min(boxWidth / width, boxHeight / height, 1);
      return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
    }

    function drawToBlob(source, width, height) {
      var size = fitTo(width, height);
      var canvas = doc.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      var context = canvas.getContext('2d');
      if (!context) return Promise.reject(new Error('no canvas'));
      context.drawImage(source, 0, 0, size.width, size.height);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('encode failed'));
        }, 'image/jpeg', quality);
      });
    }

    function resizeFile(file) {
      // An animated GIF loses its animation in a canvas, so send it untouched
      // when it is already small enough; otherwise a still frame beats nothing.
      if (file.type === 'image/gif' && file.size <= maxBytes) return Promise.resolve(file);
      if (typeof createImageBitmap === 'function') {
        return createImageBitmap(file).then(function (bitmap) {
          return drawToBlob(bitmap, bitmap.width, bitmap.height).then(function (blob) {
            if (bitmap.close) bitmap.close();
            return blob;
          });
        });
      }
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var image = new Image();
        image.onload = function () {
          drawToBlob(image, image.naturalWidth, image.naturalHeight).then(
            function (blob) { URL.revokeObjectURL(url); resolve(blob); },
            function (error) { URL.revokeObjectURL(url); reject(error); },
          );
        };
        image.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error('That file could not be read as an image.'));
        };
        image.src = url;
      });
    }

    if (thumbInput) {
      thumbInput.addEventListener('change', function () {
        var file = thumbInput.files && thumbInput.files[0];
        if (!file) return;
        thumbSay('Resizing…');
        resizeFile(file).then(
          function (blob) {
            if (blob.size > maxBytes) {
              thumbSay('That image is still too large after resizing.');
              return;
            }
            thumbSay('Uploading…');
            var body = new FormData();
            body.append('image', blob, 'thumbnail.jpg');
            return fetch('/p/thumbnail', { method: 'POST', body: body, credentials: 'same-origin' }).then(
              function (response) {
                return response.json().then(
                  function (data) {
                    if (!response.ok || !data.url) {
                      thumbSay(data.error || 'Upload failed. Paste an image URL instead.');
                      return;
                    }
                    if (thumbUrl) thumbUrl.value = data.url;
                    if (thumbRemove) thumbRemove.checked = false;
                    showThumb(data.url);
                    thumbSay('Uploaded. The link is saved with the paste.');
                  },
                  function () {
                    thumbSay('Upload failed. Paste an image URL instead.');
                  },
                );
              },
              function () {
                thumbSay('Upload failed. Check your connection, or paste an image URL.');
              },
            );
          },
          function (error) {
            thumbSay((error && error.message) || 'That image could not be processed.');
          },
        );
      });
    }
  }

  /* ---- local draft recovery --------------------------------------------- */

  var DRAFT_KEY = 'mantisbin:draft:v1';
  // Avoid repeatedly serialising a full multi-megabyte paste on every keystroke.
  var DRAFT_MAX_BYTES = 1024 * 1024;
  var draftForm = remember && remember.getAttribute('data-draft') ? remember : null;
  var draftTimer = null;
  var draftSubmitted = false;
  var draftDirty = false;

  function draftField(name) {
    return draftForm ? draftForm.querySelector('[name="' + name + '"]') : null;
  }

  function readDraft() {
    if (!draftForm) return null;
    try {
      var value = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!value || typeof value !== 'object' || typeof value.content !== 'string') return null;
      return value;
    } catch (e) {
      return null;
    }
  }

  function setDraftStatus(message) {
    var status = draftForm && draftForm.querySelector('[data-draft-status]');
    if (status) status.textContent = message;
  }

  function setDraftButtons(show) {
    var restore = draftForm && draftForm.querySelector('[data-draft-restore]');
    var discard = draftForm && draftForm.querySelector('[data-draft-discard]');
    var clear = draftForm && draftForm.querySelector('[data-draft-clear]');
    if (restore) restore.hidden = !show;
    if (discard) discard.hidden = !show;
    if (clear) clear.hidden = !show;
  }

  function clearDraft(updateUi) {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    draftDirty = false;
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) {
      /* private mode */
    }
    if (updateUi !== false) {
      setDraftButtons(false);
      setDraftStatus('Draft cleared.');
    }
  }

  // The passphrase field is deliberately absent here (and from restoreDraft):
  // local drafts are plain-text in localStorage, so passphrases never go in them.
  function draftValues() {
    return {
      title: (draftField('title') || {}).value || '',
      content: editor ? editor.value : '',
      language: (draftField('language') || {}).value || 'plaintext',
      font: (draftField('font') || {}).value || 'mono',
      font_size: (draftField('font_size') || {}).value || '14',
      expiration: (draftField('expiration') || {}).value || '1w',
      savedAt: Date.now(),
    };
  }

  // The create form starts pre-filled with the default filename; treat that
  // as empty so merely visiting the homepage never stores a draft.
  function defaultTitle() {
    return (draftForm && draftForm.getAttribute('data-default-title')) || '';
  }

  function saveDraft() {
    if (!draftForm || draftSubmitted || !editor || !draftDirty) return;
    var values = draftValues();
    var meaningfulTitle = values.title && values.title !== defaultTitle() ? values.title : '';
    if (!meaningfulTitle && !values.content) {
      clearDraft(false);
      setDraftButtons(false);
      setDraftStatus('Drafts are saved as plain text in this browser.');
      return;
    }
    if (byteLength(values.content) > DRAFT_MAX_BYTES) {
      clearDraft(false);
      setDraftButtons(false);
      setDraftStatus('This draft is over 1 MB and will not be autosaved.');
      return;
    }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(values));
      draftDirty = false;
      setDraftButtons(true);
      setDraftStatus('Draft saved locally at ' + new Date(values.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.');
    } catch (e) {
      setDraftStatus('Draft autosave is unavailable in this browser.');
    }
  }

  function scheduleDraftSave() {
    if (!draftForm || draftSubmitted) return;
    draftDirty = true;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 650);
  }

  function restoreDraft(draft) {
    var fields = ['title', 'language', 'font', 'font_size', 'expiration'];
    fields.forEach(function (name) {
      var field = draftField(name);
      if (!field || draft[name] === undefined) return;
      if (field.tagName === 'SELECT' && !Array.prototype.some.call(field.options, function (option) {
        return option.value === String(draft[name]);
      })) return;
      field.value = String(draft[name]);
      field.dispatchEvent(new Event('change'));
    });
    if (editor) {
      editor.value = draft.content;
      editor.dispatchEvent(new Event('input'));
      editor.focus();
    }
    setDraftButtons(true);
    setDraftStatus('Draft restored. Autosave is on.');
  }

  if (draftForm) {
    draftForm.addEventListener('input', scheduleDraftSave);
    draftForm.addEventListener('change', scheduleDraftSave);
    var existingDraft = readDraft();
    var restoreButton = draftForm.querySelector('[data-draft-restore]');
    var discardButton = draftForm.querySelector('[data-draft-discard]');
    var clearButton = draftForm.querySelector('[data-draft-clear]');

    var savedTitle = existingDraft && existingDraft.title !== defaultTitle() ? existingDraft.title : '';
    if (existingDraft && (savedTitle || existingDraft.content)) {
      setDraftButtons(true);
      var when = existingDraft.savedAt ? new Date(existingDraft.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'earlier';
      setDraftStatus('Unsaved draft found from ' + when + '.');
    }
    if (restoreButton) {
      restoreButton.addEventListener('click', function () {
        var draft = readDraft();
        if (draft) restoreDraft(draft);
      });
    }
    if (discardButton) {
      discardButton.addEventListener('click', function () {
        clearDraft();
      });
    }
    if (clearButton) {
      clearButton.addEventListener('click', function () {
        clearDraft();
      });
    }
    draftForm.addEventListener('submit', function () {
      // Preserve the latest keystrokes while the request is in flight. The
      // successful create redirect clears the draft; validation errors do not.
      saveDraft();
      draftSubmitted = true;
    });
    window.addEventListener('pagehide', function () {
      if (!draftSubmitted) saveDraft();
    });
    window.addEventListener('pageshow', function () {
      draftSubmitted = false;
    });
  }

  // The create route marks a successful save with ?created=1. Clear only then,
  // not on submit, so a validation error or failed request can still recover.
  if (!draftForm && new URL(window.location.href).searchParams.get('created') === '1') {
    clearDraft(false);
  }

  /* ---- copy and share buttons ------------------------------------------- */

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = doc.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      doc.body.appendChild(area);
      area.select();
      try {
        doc.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (error) {
        reject(error);
      } finally {
        doc.body.removeChild(area);
      }
    });
  }

  function canonicalUrl(includeHash) {
    var url = new URL(window.location.href);
    url.search = '';
    if (!includeHash) url.hash = '';
    return url.toString();
  }

  function textForSource(source) {
    if (!source) return '';
    var lines = source.querySelectorAll('.line-content');
    if (lines.length) {
      return Array.prototype.map.call(lines, function (line) {
        return line.textContent;
      }).join('\n');
    }
    return source.value !== undefined ? source.value : source.textContent;
  }

  var copyButtons = doc.querySelectorAll('[data-copy]');
  for (var c = 0; c < copyButtons.length; c++) {
    copyButtons[c].addEventListener('click', function (event) {
      var button = event.currentTarget;
      var selector = button.getAttribute('data-copy');
      var source = selector === 'self' ? null : doc.querySelector(selector);
      var text = button.getAttribute('data-copy-text');
      if (!text && source) text = textForSource(source);
      if (text === null || text === undefined) return;
      copyText(text).then(
        function () {
          flash(button, 'Copied');
        },
        function () {
          flash(button, 'Copy failed');
        },
      );
    });
  }

  var locationButtons = doc.querySelectorAll('[data-copy-location]');
  for (var l = 0; l < locationButtons.length; l++) {
    locationButtons[l].addEventListener('click', function (event) {
      var button = event.currentTarget;
      copyText(canonicalUrl(true)).then(
        function () {
          flash(button, window.location.hash ? 'Line link copied' : 'Link copied');
        },
        function () {
          flash(button, 'Copy failed');
        },
      );
    });
  }

  var shareButtons = doc.querySelectorAll('[data-share]');
  for (var s = 0; s < shareButtons.length; s++) {
    shareButtons[s].addEventListener('click', function (event) {
      var button = event.currentTarget;
      var url = canonicalUrl(true);
      if (navigator.share) {
        try {
          Promise.resolve(navigator.share({ title: doc.title, url: url })).then(
            function () {
              flash(button, 'Shared');
            },
            function (error) {
              // Closing the native share sheet is not an error.
              if (error && error.name === 'AbortError') return;
              copyText(url).then(function () {
                flash(button, 'Link copied');
              }, function () {
                flash(button, 'Share unavailable');
              });
            },
          );
          return;
        } catch (error) {
          /* fall through to copy */
        }
      }
      copyText(url).then(
        function () {
          flash(button, 'Link copied');
        },
        function () {
          flash(button, 'Share unavailable');
        },
      );
    });
  }

  /* ---- QR sharing ------------------------------------------------------- */

  // The server renders a working QR page for no-JS users. When a reader has
  // selected a line, add only that numeric anchor as a query to the QR route;
  // the route turns it back into the canonical `#line-N` URL before encoding.
  var qrLinks = doc.querySelectorAll('[data-qr-link]');
  for (var q = 0; q < qrLinks.length; q++) {
    qrLinks[q].addEventListener('click', function (event) {
      var link = event.currentTarget;
      var target = new URL(link.getAttribute('href'), window.location.href);
      var match = /^#line-([1-9][0-9]{0,6})$/.exec(window.location.hash);
      if (match) target.searchParams.set('line', match[1]);
      else target.searchParams.delete('line');
      target.hash = '';
      link.href = target.toString();
    });
  }

  var selectable = doc.querySelectorAll('[data-select-all]');
  for (var a = 0; a < selectable.length; a++) {
    selectable[a].addEventListener('focus', function (event) {
      event.currentTarget.select();
    });
  }

  // Keep the icon in place when showing feedback or toggling a label.
  function buttonLabel(button) {
    return button.querySelector('[data-button-label]') || button;
  }

  function flash(button, message) {
    var label = buttonLabel(button);
    if (!label.hasAttribute('data-label')) label.setAttribute('data-label', label.textContent);
    label.textContent = message;
    button.setAttribute('aria-live', 'polite');
    clearTimeout(button._flashTimer);
    button._flashTimer = setTimeout(function () {
      label.textContent = label.getAttribute('data-label');
    }, 1400);
  }

  // Native details remains usable without JS. Add dismissal, not custom menu
  // roles: every action stays a normal, keyboard-focusable button or link.
  var menus = doc.querySelectorAll('[data-action-menu]');
  for (var m = 0; m < menus.length; m++) {
    menus[m].addEventListener('toggle', function (event) {
      if (!event.currentTarget.open) return;
      for (var i = 0; i < menus.length; i++) {
        if (menus[i] !== event.currentTarget) menus[i].open = false;
      }
    });
  }
  doc.addEventListener('click', function (event) {
    for (var i = 0; i < menus.length; i++) {
      if (menus[i].open && !menus[i].contains(event.target)) menus[i].open = false;
    }
  });
  doc.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    for (var i = 0; i < menus.length; i++) {
      if (menus[i].open) {
        menus[i].open = false;
        menus[i].querySelector('summary').focus();
      }
    }
  });

  /* ---- destructive confirmations ---------------------------------------- */

  var confirms = doc.querySelectorAll('form[data-confirm]');
  for (var d = 0; d < confirms.length; d++) {
    confirms[d].addEventListener('submit', function (event) {
      var form = event.currentTarget;
      if (form.getAttribute('data-confirmed') === '1') return;
      event.preventDefault();
      var button = form.querySelector('[data-confirm-button]');
      var label = button ? buttonLabel(button).textContent : 'Delete';
      if (!form.getAttribute('data-armed')) {
        form.setAttribute('data-armed', '1');
        if (button) buttonLabel(button).textContent = 'Sure? Click again';
        setTimeout(function () {
          form.removeAttribute('data-armed');
          if (button) buttonLabel(button).textContent = label;
        }, 4000);
        return;
      }
      form.setAttribute('data-confirmed', '1');
      form.submit();
    });
  }

  /* ---- wrap toggle on paste view ---------------------------------------- */

  var wrapButtons = doc.querySelectorAll('[data-wrap-toggle]');
  for (var w = 0; w < wrapButtons.length; w++) {
    wrapButtons[w].addEventListener('click', function (event) {
      var button = event.currentTarget;
      var target = doc.querySelector(button.getAttribute('data-wrap-toggle'));
      if (!target) return;
      var wrapped = target.classList.toggle('wrap');
      button.setAttribute('aria-pressed', wrapped ? 'true' : 'false');
      buttonLabel(button).textContent = wrapped ? 'Unwrap' : 'Wrap';
      try {
        localStorage.setItem('mantisbin:wrap', wrapped ? '1' : '0');
      } catch (e) {
        /* ignore */
      }
    });
    var storedWrap = null;
    try {
      storedWrap = localStorage.getItem('mantisbin:wrap');
    } catch (e) {
      storedWrap = null;
    }
    if (storedWrap === '1') {
      var btn = wrapButtons[w];
      var target = doc.querySelector(btn.getAttribute('data-wrap-toggle'));
      if (target) {
        target.classList.add('wrap');
        btn.setAttribute('aria-pressed', 'true');
        buttonLabel(btn).textContent = 'Unwrap';
      }
    }
  }
  /* ---- line formatting (merge phase 1) ---------------------------------- */

  // Formatting is stored beside the text, never inside it: the hidden
  // `formatting` input carries a JSON overlay of `{ line, font?, size?, color? }`
  // entries and the server re-validates every id against its own whitelist. The
  // editor only ever *offers* valid ids, so a paste saved from here cannot be
  // rejected for a bad colour. With JavaScript off this whole bar stays hidden
  // and the paste is saved plain — reading never depends on any of it.

  var formatBar = doc.querySelector('[data-format-toolbar]');
  var formatInput = doc.querySelector('[data-format-input]');
  var formatPreview = doc.querySelector('[data-format-preview]');
  var formatPreviewBody = doc.querySelector('[data-format-preview-body]');
  var formatPreviewNote = doc.querySelector('[data-format-preview-note]');
  var formatStatus = doc.querySelector('[data-format-status]');
  var formatConfig = null;

  if (formatBar && formatInput && editor) {
    try {
      formatConfig = JSON.parse(formatBar.getAttribute('data-format') || '{}');
    } catch (e) {
      formatConfig = null;
    }
  }

  if (formatConfig) {
    var MAX_LINES = Number(formatConfig.maxLines) || 2000;
    // 1-based line number -> { font, size, color }
    var formatMap = {};

    function loadFormatting() {
      formatMap = {};
      var raw = (formatInput.value || '').trim();
      if (!raw) return;
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.lines)) return;
        for (var i = 0; i < parsed.lines.length; i++) {
          var entry = parsed.lines[i];
          if (!entry) continue;
          var line = Number(entry.line);
          if (!isFinite(line) || line < 1) continue;
          var clean = {};
          if (entry.font) clean.font = String(entry.font);
          if (entry.size) clean.size = String(entry.size);
          if (entry.color) clean.color = String(entry.color);
          if (clean.font || clean.size || clean.color) formatMap[line] = clean;
        }
      } catch (e) {
        formatMap = {};
      }
    }

    function serialiseFormatting() {
      var lines = Object.keys(formatMap)
        .map(Number)
        .sort(function (a, b) { return a - b; })
        .slice(0, MAX_LINES)
        .map(function (line) {
          var entry = formatMap[line];
          var out = { line: line };
          if (entry.font) out.font = entry.font;
          if (entry.size) out.size = entry.size;
          if (entry.color) out.color = entry.color;
          return out;
        });
      return lines.length ? JSON.stringify({ v: formatConfig.v || 1, lines: lines }) : '';
    }

    function classFor(entry) {
      var classes = '';
      if (entry.font) classes += ' fmt-f-' + entry.font;
      if (entry.size) classes += ' fmt-s-' + entry.size;
      if (entry.color) classes += ' fmt-c-' + entry.color;
      return classes;
    }

    function lineOfIndex(index) {
      var value = editor.value.slice(0, index);
      var line = 1;
      for (var i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) === 10) line++;
      }
      return line;
    }

    /** The 1-based inclusive line range the current selection covers. */
    function selectedRange() {
      var start = editor.selectionStart;
      var end = editor.selectionEnd;
      var first = lineOfIndex(start);
      var last = lineOfIndex(end);
      // A selection ending exactly at the start of a line does not cover it.
      if (end > start && editor.value.charAt(end - 1) === '\n') last = Math.max(first, last - 1);
      return { first: first, last: Math.max(first, last) };
    }

    function countLines(value) {
      var lines = 1;
      for (var i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) lines++;
      return lines;
    }

    function describe(entry) {
      var parts = [];
      if (entry.font) parts.push(labelOf(formatConfig.fonts, entry.font) || entry.font);
      if (entry.size) parts.push(labelOf(formatConfig.sizes, entry.size) || entry.size);
      if (entry.color) parts.push(labelOf(formatConfig.colors, entry.color) || entry.color);
      return parts.join(' · ');
    }

    function labelOf(list, id) {
      if (!list) return '';
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
      return '';
    }

    function applyToSelection(patch) {
      var range = selectedRange();
      for (var line = range.first; line <= range.last; line++) {
        var entry = formatMap[line] || {};
        if (Object.prototype.hasOwnProperty.call(patch, 'font')) entry.font = patch.font;
        if (Object.prototype.hasOwnProperty.call(patch, 'size')) entry.size = patch.size;
        if (Object.prototype.hasOwnProperty.call(patch, 'color')) entry.color = patch.color;
        if (!entry.font && !entry.size && !entry.color) delete formatMap[line];
        else formatMap[line] = entry;
      }
      syncFormatting(range);
    }

    function clearSelection() {
      var range = selectedRange();
      var removed = 0;
      for (var line = range.first; line <= range.last; line++) {
        if (formatMap[line]) {
          delete formatMap[line];
          removed++;
        }
      }
      syncFormatting(range, removed ? 'Cleared ' + removed + ' line' + (removed === 1 ? '' : 's') + '.' : 'Nothing to clear there.');
    }

    function syncFormatting(range, overrideStatus) {
      var total = countLines(editor.value);
      // Drop hints for lines that no longer exist, so deleting text never
      // leaves stale entries behind.
      Object.keys(formatMap).forEach(function (key) {
        if (Number(key) > total) delete formatMap[key];
      });
      formatInput.value = serialiseFormatting();

      var count = Object.keys(formatMap).length;
      var status = overrideStatus;
      if (!status) {
        var entry = formatMap[range.first];
        var label = 'Select text, then pick a style.';
        if (entry) label = 'Line ' + range.first + ': ' + describe(entry);
        else if (range.last > range.first) label = 'Lines ' + range.first + '–' + range.last + ': plain.';
        status = label;
      }
      if (count > 0 && !overrideStatus) {
        status += ' (' + count + ' formatted line' + (count === 1 ? '' : 's') + ')';
      }
      if (formatStatus) {
        formatStatus.textContent = status;
        formatStatus.className = 'format-status' + (count > 0 ? ' is-active' : '');
      }
      renderFormatPreview(count);
    }

    function renderFormatPreview(count) {
      if (!formatPreview || !formatPreviewBody || formatPreview.hidden) return;
      var value = editor.value;
      var lines = value.split('\n');
      var cap = 400;
      var shown = Math.min(lines.length, cap);
      var fragment = doc.createDocumentFragment();
      for (var i = 0; i < shown; i++) {
        var entry = formatMap[i + 1];
        var div = doc.createElement('div');
        div.className = 'format-preview-line' + (entry ? classFor(entry) : '');
        if (formatConfig.emoji) div.textContent = replaceShortcodes(lines[i], formatConfig.emoji);
        else div.textContent = lines[i];
        fragment.appendChild(div);
      }
      formatPreviewBody.textContent = '';
      formatPreviewBody.appendChild(fragment);
      if (formatPreviewNote) {
        formatPreviewNote.textContent = lines.length > cap
          ? 'Showing the first ' + cap + ' of ' + lines.length + ' lines.'
          : count + ' formatted';
      }
    }

    function replaceShortcodes(line, emoji) {
      return String(line).replace(/[:;]([a-z0-9][a-z0-9_-]{0,31})[:;]/gi, function (match, name) {
        var found = emoji[String(name).toLowerCase()];
        return found ? found : match;
      });
    }

    var fontSelect = formatBar.querySelector('[data-format-font]');
    var sizeSelect = formatBar.querySelector('[data-format-size]');

    if (fontSelect) {
      fontSelect.addEventListener('change', function () {
        applyToSelection({ font: fontSelect.value });
        fontSelect.value = '';
      });
    }
    if (sizeSelect) {
      sizeSelect.addEventListener('change', function () {
        applyToSelection({ size: sizeSelect.value });
        sizeSelect.value = '';
      });
    }

    var swatches = formatBar.querySelectorAll('[data-format-color]');
    for (var sw = 0; sw < swatches.length; sw++) {
      swatches[sw].addEventListener('click', function (event) {
        applyToSelection({ color: event.currentTarget.getAttribute('data-format-color') });
      });
    }

    var clearButton = formatBar.querySelector('[data-format-clear]');
    if (clearButton) clearButton.addEventListener('click', clearSelection);

    var previewToggle = formatBar.querySelector('[data-format-preview-toggle]');
    if (previewToggle) {
      previewToggle.addEventListener('click', function () {
        var open = formatPreview.hidden;
        formatPreview.hidden = !open;
        previewToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
        if (open) renderFormatPreview(Object.keys(formatMap).length);
      });
    }

    // Selecting lines updates the status line; typing updates it too (and prunes
    // hints for lines that disappeared).
    editor.addEventListener('keyup', function () { syncFormatting(selectedRange()); });
    editor.addEventListener('mouseup', function () { syncFormatting(selectedRange()); });
    editor.addEventListener('input', function () { syncFormatting(selectedRange()); });
    editor.addEventListener('blur', function () { syncFormatting(selectedRange()); });

    // The bar is only useful with scripting: reveal it now that it works.
    formatBar.hidden = false;
    loadFormatting();
    syncFormatting(selectedRange());
  }

  /* ---- stickers & GIFs (merge phase 4) ---------------------------------- */

  /**
   * The editor's media panel: emoji, the curated sticker pack and GIF search.
   *
   * Everything here is a shortcut for typing. The server already renders
   * `:wave:` shortcodes and a bare image URL on its own line, so the panel is a
   * plain `<details>` that degrades to instructions. The one network call goes
   * to this site's own `/api/gifs` (never to Giphy or Nekos.best directly —
   * `connect-src 'self'` would refuse that anyway), and the endpoint is taken
   * from the markup rather than hard-coded.
   */
  var mediaPanel = doc.querySelector('[data-media-panel]');
  if (mediaPanel && editor) initMediaPanel(mediaPanel);

  function initMediaPanel(panel) {
    var endpoint = panel.getAttribute('data-media-endpoint') || '/api/gifs';
    var status = panel.querySelector('[data-media-status]');
    var grid = panel.querySelector('[data-media-grid]');
    var searchForm = panel.querySelector('[data-media-search]');
    var queryInput = panel.querySelector('[data-media-query]');
    var categorySelect = panel.querySelector('[data-media-category]');
    var tabs = panel.querySelectorAll('[data-media-tab]');
    var panes = panel.querySelectorAll('[data-media-pane]');
    var emoji = {};
    try {
      emoji = JSON.parse(panel.getAttribute('data-media-emoji') || '{}').emoji || {};
    } catch (error) {
      emoji = {};
    }
    var loadedTrending = false;

    function say(message) {
      if (status) status.textContent = message || '';
    }

    /** Insert text at the caret and leave the caret after it. */
    function insert(text) {
      var start = editor.selectionStart;
      var end = editor.selectionEnd;
      var value = editor.value;
      editor.value = value.slice(0, start) + text + value.slice(end);
      var caret = start + text.length;
      editor.selectionStart = caret;
      editor.selectionEnd = caret;
      editor.focus();
      // The byte counter, gutter and draft saver all listen for this.
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /** A picture URL only renders when it is the whole line, so pad it. */
    function insertUrl(url) {
      var value = editor.value;
      var start = editor.selectionStart;
      var end = editor.selectionEnd;
      var lead = start > 0 && value.charAt(start - 1) !== '\n' ? '\n' : '';
      var tail = end < value.length && value.charAt(end) !== '\n' ? '\n' : '';
      insert(lead + url + tail);
    }

    function selectTab(name) {
      Array.prototype.forEach.call(tabs, function (tab) {
        tab.setAttribute('aria-selected', tab.getAttribute('data-media-tab') === name ? 'true' : 'false');
      });
      Array.prototype.forEach.call(panes, function (pane) {
        pane.hidden = pane.getAttribute('data-media-pane') !== name;
      });
      // Trending is fetched the first time somebody actually asks for a GIF.
      if (name === 'gifs' && !loadedTrending) load('');
    }

    function tile(gif) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.className = 'media-tile';
      button.setAttribute('data-media-url', gif.url);
      button.title = gif.label || 'Insert this GIF';
      button.setAttribute('aria-label', gif.label || 'Insert this GIF');
      var image = doc.createElement('img');
      image.src = gif.preview || gif.url;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.width = 120;
      image.height = 90;
      button.appendChild(image);
      if (gif.provider === 'neko') {
        var mark = doc.createElement('span');
        mark.className = 'media-tile-mark';
        mark.textContent = 'anime';
        button.appendChild(mark);
      }
      return button;
    }

    function show(gifs, degraded) {
      if (!grid) return;
      grid.textContent = '';
      if (degraded || !gifs || !gifs.length) {
        say(degraded ? 'GIF search is unavailable right now. Try again shortly.' : 'No GIFs found. Try another word.');
        return;
      }
      for (var i = 0; i < gifs.length; i++) grid.appendChild(tile(gifs[i]));
      say(gifs.length + (gifs.length === 1 ? ' GIF' : ' GIFs') + ' from ' + (gifs[0].provider === 'neko' ? 'Nekos.best' : 'Giphy'));
    }

    function load(query, category) {
      var url = endpoint + '?limit=24';
      if (category) url += '&category=' + encodeURIComponent(category);
      else if (query) url += '&q=' + encodeURIComponent(query);
      if (grid) grid.textContent = '';
      say(query ? 'Searching…' : 'Loading…');
      fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (response) {
          if (!response.ok) throw new Error('bad status ' + response.status);
          return response.json();
        })
        .then(function (data) {
          loadedTrending = true;
          show(data.gifs, data.degraded);
        })
        .catch(function () {
          say('GIF search is unavailable right now. Try again shortly.');
        });
    }

    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        selectTab(tab.getAttribute('data-media-tab'));
      });
    });

    panel.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-media-insert]');
      if (chip) {
        var token = chip.getAttribute('data-media-insert') || '';
        insert(token + ' ');
        say(emoji[token.slice(1, -1)] ? 'Inserted ' + emoji[token.slice(1, -1)] + ' ' + token : 'Inserted ' + token);
        return;
      }
      var choice = event.target.closest('[data-media-url]');
      if (choice) {
        insertUrl(choice.getAttribute('data-media-url'));
        say('Added on its own line — it renders as a picture.');
      }
    });

    if (searchForm) {
      searchForm.addEventListener('submit', function (event) {
        event.preventDefault();
        load(queryInput ? queryInput.value.trim() : '', categorySelect ? categorySelect.value : '');
      });
    }
    if (categorySelect) {
      categorySelect.addEventListener('change', function () {
        if (categorySelect.value) load('', categorySelect.value);
      });
    }
  }

  /* ---- notification badge (merge phase 4) ------------------------------- */

  /**
   * Keep the header's unread count honest between page loads.
   *
   * This is the only thing the bell wants from JavaScript: `/notifications` and
   * every page behind it are server-rendered, and the count is already correct
   * in the HTML. The poll is deliberately slow, waits for a visible tab, and
   * gives up for good on a 401/429 rather than hammering the endpoint.
   */
  var unreadBell = doc.querySelector('[data-unread-bell]');
  if (unreadBell) initUnreadBadge(unreadBell);

  function initUnreadBadge(link) {
    var endpoint = link.getAttribute('data-unread-endpoint') || '/api/notifications/unread';
    var badge = link.querySelector('[data-unread-badge]');
    var max = Number(badge && badge.getAttribute('data-max')) || 9;
    var stopped = false;
    var ticking = false;

    function render(count) {
      var text = count > max ? max + '+' : String(count);
      if (badge) {
        badge.textContent = text;
        badge.hidden = count === 0;
      }
      var description = count ? count + ' unread notification' + (count === 1 ? '' : 's') : 'Notifications';
      link.setAttribute('aria-label', description);
      link.title = description;
    }

    function tick() {
      if (stopped || ticking || doc.hidden) return;
      ticking = true;
      fetch(endpoint, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (response) {
          if (response.status === 401 || response.status === 429) {
            stopped = true;
            return null;
          }
          return response.ok ? response.json() : null;
        })
        .then(function (data) {
          if (data && typeof data.unread === 'number') render(data.unread);
        })
        .catch(function () {
          // Offline, or the fetch was blocked: the rendered count stands.
        })
        .then(function () {
          ticking = false;
        });
    }

    setInterval(tick, 60000);
    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden) tick();
    });
  }

  /* ---- profile customiser (merge phase 2) -------------------------------- */

  /**
   * The three conveniences on /me/profile: a live preview, link rows and
   * counters. The form itself is complete without any of this — it posts and
   * validates on the server — so everything here is additive, and every hook
   * is optional.
   *
   * The preview works by re-pointing the page's generated stylesheet
   * (`/u/:username/theme.css`) at an unsaved `?preview=1&...` URL. That is the
   * same generator the real profile uses, which is why the preview cannot
   * drift from the result — and it needs no inline styles, so the strict CSP
   * is untouched.
   */
  var profileForm = doc.querySelector('[data-profile-form]');
  if (profileForm) initProfileCustomiser(profileForm);

  function initProfileCustomiser(form) {
    var themeLink = doc.querySelector('link[rel="stylesheet"][href*="/theme.css"]');
    var themeBase = themeLink ? themeLink.getAttribute('href').split('?')[0] : null;
    var previewName = form.querySelector('[data-preview-name]');
    var previewStatus = form.querySelector('[data-preview-status]');
    var previewBio = form.querySelector('[data-preview-bio]');
    var previewLinks = form.querySelector('[data-preview-links]');
    var previewHero = form.querySelector('[data-preview-hero]');
    var previewNote = form.querySelector('[data-preview-note]');
    var displayNameInput = form.querySelector('[name="display_name"]');
    var bioInput = form.querySelector('[name="bio"]');
    var bioToggle = form.querySelector('input[type="checkbox"][name="bio_enabled"]');
    var statusInput = form.querySelector('[data-status-input]');
    var statusTextInput = form.querySelector('[name="status_text"]');
    var accentInput = form.querySelector('[data-accent-input]');
    var effectSelect = form.querySelector('[data-effect-select]');
    var speedInput = form.querySelector('[data-effect-speed]');
    var intensityInput = form.querySelector('[data-effect-intensity]');
    var bannerInput = form.querySelector('[data-banner-url]');
    var linkRows = form.querySelector('[data-link-rows]');
    var linkTemplate = form.querySelector('[data-link-template]');
    var addLink = form.querySelector('[data-link-add]');
    var timer = null;

    function effectClass() {
      if (!effectSelect) return '';
      var option = effectSelect.options[effectSelect.selectedIndex];
      return (option && option.getAttribute('data-class')) || '';
    }

    function bannerType() {
      var checked = form.querySelector('[data-banner-type]:checked');
      return checked ? checked.value : 'image';
    }

    /** Everything a visitor would see, recomputed from the form. */
    function renderPreview() {
      if (previewName) {
        var fallback = displayNameInput && displayNameInput.placeholder ? displayNameInput.placeholder : '';
        previewName.textContent = (displayNameInput && displayNameInput.value.trim()) || fallback;
        previewName.className = 'fx' + (effectClass() ? ' ' + effectClass() : '');
      }
      if (previewStatus) {
        var emoji = statusInput ? statusInput.value.trim() : '';
        var text = statusTextInput ? statusTextInput.value.trim() : '';
        previewStatus.textContent = (emoji ? emoji + ' ' : '') + text;
        previewStatus.hidden = !emoji && !text;
      }
      if (previewBio) {
        var bio = bioInput ? bioInput.value.trim() : '';
        var show = bio && (!bioToggle || bioToggle.checked);
        previewBio.textContent = show ? bio : '';
        previewBio.hidden = !show;
      }
      if (previewLinks && linkRows) {
        var chips = [];
        Array.prototype.forEach.call(linkRows.querySelectorAll('.link-row'), function (row) {
          var url = row.querySelector('[name="link_url"]');
          var label = row.querySelector('[name="link_label"]');
          var value = url ? url.value.trim() : '';
          if (!value) return;
          chips.push((label && label.value.trim()) || value.replace(/^https?:\/\//, ''));
        });
        previewLinks.textContent = '';
        chips.slice(0, 6).forEach(function (label) {
          var chip = doc.createElement('span');
          chip.className = 'link-chip';
          chip.textContent = label;
          previewLinks.appendChild(chip);
        });
        previewLinks.hidden = !chips.length;
      }
      if (previewHero) previewHero.classList.toggle('has-banner', Boolean((bannerInput && bannerInput.value.trim()) || bannerType() === 'gradient'));
    }

    /** Re-point the theme stylesheet at the unsaved values (debounced). */
    function scheduleTheme() {
      if (previewNote) previewNote.textContent = 'Unsaved preview';
      if (!themeBase) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        var query = [
          'preview=1',
          'accent=' + encodeURIComponent(accentInput ? accentInput.value : ''),
          'effect=' + encodeURIComponent(effectSelect ? effectSelect.value : 'none'),
          'speed=' + encodeURIComponent(speedInput ? speedInput.value : ''),
          'intensity=' + encodeURIComponent(intensityInput ? intensityInput.value : ''),
          'bannerType=' + encodeURIComponent(bannerType()),
          'banner=' + encodeURIComponent(bannerInput ? bannerInput.value.trim() : ''),
        ].join('&');
        themeLink.href = themeBase + '?' + query;
      }, 200);
    }

    function refresh() {
      renderPreview();
      scheduleTheme();
    }

    // Counters: any input with data-count-to updates the element carrying the
    // matching data-count.
    Array.prototype.forEach.call(form.querySelectorAll('[data-count-to]'), function (input) {
      var target = form.querySelector('[data-count="' + input.getAttribute('data-count-to') + '"]');
      if (!target) return;
      var update = function () {
        target.textContent = String(input.value.length);
      };
      input.addEventListener('input', update);
      update();
    });

    // Range readouts.
    [[speedInput, '[data-effect-speed-out]'], [intensityInput, '[data-effect-intensity-out]']].forEach(function (pair) {
      var output = pair[1] ? form.querySelector(pair[1]) : null;
      if (!pair[0] || !output) return;
      pair[0].addEventListener('input', function () {
        output.textContent = pair[0].value;
      });
    });

    // Accent presets + the emoji quick picks just fill their input.
    Array.prototype.forEach.call(form.querySelectorAll('[data-accent-preset]'), function (button) {
      button.addEventListener('click', function () {
        if (!accentInput) return;
        accentInput.value = button.getAttribute('data-accent-preset');
        refresh();
      });
    });
    Array.prototype.forEach.call(form.querySelectorAll('[data-status-emoji]'), function (button) {
      button.addEventListener('click', function () {
        if (!statusInput) return;
        statusInput.value = button.getAttribute('data-status-emoji');
        statusInput.focus();
        refresh();
      });
    });

    // Link rows: add, and remove (the last row is cleared instead of removed,
    // so the form always posts something the server can name).
    if (addLink && linkRows && linkTemplate) {
      addLink.addEventListener('click', function () {
        var fragment = linkTemplate.content.cloneNode(true);
        linkRows.appendChild(fragment);
        var added = linkRows.lastElementChild;
        var first = added ? added.querySelector('input') : null;
        if (first) first.focus();
        refresh();
      });
    }
    if (linkRows) {
      linkRows.addEventListener('click', function (event) {
        var button = event.target.closest('[data-link-remove]');
        if (!button) return;
        var row = button.closest('.link-row');
        if (!row) return;
        if (linkRows.querySelectorAll('.link-row').length > 1) row.remove();
        else Array.prototype.forEach.call(row.querySelectorAll('input'), function (input) { input.value = ''; });
        refresh();
      });
      linkRows.addEventListener('input', refresh);
    }

    [displayNameInput, bioInput, statusInput, statusTextInput, bannerInput, effectSelect, accentInput, speedInput, intensityInput].forEach(
      function (input) {
        if (!input) return;
        input.addEventListener('input', refresh);
        input.addEventListener('change', refresh);
      },
    );
    Array.prototype.forEach.call(form.querySelectorAll('[data-banner-type]'), function (radio) {
      radio.addEventListener('change', refresh);
    });
    if (bioToggle) bioToggle.addEventListener('change', refresh);

    renderPreview();
  }
})();
