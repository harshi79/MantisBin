/* MantisBin — client enhancements.
 * The site is fully usable without JavaScript; this file only adds:
 *   - instant theme switching (cookie + attribute, no reload)
 *   - live byte counter + Tab/Ctrl+Enter niceties in the editor
 *   - remembered language/font/size for the create form
 *   - local draft recovery for the create form
 *   - copy, share, select-all and delete-confirmation helpers
 * No frameworks, no network calls, no inline event handlers.
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
    gutter.hidden = false;
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

  /* ---- local draft recovery --------------------------------------------- */

  var DRAFT_KEY = 'mantisbin:draft:v1';
  // Avoid repeatedly serialising a full multi-megabyte paste on every keystroke.
  var DRAFT_MAX_BYTES = 1024 * 1024;
  var draftForm = remember && remember.getAttribute('data-draft') ? remember : null;
  var draftTimer = null;
  var draftSubmitted = false;

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
  // local drafts are plain-text in localStorage, so secrets never go in them.
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
    if (!draftForm || draftSubmitted || !editor) return;
    var values = draftValues();
    var meaningfulTitle = values.title && values.title !== defaultTitle() ? values.title : '';
    if (!meaningfulTitle && !values.content) {
      clearDraft(false);
      setDraftButtons(false);
      setDraftStatus('Drafts stay in this browser.');
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
      setDraftButtons(true);
      setDraftStatus('Draft saved locally at ' + new Date(values.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.');
    } catch (e) {
      setDraftStatus('Draft autosave is unavailable in this browser.');
    }
  }

  function scheduleDraftSave() {
    if (!draftForm || draftSubmitted) return;
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
})();
