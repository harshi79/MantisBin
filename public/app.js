/* MantisBin — client enhancements.
 * The site is fully usable without JavaScript; this file only adds:
 *   - instant theme switching (cookie + attribute, no reload)
 *   - live byte counter + Tab/Ctrl+Enter niceties in the editor
 *   - remembered language/font/size for the create form
 *   - copy-to-clipboard buttons and delete confirmations
 * No frameworks, no network calls.
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

  function applyTheme(value) {
    root.setAttribute('data-theme', value);
    var forms = doc.querySelectorAll('form[data-theme-form]');
    for (var i = 0; i < forms.length; i++) {
      var input = forms[i].querySelector('input[name="theme"]');
      if (input) input.value = value === 'light' ? 'dark' : 'light';
      var label = forms[i].querySelector('[data-theme-label]');
      if (label) label.textContent = value === 'light' ? 'Dark' : 'Light';
    }
  }

  var themeForms = doc.querySelectorAll('form[data-theme-form]');
  for (var t = 0; t < themeForms.length; t++) {
    themeForms[t].addEventListener('submit', function (event) {
      event.preventDefault();
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      setThemeCookie(next);
      applyTheme(next);
    });
  }

  /* ---- editor ------------------------------------------------------------ */

  var editor = doc.querySelector('textarea[name="content"]');
  var counter = doc.querySelector('[data-counter]');

  function updateCounter() {
    if (!editor || !counter) return;
    var value = editor.value;
    var bytes;
    if (/[^\x00-\x7F]/.test(value)) {
      bytes = new TextEncoder().encode(value).length;
    } else {
      bytes = value.length;
    }
    var limit = Number(counter.getAttribute('data-limit')) || 0;
    counter.textContent = formatBytes(bytes) + ' / ' + formatBytes(limit);
    counter.setAttribute('data-over', bytes > limit ? 'true' : 'false');
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
    });
    updateCounter();

    // Tab inserts spaces instead of leaving the editor.
    editor.addEventListener('keydown', function (event) {
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        var spaces = '    ';
        editor.setRangeText(spaces, start, end, 'end');
        editor.dispatchEvent(new Event('input'));
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        var form = editor.closest('form');
        if (form && form.requestSubmit) form.requestSubmit();
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
      });
    });

    // Live font/size preview while typing.
    function previewFont() {
      var font = remember.querySelector('[name="font"]');
      var size = remember.querySelector('[name="font_size"]');
      var target = remember.querySelector('textarea[name="content"]');
      if (!font || !size || !target) return;
      target.className = target.className.replace(/\bfont-\S+/g, '').replace(/\bfs-\d+/g, '');
      target.classList.add('font-' + font.value);
      target.classList.add('fs-' + size.value);
    }
    var fontSelect = remember.querySelector('[name="font"]');
    var sizeSelect = remember.querySelector('[name="font_size"]');
    if (fontSelect) fontSelect.addEventListener('change', previewFont);
    if (sizeSelect) sizeSelect.addEventListener('change', previewFont);
    previewFont();
  }

  /* ---- copy buttons ------------------------------------------------------ */

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

  var copyButtons = doc.querySelectorAll('[data-copy]');
  for (var c = 0; c < copyButtons.length; c++) {
    copyButtons[c].addEventListener('click', function (event) {
      var button = event.currentTarget;
      var selector = button.getAttribute('data-copy');
      var source = selector === 'self' ? null : doc.querySelector(selector);
      var text = button.getAttribute('data-copy-text');
      if (!text && source) text = source.value !== undefined ? source.value : source.textContent;
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

  function flash(button, message) {
    var original = button.getAttribute('data-label') || button.textContent;
    if (!button.getAttribute('data-label')) button.setAttribute('data-label', original);
    button.textContent = message;
    button.setAttribute('aria-live', 'polite');
    setTimeout(function () {
      button.textContent = button.getAttribute('data-label');
    }, 1400);
  }

  /* ---- destructive confirmations ---------------------------------------- */

  var confirms = doc.querySelectorAll('form[data-confirm]');
  for (var d = 0; d < confirms.length; d++) {
    confirms[d].addEventListener('submit', function (event) {
      var form = event.currentTarget;
      if (form.getAttribute('data-confirmed') === '1') return;
      event.preventDefault();
      var button = form.querySelector('[data-confirm-button]');
      var label = button ? button.textContent : 'Delete';
      if (!form.getAttribute('data-armed')) {
        form.setAttribute('data-armed', '1');
        if (button) button.textContent = 'Sure? Click again';
        setTimeout(function () {
          form.removeAttribute('data-armed');
          if (button) button.textContent = label;
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
      button.textContent = wrapped ? 'Unwrap' : 'Wrap';
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
        btn.textContent = 'Unwrap';
      }
    }
  }
})();
