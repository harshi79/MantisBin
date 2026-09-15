/**
 * MantisBin brand mark — single source of truth.
 *
 * One geometric mantis: triangular head whose eyes are punched out with
 * `fill-rule="evenodd"` (the mark therefore stays single-colour and shows the
 * page background through the eyes on any theme), raised raptorial forelegs,
 * slender thorax, leaf abdomen, antennae.
 *
 * Pure geometry: no gradients, no extra colours, no masks, no <style> blocks,
 * so it can be inlined anywhere under a strict CSP. Ink is `currentColor`
 * unless a concrete colour is substituted (favicon / lockup).
 *
 * Used everywhere:
 *   - inline in the UI header/footer/hero  -> inlineMark()
 *   - /mark.svg    (monochrome, currentColor)
 *   - /logo.svg    (mark + wordmark lockup)
 *   - /favicon.svg (self-contained dark tile, fixed colours)
 */

import { SafeHtml, esc } from '../lib/html.js';

const ATTRS = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';

/** Head with two eye holes + abdomen, as one even-odd filled shape. */
const FILLED =
  'M16 12.6 11.7 6.5q4.3-2.1 8.6 0Z ' + // head
  'M12.75 7.6a.95.95 0 1 0 1.9 0 .95.95 0 1 0-1.9 0 ' + // left eye (hole)
  'M17.35 7.6a.95.95 0 1 0 1.9 0 .95.95 0 1 0-1.9 0 ' + // right eye (hole)
  'M16 17.6c3.4 3.1 3.6 8.7 0 12.6-3.6-3.9-3.4-9.5 0-12.6Z'; // abdomen

/** Mark geometry with `{{COLOR}}` substituted for the ink colour. */
function body(color) {
  return [
    '<path d="M13.6 6.2 9.9 2.8" stroke-width="1.5"/>',
    '<path d="M18.4 6.2 22.1 2.8" stroke-width="1.5"/>',
    '<path d="M16 12.5v5.1" stroke-width="2.5"/>',
    '<path d="M14.8 16 9.6 13.6 7.3 8.8" stroke-width="1.8"/>',
    '<path d="M17.2 16 22.4 13.6 24.7 8.8" stroke-width="1.8"/>',
    `<path fill="${color}" fill-rule="evenodd" stroke-width="1.3" d="${FILLED}"/>`,
  ].join('');
}

/**
 * Inline <svg> for use inside pages: ink follows CSS `color`.
 * @param {{ size?: number, title?: string, className?: string }} [options]
 * @returns {SafeHtml}
 */
export function inlineMark({ size = 22, title, className } = {}) {
  const label = title ? `<title>${esc(title)}</title>` : '';
  const aria = title ? `role="img" aria-label="${esc(title)}"` : 'aria-hidden="true" focusable="false"';
  const cls = className ? ` class="${esc(className)}"` : '';
  return new SafeHtml(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}"${cls} ${ATTRS} stroke="currentColor" ${aria}>` +
      label +
      body('currentColor') +
      '</svg>',
  );
}

/** Standalone monochrome icon file (currentColor). */
export function markSvg() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" ${ATTRS} stroke="currentColor">`,
    body('currentColor'),
    '</svg>',
    '',
  ].join('\n');
}

/** Favicon: dark rounded tile + light mark so it reads on any browser theme. */
export function faviconSvg() {
  const tile = '#10141a';
  const ink = '#e6ebef';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    `<rect width="32" height="32" rx="7" fill="${tile}"/>`,
    `<g transform="translate(3.4 3.2) scale(0.79)" ${ATTRS} stroke="${ink}">`,
    body(ink),
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

/**
 * Horizontal lockup: mark + MantisBin wordmark.
 * @param {{ height?: number, color?: string }} [options]
 */
export function logoSvg({ height = 34, color = 'currentColor' } = {}) {
  const width = Math.round(height * 4.1);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 32" width="${width}" height="${height}" ${ATTRS} stroke="${color}">`,
    body(color),
    `<text x="38" y="21.5" fill="${color}" stroke="none" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="16" font-weight="650" letter-spacing="-0.4">MantisBin</text>`,
    '</svg>',
    '',
  ].join('\n');
}
