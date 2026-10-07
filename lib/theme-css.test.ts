import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The theme is driven ONLY by the `.dark` class on <html> — set before paint
 * by the script in app/layout.tsx, kept in sync by the effect in app/page.tsx.
 * A `@media (prefers-color-scheme: dark)` block that re-declares the theme
 * CSS variables breaks the toggle on dark-mode devices: the class comes off,
 * but the media query keeps the dark variables applied, so the switch looks
 * dead. (It keyed on `:root:not(.light)`, and nothing ever adds `.light`.)
 *
 * This runs against the real app/globals.css, so re-introducing that block
 * fails the suite instead of shipping a dead switch.
 */
describe("app/globals.css theme", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
    // Strip comments so prose that names the forbidden pattern doesn't trip it.
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("does not theme CSS variables from prefers-color-scheme", () => {
    const mediaBlocks = css.match(/@media[^{]*prefers-color-scheme[^{]*\{[\s\S]*?\n\}/gi) ?? [];
    const themed = mediaBlocks.filter((block) => block.includes("--background"));
    expect(themed).toEqual([]);
  });
});
