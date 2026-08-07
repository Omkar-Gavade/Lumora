/**
 * Asserts WCAG contrast on every semantic token pair, in both themes.
 * A theme change that breaks contrast fails here rather than in an audit.
 * Run: node scripts/check-contrast.mjs
 */
const toRgb = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3)
    s = [...s].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
};
const linear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (h) => {
  const [r, g, b] = toRgb(h).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** [label, foreground, background, minimum] */
const CASES = [
  ['light · text-primary on canvas', '#141418', '#ffffff', 4.5],
  ['light · text-secondary on canvas', '#55555f', '#ffffff', 4.5],
  ['light · text-tertiary on canvas', '#6e6e7c', '#ffffff', 4.5],
  ['light · text-secondary on subtle', '#55555f', '#f7f7f9', 4.5],
  ['light · accent link on canvas', '#4f46e5', '#ffffff', 4.5],
  ['light · accent on accent-subtle', '#4f46e5', '#eef0fe', 4.5],
  ['light · on-ink on ink-solid', '#ffffff', '#141418', 4.5],
  ['light · focus ring on canvas', '#4f46e5', '#ffffff', 3],
  ['light · danger on canvas', '#dc2626', '#ffffff', 4.5],
  ['light · success on canvas', '#16a34a', '#ffffff', 3],
  // App shell. The sidebar is a third surface with its own hover and active
  // fills, so every pair that only ever occurs there is asserted here too —
  // "it passes on the canvas" says nothing about a tinted panel.
  ['light · text-tertiary on sidebar', '#6e6e7c', '#f7f7f9', 4.5],
  ['light · text-secondary on sidebar-hover', '#55555f', '#f0f0f3', 4.5],
  ['light · active label on sidebar-active', '#141418', '#ffffff', 4.5],
  ['light · active icon on sidebar-active', '#4f46e5', '#ffffff', 3],
  ['dark · text-primary on canvas', '#f7f7f9', '#0a0a0c', 4.5],
  ['dark · text-tertiary on sidebar', '#848492', '#141418', 4.5],
  ['dark · text-tertiary on inset', '#848492', '#1c1c22', 4.5],
  ['dark · text-secondary on sidebar-hover', '#9d9daa', '#212129', 4.5],
  ['dark · active label on sidebar-active', '#f7f7f9', '#27272e', 4.5],
  ['dark · active icon on sidebar-active', '#8183f4', '#27272e', 3],
  ['dark · text-secondary on canvas', '#9d9daa', '#0a0a0c', 4.5],
  ['dark · text-tertiary on canvas', '#848492', '#0a0a0c', 4.5],
  ['dark · text-secondary on raised', '#9d9daa', '#141418', 4.5],
  ['dark · accent link on canvas', '#8183f4', '#0a0a0c', 4.5],
  ['dark · on-ink on ink-solid', '#0a0a0c', '#f7f7f9', 4.5],
  ['dark · focus ring on canvas', '#8183f4', '#0a0a0c', 3],
  ['dark · danger on canvas', '#f87171', '#0a0a0c', 4.5],
  ['dark · success on canvas', '#4ade80', '#0a0a0c', 3],
];

let failed = 0;
for (const [label, fg, bg, min] of CASES) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)} / ${min}  ${label}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed > 0 ? 1 : 0);
