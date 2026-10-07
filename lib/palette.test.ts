import { describe, expect, it } from "vitest";
import { assignColor, CATEGORY_COLORS } from "./palette";

describe("assignColor", () => {
  it("picks the first color when nothing is in use yet", () => {
    expect(assignColor([])).toBe(CATEGORY_COLORS[0]);
  });

  it("skips colors already in use, preferring unused ones", () => {
    const used = [CATEGORY_COLORS[0], CATEGORY_COLORS[1]];
    const next = assignColor(used);
    expect(next).toBe(CATEGORY_COLORS[2]);
  });

  it("treats undefined entries as unused (they don't count)", () => {
    const used = [undefined, undefined, CATEGORY_COLORS[0]];
    const next = assignColor(used);
    expect(next).toBe(CATEGORY_COLORS[1]);
  });

  it("cycles through the palette when all colors are used equally", () => {
    const allUsed = [...CATEGORY_COLORS];
    const next = assignColor(allUsed);
    // When all are tied, it should pick the first one again (bestCount reaches Infinity condition).
    expect(CATEGORY_COLORS).toContain(next);
  });

  it("picks the least-used color among many items", () => {
    // Use colors[0] 5 times, colors[1] 3 times, colors[2] 1 time
    const used = [
      CATEGORY_COLORS[0],
      CATEGORY_COLORS[0],
      CATEGORY_COLORS[0],
      CATEGORY_COLORS[0],
      CATEGORY_COLORS[0],
      CATEGORY_COLORS[1],
      CATEGORY_COLORS[1],
      CATEGORY_COLORS[1],
      CATEGORY_COLORS[2],
    ];
    const next = assignColor(used);
    expect(next).toBe(CATEGORY_COLORS[3]); // colors[3] is unused
  });

  it("handles duplicate entries in the used list (counts them)", () => {
    const used = [CATEGORY_COLORS[0], CATEGORY_COLORS[0], CATEGORY_COLORS[1]];
    const next = assignColor(used);
    // colors[0] has count 2, colors[1] has count 1, so colors[2] (count 0) should win.
    expect(next).toBe(CATEGORY_COLORS[2]);
  });

  it("always returns a string from the palette or fallback", () => {
    const next = assignColor([...CATEGORY_COLORS]);
    expect(typeof next).toBe("string");
  });
});
