/**
 * Profile name effects (merge phase 2).
 *
 * Ported from VibeBin's `nameEffects.ts`, which offered 55 effects in nine
 * categories and applied them with inline styles. MantisBin has no inline
 * styles (`style-src 'self'`), so every effect here is a **static class** in
 * `public/app.css` and the only per-profile inputs are the two variables the
 * generated theme sheet sets: `--name-speed` and `--name-strength`.
 *
 * Two deliberate differences from VibeBin:
 *
 *  1. **`typewriter` is not ported.** It needs JavaScript to re-type the name
 *     on every load; MantisBin keeps the profile page script-free, and a
 *     half-working animation is worse than none.
 *  2. **40 of the 55 effects are ported** — every category, with the
 *     near-duplicates (`glitch-hard`, `glitch-rgb`, `shadow-3d`, …) left out.
 *     Adding one back is a catalogue row plus one CSS block; the tests assert
 *     that every id here has its class in `app.css`, so a missing rule fails
 *     the suite instead of silently doing nothing.
 *
 * Unknown or legacy ids (including a value from a future release) render plain
 * rather than failing the page.
 */

/** @typedef {{ id: string, label: string, emoji: string, category: string, className: string }} NameEffect */

/** Category order in the picker. */
export const EFFECT_CATEGORIES = [
  'Basics',
  'Gradients',
  'Shimmer & sparkle',
  'Neon & glow',
  'Fire & ice',
  'Cyber & retro',
  'Wave & motion',
  'Shadow & outline',
  'Minimal & subtle',
];

