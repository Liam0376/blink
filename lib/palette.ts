/**
 * CVD-safe palettes (Okabe-Ito inspired). Never encode income vs expense
 * or categories by hue alone — labels always accompany color.
 */

/** Income vs expense pair: blue vs vermillion (safe for deuteranopia/protanopia). */
export const FLOW_COLORS = {
  income: "#2563eb",
  expense: "#e6550d",
} as const;

/** Categorical set for wallets/categories — all pairwise distinct incl. grayscale. */
export const CATEGORY_COLORS = [
  "#2563eb", // blue
  "#e6550d", // vermillion
  "#009e73", // bluish green
  "#cc79a7", // reddish purple
  "#f0c808", // yellow (dark text needed, used for dots only)
  "#56b4e9", // sky blue
  "#e69f00", // orange
  "#0072b2", // dark blue
  "#d55e00", // dark vermillion
  "#999999", // gray (last resort)
] as const;

/** Pick the palette color used least by existing items (stable, unique-first). */
export function assignColor(used: (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const c of used) {
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string = CATEGORY_COLORS[0];
  let bestCount = Infinity;
  for (const c of CATEGORY_COLORS) {
    const n = counts.get(c) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}
