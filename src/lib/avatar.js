/**
 * Deterministic profile avatars — no uploads, no storage, no external service.
 *
 * A username hashes (FNV-1a) to a hue and a symmetric 5×5 identicon, rendered
 * as a dependency-free SVG. The same username always yields the same avatar on
 * every machine, and the SVG carries no user text at all (geometry only), so
 * it is safe to inline or serve as an image.
 */

/** Mantis greens + complementary hues; avatars stay on-palette in every theme. */
const HUES = [95, 140, 180, 210, 260, 300, 330, 20];

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * @param {unknown} username
 * @returns {{ hue: number, cells: boolean[] }} 15 cells mirrored into a 5×5 grid
 */
export function avatarPattern(username) {
  const key = String(username || '').toLowerCase().trim() || 'mantisbin';
  const hue = HUES[fnv1a(`hue:${key}`) % HUES.length];
  const cells = [];
  let bits = fnv1a(`cells:${key}`);
  for (let i = 0; i < 15; i++) {
    // Re-mix so all 15 cells are independent, not a 32-bit window.
    if (i % 8 === 0) bits = fnv1a(`cells:${key}:${i}`) ^ (bits >>> (i % 5));
    cells.push(((bits >>> (i % 8)) & 1) === 1);
  }
  return { hue, cells };
}

/**
 * Render the avatar as a standalone SVG document (also safe to inline).
 * @param {unknown} username
 * @param {number} [size] pixel size of the square viewport
 * @returns {string}
 */
export function avatarSvg(username, size = 96) {
  const side = Number.isFinite(Number(size)) ? Math.min(Math.max(Math.round(Number(size)), 16), 512) : 96;
  const { hue, cells } = avatarPattern(username);
  const unit = 100 / 5;
  let rects = '';
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      // Mirror the left two columns onto the right for symmetry.
      const source = col < 3 ? col : 4 - col;
      if (!cells[row * 3 + source]) continue;
      const x = (col * unit).toFixed(2);
      const y = (row * unit).toFixed(2);
      rects += `<rect x="${x}" y="${y}" width="${unit.toFixed(2)}" height="${unit.toFixed(2)}"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${side}" height="${side}" role="img">` +
    `<rect width="100" height="100" rx="22" fill="hsl(${hue} 32% 16%)"/>` +
    `<g fill="hsl(${hue} 55% 62%)">${rects}</g>` +
    `</svg>`
  );
}