/** @type {NameEffect[]} */
export const NAME_EFFECTS = [
  { id: 'none', label: 'None', emoji: '◻️', category: 'Basics', className: '' },

  { id: 'gradient-flow', label: 'Flow', emoji: '🎨', category: 'Gradients', className: 'name-gradient-flow' },
  { id: 'sunset', label: 'Sunset', emoji: '🌇', category: 'Gradients', className: 'name-sunset' },
  { id: 'ocean', label: 'Ocean', emoji: '🌊', category: 'Gradients', className: 'name-ocean' },
  { id: 'candy', label: 'Candy', emoji: '🍬', category: 'Gradients', className: 'name-candy' },
  { id: 'lava', label: 'Lava', emoji: '🌋', category: 'Gradients', className: 'name-lava' },
  { id: 'forest', label: 'Forest', emoji: '🌲', category: 'Gradients', className: 'name-forest' },
  { id: 'rainbow', label: 'Rainbow', emoji: '🌈', category: 'Gradients', className: 'name-rainbow' },
  { id: 'gold', label: 'Gold', emoji: '🥇', category: 'Gradients', className: 'name-gold' },

  { id: 'shimmer', label: 'Shimmer', emoji: '✨', category: 'Shimmer & sparkle', className: 'name-shimmer' },
  { id: 'glitter', label: 'Glitter', emoji: '🎊', category: 'Shimmer & sparkle', className: 'name-glitter' },
  { id: 'prism', label: 'Prism', emoji: '🔮', category: 'Shimmer & sparkle', className: 'name-prism' },

  { id: 'neon', label: 'Neon glow', emoji: '💡', category: 'Neon & glow', className: 'name-neon' },
  { id: 'glow-pulse', label: 'Breathing glow', emoji: '💓', category: 'Neon & glow', className: 'name-glow-pulse' },
  { id: 'neon-flicker', label: 'Flicker sign', emoji: '🚥', category: 'Neon & glow', className: 'name-neon-flicker' },
  { id: 'electric', label: 'Electric', emoji: '⚡', category: 'Neon & glow', className: 'name-electric' },
  { id: 'aurora', label: 'Aurora', emoji: '🌌', category: 'Neon & glow', className: 'name-aurora' },

  { id: 'fire', label: 'Fire', emoji: '🔥', category: 'Fire & ice', className: 'name-fire' },
  { id: 'ember', label: 'Ember', emoji: '🪵', category: 'Fire & ice', className: 'name-ember' },
  { id: 'ice', label: 'Ice', emoji: '❄️', category: 'Fire & ice', className: 'name-ice' },
  { id: 'frost', label: 'Frost', emoji: '🧊', category: 'Fire & ice', className: 'name-frost' },

  { id: 'cyber', label: 'Cyber', emoji: '🖥️', category: 'Cyber & retro', className: 'name-cyber' },
  { id: 'holographic', label: 'Holographic', emoji: '📀', category: 'Cyber & retro', className: 'name-holographic' },
  { id: 'matrix', label: 'Matrix', emoji: '🟢', category: 'Cyber & retro', className: 'name-matrix' },
  { id: 'glitch', label: 'Glitch', emoji: '📺', category: 'Cyber & retro', className: 'name-glitch' },
  { id: 'vhs', label: 'VHS', emoji: '📼', category: 'Cyber & retro', className: 'name-vhs' },
  { id: 'arcade', label: 'Arcade', emoji: '🎮', category: 'Cyber & retro', className: 'name-arcade' },

  { id: 'float', label: 'Float', emoji: '🎈', category: 'Wave & motion', className: 'name-float' },
  { id: 'bounce', label: 'Bounce', emoji: '🏀', category: 'Wave & motion', className: 'name-bounce' },
  { id: 'swing', label: 'Swing', emoji: '🎠', category: 'Wave & motion', className: 'name-swing' },
  { id: 'pulse', label: 'Pulse', emoji: '📶', category: 'Wave & motion', className: 'name-pulse' },

  { id: 'outline', label: 'Outline', emoji: '✏️', category: 'Shadow & outline', className: 'name-outline' },
  { id: 'long-shadow', label: 'Long shadow', emoji: '🌓', category: 'Shadow & outline', className: 'name-long-shadow' },
  { id: 'double-shadow', label: 'Double shadow', emoji: '🎭', category: 'Shadow & outline', className: 'name-double-shadow' },
  { id: 'emboss', label: 'Emboss', emoji: '🪙', category: 'Shadow & outline', className: 'name-emboss' },

  { id: 'soft', label: 'Soft', emoji: '🌸', category: 'Minimal & subtle', className: 'name-soft' },
  { id: 'ghost', label: 'Ghost', emoji: '👻', category: 'Minimal & subtle', className: 'name-ghost' },
  { id: 'underline', label: 'Grow underline', emoji: '➖', category: 'Minimal & subtle', className: 'name-underline' },
  { id: 'highlight', label: 'Highlighter', emoji: '🖍️', category: 'Minimal & subtle', className: 'name-highlight' },
  { id: 'blink', label: 'Blink', emoji: '👁️', category: 'Minimal & subtle', className: 'name-blink' },
  { id: 'fade', label: 'Fade', emoji: '🌫️', category: 'Minimal & subtle', className: 'name-fade' },
];

const BY_ID = new Map(NAME_EFFECTS.map((effect) => [effect.id, effect]));

/** Is this an effect this build can render? */
export function isNameEffect(value) {
  return BY_ID.has(String(value ?? ''));
}

/** Unknown or legacy ids (including VibeBin's removed `typewriter`) render plain. */
export function sanitizeNameEffect(value) {
  return isNameEffect(value) ? String(value) : 'none';
}

/**
 * The `class` attribute for an effect, or '' for `none`.
 *
 * The `fx` scope is part of this helper (every rule in app.css is written as
 * `.fx.name-…`) so call sites never have to remember it, and the customiser's
 * live preview gets a ready-to-use value from the same place the profile page
 * does.
 */
export function nameEffectClass(value) {
  const className = BY_ID.get(sanitizeNameEffect(value))?.className || '';
  return className ? `fx ${className}` : '';
}

/** Effects grouped by category, for the picker. */
export function groupedNameEffects() {
  return EFFECT_CATEGORIES.map((category) => ({
    category,
    effects: NAME_EFFECTS.filter((effect) => effect.category === category),
  })).filter((group) => group.effects.length);
}
