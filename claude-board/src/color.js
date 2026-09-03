/**
 * Deterministic per-project color. The same repo name always yields the same
 * hue, on the board (label color) and on the dashboard alike. Kept dependency
 * free and tiny so the dashboard can inline it.
 */
export function projectHue(name) {
  let h = 2166136261;
  for (const ch of String(name || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 360;
}

/** HSL → 6-digit hex without '#'. */
export function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Label color for a repo: saturated enough to read as a hue, dark enough for white text. */
export function projectHex(name) { return hslHex(projectHue(name), 58, 38); }

/** Two-letter monogram for a repo name: "api-server" → "AS", "agents" → "AG". */
export function monogram(name) {
  const parts = String(name || '?').split(/[-_./\s]+/).filter(Boolean);
  const m = parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
  return m.toUpperCase();
}
