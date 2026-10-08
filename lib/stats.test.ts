import { describe, expect, it } from "vitest";
import type { Category } from "./db";
import {
  advanceRecurring,
  advanceRecurringPastNow,
  bucketize,
  buildBuckets,
  countsTowardBudget,
  localDayKey,
  spendByTopLevel,
  topAncestor,
  type BucketTx,
  isDuplicateEntry,
  isRecurringDue,
} from "./stats";

const tx = (over: Partial<BucketTx> & { date: string }): BucketTx => ({
  type: "expense",
  amount: 0,
  currency: "CRC",
  ...over,
});

describe("localDayKey", () => {
  it("uses local calendar day, not the UTC slice", () => {
    // 00:30 UTC = previous evening in Costa Rica (UTC-6)
    const k = localDayKey("2026-09-11T00:30:00.000Z");
    const d = new Date("2026-09-11T00:30:00.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(k).toBe(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  });
});

describe("buildBuckets", () => {
  const ref = new Date(2026, 8, 15, 12); // Sep 15 2026 noon local
  it("week = 7 day buckets ending on ref day, unambiguous labels", () => {
    const b = buildBuckets("week", ref);
    expect(b).toHaveLength(7);
    expect(b[6].label).toContain("15");
    expect(b[0].label).toContain("9");
  });
  it("month = 14 day buckets with month shown on the 1st", () => {
    const b = buildBuckets("month", new Date(2026, 8, 10, 12)); // window Aug 28 – Sep 10
    expect(b).toHaveLength(14);
    const first = b.find((x) => x.start.getDate() === 1);
    expect(first?.label).toContain("1");
  });
  it("year = 12 month buckets with 3-letter labels", () => {
    const b = buildBuckets("year", ref);
    expect(b).toHaveLength(12);
    expect(b[11].start.getMonth()).toBe(8);
    expect(b[11].label.length).toBeGreaterThan(1);
  });

  it("survives DST transitions: consecutive calendar days, no dupes, ends in-day", () => {
    // US Eastern 2025: spring forward Mar 9 (23h day), fall back Nov 2 (25h day).
    // es-CR has no DST, so this only manifests in DST-observing locales —
    // run the suite with TZ=America/New_York to exercise it.
    const refs = [
      new Date(2025, 10, 2, 23, 30), // late inside the 25h day
      new Date(2025, 10, 3, 12),
      new Date(2025, 2, 9, 23, 30), // eve of the 23h day
      new Date(2025, 2, 10, 12),
    ];
    for (const r of refs) {
      for (const range of ["week", "month"] as const) {
        const b = buildBuckets(range, r);
        expect(b).toHaveLength(range === "week" ? 7 : 14);
        const keys = b.map(
          (x) => `${x.start.getFullYear()}-${x.start.getMonth()}-${x.start.getDate()}`
        );
        expect(new Set(keys).size).toBe(keys.length); // no duplicated day
        for (let i = 1; i < b.length; i++) {
          const want = new Date(b[i - 1].start);
          want.setDate(want.getDate() + 1);
          expect([b[i].start.getFullYear(), b[i].start.getMonth(), b[i].start.getDate()]).toEqual([
            want.getFullYear(),
            want.getMonth(),
            want.getDate(),
          ]);
        }
        for (const x of b) {
          // end must stay inside its own calendar day (no spill into next)
          expect([x.end.getFullYear(), x.end.getMonth(), x.end.getDate()]).toEqual([
            x.start.getFullYear(),
            x.start.getMonth(),
            x.start.getDate(),
          ]);
        }
      }
    }
  });
});

describe("bucketize", () => {
  const ref = new Date(2026, 8, 15, 12);
  const iso = (day: number, h = 12) =>
    new Date(2026, 8, day, h).toISOString();

  it("totals a 7-day window in one pass, ignoring transfers", () => {
    const r = bucketize(
      "week",
      [
        tx({ date: iso(15), amount: 100 }),
        tx({ date: iso(14), amount: 50 }),
        tx({ date: iso(15), amount: 1000, type: "income" }),
        tx({ date: iso(15), amount: 999, type: "transfer" }),
        tx({ date: iso(1), amount: 777 }), // outside window
      ],
      "CRC",
      ref
    );
    expect(r.totalOut).toBe(150);
    expect(r.totalIn).toBe(1000);
    expect(r.buckets[6].expense).toBe(100);
    expect(r.buckets[5].expense).toBe(50);
  });

  it("computes prev-window spend for delta", () => {
    const r = bucketize("week", [tx({ date: iso(8, 12), amount: 40 })], "CRC", ref);
    expect(r.prevOut).toBe(40);
    expect(r.totalOut).toBe(0);
  });

  it("reports other-currency spend instead of silently dropping it", () => {
    const r = bucketize("week", [tx({ date: iso(15), amount: 200, currency: "USD" })], "CRC", ref);
    expect(r.totalOut).toBe(0);
    expect(r.otherCurrencyOut).toEqual([{ currency: "USD", amount: 200 }]);
  });

  it("places year transactions by month", () => {
    const r = bucketize(
      "year",
      [tx({ date: new Date(2026, 8, 5, 12).toISOString(), amount: 300 })],
      "CRC",
      ref
    );
    expect(r.buckets[11].expense).toBe(300);
    expect(r.totalOut).toBe(300);
  });
});

const cats: Category[] = [
  { id: "c10", name: "Comida", icon: "🍽️", color: "#e69f00", kind: "expense" },
  { id: "c11", name: "Súper", icon: "🧺", color: "#e69f00", kind: "expense", parentId: "c10" },
  { id: "c12", name: "Transporte", icon: "🚌", color: "#56b4e9", kind: "expense" },
];

describe("spendByTopLevel", () => {
  const start = new Date(2026, 8, 1);
  const end = new Date(2026, 8, 30, 23, 59, 59);
  const d = "2026-09-10T12:00:00";

  it("rolls subcategory spend up to the parent", () => {
    const s = spendByTopLevel(
      [tx({ date: d, amount: 300, categoryId: "c11" }), tx({ date: d, amount: 100, categoryId: "c10" })],
      cats,
      "CRC",
      start,
      end
    );
    expect(s).toHaveLength(1);
    expect(s[0].label).toBe("Comida");
    expect(s[0].value).toBe(400);
  });

  it("aggregates beyond maxSlices into an Other slice", () => {
    const many: Category[] = Array.from({ length: 7 }, (_, i) => ({
      id: "c100" + i, name: `C${i}`, icon: "•", color: "#111", kind: "expense" as const,
    }));
    const txs = many.map((c, i) => tx({ date: d, amount: (i + 1) * 10, categoryId: c.id }));
    const s = spendByTopLevel(txs, many, "CRC", start, end, 6);
    expect(s).toHaveLength(6);
    expect(s[5].label).toContain("Other (2)");
    expect(s.reduce((a, x) => a + x.value, 0)).toBe(280);
  });

  it("ignores other currencies and out-of-window dates", () => {
    const s = spendByTopLevel(
      [
        tx({ date: d, amount: 100, categoryId: "c12", currency: "USD" }),
        tx({ date: "2026-08-01T12:00:00", amount: 100, categoryId: "c12" }),
      ],
      cats,
      "CRC",
      start,
      end
    );
    expect(s).toHaveLength(0);
  });
});

describe("topAncestor", () => {
  const byId = new Map(cats.map((c) => [c.id, c]));

  it("returns the category itself when it has no parent", () => {
    const root = topAncestor("c10", byId); // Comida, no parent
    expect(root?.id).toBe("c10");
  });

  it("walks up the parent chain to find the root", () => {
    const root = topAncestor("c11", byId); // Súper (child of Comida)
    expect(root?.id).toBe("c10"); // Comida
  });

  it("returns undefined for a missing category id", () => {
    expect(topAncestor("c999", byId)).toBeUndefined();
  });

  it("returns undefined for an undefined category id", () => {
    expect(topAncestor(undefined, byId)).toBeUndefined();
  });

  it("terminates safely on a cycle instead of hanging", () => {
    // Create a cycle: c20 -> c21 -> c20
    const cyclic = new Map<string | undefined, Category>([
      ["c10", { id: "c10", name: "Comida", icon: "🍽️", color: "#e69f00", kind: "expense" }],
      ["c20", { id: "c20", name: "A", icon: "•", color: "#111", kind: "expense", parentId: "c21" }],
      ["c21", { id: "c21", name: "B", icon: "•", color: "#111", kind: "expense", parentId: "c20" }],
    ]);
    const result = topAncestor("c20", cyclic);
    // Should return one of them when the cycle is detected (not hang)
    expect(result?.id).toBeDefined();
  });

  it("handles a self-parent (cycle to itself) safely", () => {
    const selfParent = new Map<string | undefined, Category>([
      ["c30", { id: "c30", name: "Self", icon: "•", color: "#111", kind: "expense", parentId: "c30" }],
    ]);
    const result = topAncestor("c30", selfParent);
    // Should detect the cycle and return the category itself
    expect(result?.id).toBe("c30");
  });

  it("returns the first valid ancestor when chain is long", () => {
    // Create a deep chain: c100 -> c101 -> c102 -> c103 (root)
    const deep = new Map<string | undefined, Category>([
      ["c100", { id: "c100", name: "L1", icon: "•", color: "#111", kind: "expense", parentId: "c101" }],
      ["c101", { id: "c101", name: "L2", icon: "•", color: "#111", kind: "expense", parentId: "c102" }],
      ["c102", { id: "c102", name: "L3", icon: "•", color: "#111", kind: "expense", parentId: "c103" }],
      ["c103", { id: "c103", name: "Root", icon: "•", color: "#111", kind: "expense" }],
    ]);
    const root = topAncestor("c100", deep);
    expect(root?.id).toBe("c103");
  });
});

describe("countsTowardBudget", () => {
  const byId = new Map(cats.map((c) => [c.id, c]));
  it("null budget = total, exact match counts", () => {
    expect(countsTowardBudget("c11", null, byId)).toBe(true);
    expect(countsTowardBudget("c11", "c11", byId)).toBe(true);
  });
  it("child spend counts toward the parent budget, not vice versa", () => {
    expect(countsTowardBudget("c11", "c10", byId)).toBe(true);
    expect(countsTowardBudget("c10", "c11", byId)).toBe(false);
  });
  it("uncategorized spend counts only toward total budgets", () => {
    expect(countsTowardBudget(undefined, null, byId)).toBe(true);
    expect(countsTowardBudget(undefined, "c10", byId)).toBe(false);
  });
});

describe("guards shared with computeBalances", () => {
  const ref = new Date("2026-09-15T12:00:00");

  it("bucketize ignores an unknown type and a negative amount", () => {
    const { totalIn, totalOut } = bucketize(
      "month",
      [
        { type: "expense", amount: 100, currency: "USD", date: "2026-09-10T12:00:00" },
        { type: "bogus", amount: 500, currency: "USD", date: "2026-09-11T12:00:00" } as never,
        { type: "expense", amount: -250, currency: "USD", date: "2026-09-12T12:00:00" },
      ],
      "USD",
      ref
    );
    // An unknown type used to land in the income bucket.
    expect(totalIn).toBe(0);
    expect(totalOut).toBe(100);
  });

  it("treats a recurring item with an unreadable date as not due", () => {
    // Firing on it posts a row with a nonsense date and then throws in the
    // formatter, on every launch.
    expect(isRecurringDue({ nextDate: "not a date" }, ref)).toBe(false);
    expect(isRecurringDue({ nextDate: "" }, ref)).toBe(false);
  });
});

describe("isDuplicateEntry", () => {
  const now = new Date("2026-09-15T12:00:00.000Z");
  const candidate = {
    type: "expense", amount: 50, walletId: "w1", categoryId: "c1",
    date: "2026-09-15T12:00:00.000Z", note: "Coffee",
  };
  const savedAt = (iso: string, over: Partial<typeof candidate> = {}) => ({
    ...candidate, ...over, createdAt: iso,
  });

  it("catches the same entry saved seconds ago", () => {
    expect(isDuplicateEntry(savedAt("2026-09-15T11:59:58.000Z"), candidate, now)).toBe(true);
  });

  it("lets the same entry through once the window has passed", () => {
    // A second identical coffee minutes later is a real second coffee.
    expect(isDuplicateEntry(savedAt("2026-09-15T11:59:00.000Z"), candidate, now)).toBe(false);
  });

  it("is blind to a difference in any field", () => {
    expect(isDuplicateEntry(savedAt("2026-09-15T11:59:58.000Z", { amount: 51 }), candidate, now)).toBe(false);
    expect(isDuplicateEntry(savedAt("2026-09-15T11:59:58.000Z", { note: "Tea" }), candidate, now)).toBe(false);
    expect(isDuplicateEntry(savedAt("2026-09-15T11:59:58.000Z", { categoryId: "c2" }), candidate, now)).toBe(false);
    expect(isDuplicateEntry(savedAt("2026-09-15T11:59:58.000Z", { date: "2026-09-14T12:00:00.000Z" }), candidate, now)).toBe(false);
  });

  it("treats a missing note and an empty note as the same", () => {
    const noNote = { ...candidate, note: undefined };
    expect(isDuplicateEntry({ ...noNote, createdAt: "2026-09-15T11:59:58.000Z" }, noNote, now)).toBe(true);
    expect(isDuplicateEntry({ ...noNote, createdAt: "2026-09-15T11:59:58.000Z", note: "" }, noNote, now)).toBe(true);
  });

  it("ignores a row with an unparseable timestamp", () => {
    expect(isDuplicateEntry(savedAt("not a date"), candidate, now)).toBe(false);
  });
});

describe("isRecurringDue", () => {
  const now = new Date("2026-09-15T12:00:00");

  it("is due when the date has passed", () => {
    expect(isRecurringDue({ nextDate: "2026-09-01" }, now)).toBe(true);
    expect(isRecurringDue({ nextDate: now.toISOString() }, now)).toBe(true);
  });

  it("is not due while the date is still ahead", () => {
    expect(isRecurringDue({ nextDate: "2026-10-01" }, now)).toBe(false);
  });

  it("is not due once deactivated", () => {
    expect(isRecurringDue({ nextDate: "2026-09-01", active: false }, now)).toBe(false);
  });

  it("is the same check the auto-log sweep re-runs inside its lock", () => {
    // Two tabs read the same snapshot; the second must see that the first
    // already advanced the date and skip it.
    const advanced = { nextDate: "2026-10-15" };
    expect(isRecurringDue(advanced, now)).toBe(false);
  });
});

describe("advanceRecurring", () => {
  it("weekly adds 7 days", () => {
    const n = advanceRecurring(new Date("2026-01-01T00:00:00"), "weekly");
    expect(n.toISOString().slice(0, 10)).toBe("2026-01-08");
  });
  it("yearly adds 1 year", () => {
    const n = advanceRecurring(new Date("2026-01-15T00:00:00"), "yearly");
    expect(n.getFullYear()).toBe(2027);
  });
  it("monthly without anchorDay drifts down after a short-month clamp (legacy rows)", () => {
    const jan31 = new Date("2026-01-31T00:00:00");
    const feb = advanceRecurring(jan31, "monthly"); // clamps to Feb 28 (2026 not a leap year)
    expect(feb.getDate()).toBe(28);
    const mar = advanceRecurring(feb, "monthly"); // no anchor -> targets the 28th again, not 31st
    expect(mar.getDate()).toBe(28);
  });
  it("monthly WITH anchorDay=31 bounces back after a short-month clamp instead of drifting", () => {
    const jan31 = new Date("2026-01-31T00:00:00");
    const feb = advanceRecurring(jan31, "monthly", 31); // clamps to Feb 28
    expect(feb.getDate()).toBe(28);
    const mar = advanceRecurring(feb, "monthly", 31); // anchor pulls it back to the 31st
    expect(mar.getDate()).toBe(31);
    expect(mar.getMonth()).toBe(2); // March
  });
  it("monthly anchorDay handles leap-year February", () => {
    const jan31 = new Date("2028-01-31T00:00:00"); // 2028 is a leap year
    const feb = advanceRecurring(jan31, "monthly", 31);
    expect(feb.getDate()).toBe(29);
  });
});

describe("advanceRecurringPastNow", () => {
  it("leaves nextDate untouched when it's already in the future", () => {
    const next = new Date("2026-06-01T00:00:00");
    const now = new Date("2026-01-01T00:00:00");
    const r = advanceRecurringPastNow(next, "monthly", undefined, now);
    expect(r.nextDate).toEqual(next);
    expect(r.ended).toBe(false);
  });

  it("catches up a single missed weekly period", () => {
    const next = new Date("2026-01-01T00:00:00");
    const now = new Date("2026-01-10T00:00:00");
    const r = advanceRecurringPastNow(next, "weekly", undefined, now);
    expect(r.nextDate.toISOString().slice(0, 10)).toBe("2026-01-15");
    expect(r.ended).toBe(false);
  });

  it("catches up multiple missed periods (long-idle app)", () => {
    const next = new Date("2026-01-01T00:00:00");
    const now = new Date("2026-03-01T00:00:00"); // ~8 weeks later
    const r = advanceRecurringPastNow(next, "weekly", undefined, now);
    expect(r.nextDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it("flags ended:true when catch-up pushes nextDate past endDate", () => {
    const next = new Date("2026-01-01T00:00:00");
    const now = new Date("2026-01-20T00:00:00");
    const r = advanceRecurringPastNow(next, "weekly", undefined, now, "2026-01-10");
    expect(r.ended).toBe(true);
  });

  it("does not flag ended when nextDate still falls within endDate", () => {
    const next = new Date("2026-01-01T00:00:00");
    const now = new Date("2026-01-10T00:00:00");
    const r = advanceRecurringPastNow(next, "weekly", undefined, now, "2026-12-31");
    expect(r.ended).toBe(false);
  });
});
