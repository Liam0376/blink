import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  daysSince,
  fmtMoney,
  importJSON,
  orderedCurrencyOptions,
  MAX_CASHBACK_PCT,
  MAX_ROI_PCT,
  parseBackup,
  parsePercentInput,
  parseTransactionsCSV,
  prettyDay,
  roundCents,
  sanitizeAmountInput,
  startOfPeriod,
  toInputDate,
  transactionsToCSV,
} from "./format";

const mocks = vi.hoisted(() => {
  const makeTable = () => ({
    clear: vi.fn(async () => {}),
    bulkPut: vi.fn(async (rows: Array<Record<string, unknown>>) => {
      void rows;
    }),
  });
  const wallets = makeTable();
  const categories = makeTable();
  const transactions = makeTable();
  const budgets = makeTable();
  const debts = makeTable();
  const recurring = makeTable();
  const transaction = vi.fn(async (...args: unknown[]) => {
    const cb = args[args.length - 1] as () => Promise<unknown>;
    await cb();
  });
  return { wallets, categories, transactions, budgets, debts, recurring, transaction };
});

vi.mock("./db", () => ({
  db: {
    wallets: mocks.wallets,
    categories: mocks.categories,
    transactions: mocks.transactions,
    budgets: mocks.budgets,
    debts: mocks.debts,
    recurring: mocks.recurring,
    transaction: mocks.transaction,
  },
}));

function validBackupJSON(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app: "blink",
    exportedAt: "2026-09-12T00:00:00.000Z",
    imagesIncluded: false,
    wallets: [{ id: "3f2a1b4c-9d8e-4f7a-b6c5-d4e3f2a1b098", name: "Efectivo", kind: "cash", color: "green", currency: "CRC", createdAt: "2026-01-01" }],
    categories: [{ id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", name: "Comida", icon: "food", color: "red", kind: "expense" }],
    transactions: [{ id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e", type: "expense", amount: 1500, currency: "CRC", walletId: "3f2a1b4c-9d8e-4f7a-b6c5-d4e3f2a1b098", categoryId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", date: "2026-09-01", createdAt: "2026-09-01" }],
    budgets: [{ id: "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f", label: "Mes", period: "month", limit: 100000, currency: "CRC", categoryId: null }],
    debts: [{ id: "d4e5f6a7-b8c9-4d0e-8f2a-3b4c5d6e7f80", person: "Ana", amount: 20, currency: "USD", direction: "owed", createdAt: "2026-09-01" }],
    recurring: [{ id: "e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8091", label: "Salario", type: "income", amount: 500, currency: "USD", walletId: "3f2a1b4c-9d8e-4f7a-b6c5-d4e3f2a1b098", nextDate: "2026-10-01", frequency: "monthly" }],
    ...overrides,
  });
}

const allTables = [mocks.wallets, mocks.categories, mocks.transactions, mocks.budgets, mocks.debts, mocks.recurring];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fmtMoney", () => {
  it("defaults to MXN when no currency is given", () => {
    expect(fmtMoney(1000)).toBe(fmtMoney(1000, "MXN"));
  });

  it("formats USD with exactly 2 decimals (en-US)", () => {
    expect(fmtMoney(10, "USD")).toBe("$10.00");
    expect(fmtMoney(10.5, "USD")).toBe("$10.50");
    expect(fmtMoney(1234.5, "USD")).toBe("$1,234.50");
    expect(fmtMoney(0.1 + 0.2, "USD")).toBe("$0.30");
  });

  it("formats negative USD with leading minus", () => {
    expect(fmtMoney(-5.25, "USD")).toBe("-$5.25");
  });

  it("formats zero for both currencies", () => {
    expect(fmtMoney(0, "USD")).toBe("$0.00");
    expect(fmtMoney(0, "EUR")).toBe(fmtMoney(0, "EUR"));
    expect(fmtMoney(0, "EUR")).toContain("0");
  });

  it("formats a valid non-preset code (GBP) via Intl, no changes needed", () => {
    expect(fmtMoney(10, "GBP")).toBe("£10.00");
    expect(fmtMoney(1234.5, "JPY")).toContain("¥");
  });

  it("degrades gracefully on a code Intl rejects instead of throwing", () => {
    // "XX" fails the Intl currency check (RangeError) — must not crash render.
    let out = "";
    expect(() => {
      out = fmtMoney(123.45, "XX");
    }).not.toThrow();
    expect(out).toContain("XX");
    expect(out).toContain("123.45");
  });

  it("handles a syntactically valid but non-existent code (ZZZ) without throwing", () => {
    let out = "";
    expect(() => {
      out = fmtMoney(123.45, "ZZZ");
    }).not.toThrow();
    expect(out).toContain("ZZZ");
  });
});

describe("orderedCurrencyOptions", () => {
  it("puts presets in use first, then custom codes alphabetically", () => {
    expect(orderedCurrencyOptions(["GBP", "USD", "CRC", "CAD"])).toEqual(["USD", "CAD", "CRC", "GBP"]);
  });

  it("dedupes repeat currencies", () => {
    expect(orderedCurrencyOptions(["CRC", "CRC", "USD"])).toEqual(["USD", "CRC"]);
  });

  it("returns [] when nothing is in use, and matches the preset order when only presets are in use", () => {
    expect(orderedCurrencyOptions([])).toEqual([]);
    expect(orderedCurrencyOptions(["MXN", "EUR", "USD"])).toEqual(["MXN", "USD", "EUR"]);
  });

  it("treats CRC as a custom currency (regression: after removal from CURRENCIES preset)", () => {
    // CRC used to be in CURRENCIES but was removed; wallets/budgets/recurring with CRC
    // should still work, appearing after presets and sorted alphabetically with other customs.
    expect(orderedCurrencyOptions(["CRC"])).toEqual(["CRC"]);
    expect(orderedCurrencyOptions(["USD", "CRC"])).toEqual(["USD", "CRC"]);
    expect(orderedCurrencyOptions(["CRC", "USD", "EUR"])).toEqual(["USD", "EUR", "CRC"]);
  });
});

describe("daysSince", () => {
  const now = new Date(2026, 8, 12, 12, 0); // Sat Sep 12 2026, local noon
  const isoDaysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it("returns 0 for a timestamp earlier today", () => {
    expect(daysSince(now.toISOString(), now)).toBe(0);
  });

  it("counts whole elapsed days (floors partial days)", () => {
    expect(daysSince(isoDaysAgo(1), now)).toBe(1);
    expect(daysSince(isoDaysAgo(30), now)).toBe(30);
    expect(daysSince(isoDaysAgo(31), now)).toBe(31);
    expect(daysSince(new Date(now.getTime() - 36 * 3_600_000).toISOString(), now)).toBe(1);
  });

  it("returns NaN for an unparseable timestamp", () => {
    expect(daysSince("not-a-date", now)).toBeNaN();
  });
});

describe("prettyDay", () => {
  it('returns "Today" for right now', () => {
    expect(prettyDay(new Date().toISOString())).toBe("Today");
  });

  it('returns "Today" for a date-only string of today (noon-anchor branch)', () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(prettyDay(todayKey)).toBe("Today");
  });

  it('returns "Yesterday" for yesterday', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(prettyDay(y.toISOString())).toBe("Yesterday");
  });

  it("returns a non-empty locale string for other days", () => {
    const out = prettyDay("2000-01-01T08:00:00");
    expect(out).not.toBe("Today");
    expect(out).not.toBe("Yesterday");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toBe(
      new Date("2000-01-01T08:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    );
  });

  it("treats date-only and same-day datetime identically (noon anchor avoids TZ midnight flip)", () => {
    expect(prettyDay("2000-01-05")).toBe(prettyDay("2000-01-05T08:00:00"));
  });
});

describe("toInputDate", () => {
  it('produces "YYYY-MM-DDTHH:mm" for datetime-local inputs', () => {
    // No trailing Z: parsed as local time, so this is TZ-independent.
    expect(toInputDate("2026-03-05T04:07:00")).toBe("2026-03-05T04:07");
  });

  it("zero-pads month, day, hour, and minute", () => {
    expect(toInputDate("2026-01-02T03:04:00")).toBe("2026-01-02T03:04");
    expect(toInputDate("2026-12-31T23:59:00")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("drops seconds and milliseconds", () => {
    expect(toInputDate("2026-06-15T12:30:45.123")).toBe("2026-06-15T12:30");
  });
});

describe("startOfPeriod", () => {
  it("week starts on Monday (midnight)", () => {
    // Wednesday 2026-09-09 15:30 local -> Monday 2026-09-07 00:00.
    const start = startOfPeriod("week", new Date(2026, 8, 9, 15, 30));
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 8, 7]);
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    expect(start.getDay()).toBe(1); // Monday
  });

  it("week treats Sunday as the last day of the week, not the first", () => {
    const start = startOfPeriod("week", new Date(2026, 8, 13, 12, 0)); // Sunday
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 8, 7]);
  });

  it("week on a Monday returns that same day at midnight", () => {
    const start = startOfPeriod("week", new Date(2026, 8, 7, 23, 59));
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 8, 7]);
    expect(start.getHours()).toBe(0);
  });

  it("week crosses month boundaries", () => {
    // Thursday 2026-10-01 -> Monday 2026-09-28.
    const start = startOfPeriod("week", new Date(2026, 9, 1, 10, 0));
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 8, 28]);
  });

  it("month starts on the 1st at midnight", () => {
    const start = startOfPeriod("month", new Date(2026, 8, 15, 18, 45));
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 8, 1]);
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0]);
  });

  it("year starts on Jan 1st at midnight", () => {
    const start = startOfPeriod("year", new Date(2026, 8, 12, 9, 0));
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 0, 1]);
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0]);
  });

  it("does not mutate the ref date passed in", () => {
    const ref = new Date(2026, 8, 9, 15, 30);
    const before = ref.getTime();
    startOfPeriod("week", ref);
    startOfPeriod("month", ref);
    startOfPeriod("year", ref);
    expect(ref.getTime()).toBe(before);
  });
});

describe("roundCents", () => {
  it("rounds to 2 decimal places", () => {
    expect(roundCents(1.234)).toBe(1.23);
    expect(roundCents(1.235)).toBe(1.24);
    expect(roundCents(1.225)).toBe(1.23);
    expect(roundCents(10.005)).toBe(10.01);
  });

  it("handles zero", () => {
    expect(roundCents(0)).toBe(0);
    expect(roundCents(0.0)).toBe(0);
  });

  it("handles negative values", () => {
    expect(roundCents(-1.234)).toBe(-1.23);
    expect(roundCents(-1.235)).toBe(-1.24);
  });

  it("fixes floating-point drift from repeated 0.1 additions", () => {
    // Direct float addition: 0.1 + 0.1 + ... (50 times) = 4.999999999999999
    let direct = 0;
    for (let i = 0; i < 50; i++) {
      direct += 0.1;
    }
    expect(direct).not.toBe(5); // Proves the bug exists

    // With rounding at each step
    let rounded = 0;
    for (let i = 0; i < 50; i++) {
      rounded = roundCents(rounded + 0.1);
    }
    expect(rounded).toBe(5);
  });

  it("fixes floating-point drift from repeated 0.2 additions", () => {
    let rounded = 0;
    for (let i = 0; i < 50; i++) {
      rounded = roundCents(rounded + 0.2);
    }
    expect(rounded).toBe(10);
  });

  it("fixes floating-point drift from repeated 33.33 additions", () => {
    let rounded = 0;
    for (let i = 0; i < 3; i++) {
      rounded = roundCents(rounded + 33.33);
    }
    expect(rounded).toBe(99.99);
  });

  it("accumulates mixed transactions to exact cent value", () => {
    // Simulate balance accumulation: opening - expenses
    // 1000 - 100.1 - 50.25 - 33.33 - 0.01 - 10.99 = 805.32
    let balance = roundCents(1000); // opening balance
    const txns = [100.1, 50.25, 33.33, 0.01, 10.99];
    for (const amount of txns) {
      balance = roundCents(balance - amount); // expenses
    }
    expect(balance).toBe(805.32);
  });

  it("preserves exact values already at 2 decimals", () => {
    expect(roundCents(10.00)).toBe(10);
    expect(roundCents(10.50)).toBe(10.5);
    expect(roundCents(10.25)).toBe(10.25);
  });

  it("accumulates fractional cents to produce exact totals", () => {
    // Accumulate amounts that alone would have drift: 0.1 * 6 = 0.6
    let total = 0;
    for (let i = 0; i < 6; i++) {
      total = roundCents(total + 0.1);
    }
    expect(total).toBe(0.6);

    // 33.33 * 3 should equal 99.99 when rounded per step
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      sum = roundCents(sum + 33.33);
    }
    expect(sum).toBe(99.99);
  });
});

describe("sanitizeAmountInput", () => {
  it("maps the es-CR comma decimal to a dot (mobile decimal pads emit ',')", () => {
    expect(sanitizeAmountInput("12,50")).toBe("12.50");
    expect(Number(sanitizeAmountInput("12,50"))).toBe(12.5);
  });

  it("leaves dot decimals alone", () => {
    expect(sanitizeAmountInput("12.50")).toBe("12.50");
    expect(sanitizeAmountInput("1000")).toBe("1000");
  });

  it("strips letters and symbols", () => {
    expect(sanitizeAmountInput("₡1a2b")).toBe("12");
    expect(sanitizeAmountInput("  50 ")).toBe("50");
  });

  it("keeps multi-dot garbage parseable only as NaN (fail closed downstream)", () => {
    expect(Number(sanitizeAmountInput("1.2.3"))).toBeNaN();
    // Empty stays empty: rejected downstream by the `> 0` amount guards
    // (Number("") is 0, which also fails `> 0` — fail closed either way).
    expect(sanitizeAmountInput("")).toBe("");
  });

  it("drops minus unless explicitly allowed (opening balance)", () => {
    expect(sanitizeAmountInput("-5")).toBe("5");
    expect(sanitizeAmountInput("-5", { allowNegative: true })).toBe("-5");
  });
});

describe("transactionsToCSV", () => {
  it("returns only the header when there are no rows", () => {
    expect(transactionsToCSV([])).toBe("date,type,amount,currency,wallet,to_wallet,category,note");
  });

  it("quotes every field of a basic row", () => {
    const csv = transactionsToCSV([
      {
        date: "2026-09-01",
        type: "expense",
        amount: 1500,
        currency: "CRC",
        wallet: "Efectivo",
        category: "Comida",
        note: "almuerzo",
      },
    ]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('"2026-09-01","expense","1500","CRC","Efectivo","","Comida","almuerzo"');
  });

  it("includes the transfer destination column", () => {
    const csv = transactionsToCSV([
      { date: "2026-09-01", type: "transfer", amount: 5000, currency: "CRC", wallet: "Efectivo", toWallet: "Tarjeta", category: "" },
    ]);
    expect(csv.split("\n")[1]).toBe('"2026-09-01","transfer","5000","CRC","Efectivo","Tarjeta","",""');
  });

  it("keeps commas inside a quoted field (no column split)", () => {
    const csv = transactionsToCSV([
      {
        date: "2026-09-01",
        type: "expense",
        amount: 2000,
        currency: "CRC",
        wallet: "Efectivo",
        category: "Súper",
        note: "comida, limpieza",
      },
    ]);
    expect(csv).toContain('"comida, limpieza"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    const csv = transactionsToCSV([
      {
        date: "2026-09-01",
        type: "income",
        amount: 500,
        currency: "USD",
        wallet: "Banco",
        category: "Salario",
        note: 'dijo "hola"',
      },
    ]);
    expect(csv).toContain('"dijo ""hola"""');
  });

  it("renders a missing note as an empty quoted field", () => {
    const csv = transactionsToCSV([
      {
        date: "2026-09-01",
        type: "expense",
        amount: 100,
        currency: "CRC",
        wallet: "Efectivo",
        category: "Otro",
      },
    ]);
    expect(csv.split("\n")[1].endsWith(',""')).toBe(true);
  });

  it("neutralizes spreadsheet formulas with a leading single quote", () => {
    const csv = transactionsToCSV([
      { date: "2026-09-01", type: "expense", amount: 1, currency: "CRC", wallet: "w", category: "c", note: "=SUM(A1:A2)" },
      { date: "2026-09-01", type: "expense", amount: 2, currency: "CRC", wallet: "w", category: "c", note: "+cmd|calc" },
      { date: "2026-09-01", type: "expense", amount: 3, currency: "CRC", wallet: "w", category: "c", note: "@HYPERLINK(x)" },
      { date: "2026-09-01", type: "expense", amount: 4, currency: "CRC", wallet: "w", category: "c", note: "-1+1" },
      { date: "2026-09-01", type: "expense", amount: 5, currency: "CRC", wallet: "w", category: "c", note: "almuerzo normal" },
    ]);
    expect(csv).toContain("\"'=SUM(A1:A2)\"");
    expect(csv).toContain("\"'+cmd|calc\"");
    expect(csv).toContain("\"'@HYPERLINK(x)\"");
    expect(csv).toContain("\"'-1+1\"");
    expect(csv).toContain('"almuerzo normal"');
  });

  it("neutralizes formulas in wallet/category/destination fields too, not just note", () => {
    const csv = transactionsToCSV([
      { date: "2026-09-01", type: "transfer", amount: 1, currency: "CRC", wallet: "=2+2", toWallet: "@evil", category: "+cmd", note: "-x" },
    ]);
    const line = csv.split("\n")[1];
    expect(line).toContain("\"'=2+2\"");
    expect(line).toContain("\"'@evil\"");
    expect(line).toContain("\"'+cmd\"");
    expect(line).toContain("\"'-x\"");
  });

  it("neutralizes tab-indented formulas (leading whitespace prefix)", () => {
    const csv = transactionsToCSV([
      { date: "2026-09-01", type: "expense", amount: 1, currency: "CRC", wallet: "w", category: "c", note: "\t=SUM(A1)" },
    ]);
    expect(csv).toContain("\"'\t=SUM(A1)\"");
  });

  it("emits one line per row plus the header", () => {
    const csv = transactionsToCSV([
      { date: "2026-09-01", type: "expense", amount: 1, currency: "CRC", wallet: "w", category: "c" },
      { date: "2026-09-02", type: "income", amount: 2, currency: "USD", wallet: "w", category: "c" },
      { date: "2026-09-03", type: "transfer", amount: 3, currency: "CRC", wallet: "w", category: "c" },
    ]);
    expect(csv.split("\n")).toHaveLength(4);
  });
});

describe("parseBackup / importJSON", () => {
  it("round-trips export-shaped JSON: restores identical rows with original ids", async () => {
    const counts = await importJSON(validBackupJSON());
    expect(counts).toEqual({ wallets: 1, categories: 1, transactions: 1, budgets: 1, debts: 1, recurring: 1 });
    // Atomic Dexie transaction over all six tables.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0][0]).toBe("rw");
    // Every table cleared, then bulkPut (preserves explicit ids for cross-refs).
    for (const t of allTables) expect(t.clear).toHaveBeenCalledTimes(1);
    expect(mocks.wallets.bulkPut).toHaveBeenCalledWith([
      { id: "3f2a1b4c-9d8e-4f7a-b6c5-d4e3f2a1b098", name: "Efectivo", kind: "cash", color: "green", currency: "CRC", createdAt: "2026-01-01" },
    ]);
    expect(mocks.transactions.bulkPut).toHaveBeenCalledWith([
      { id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e", type: "expense", amount: 1500, currency: "CRC", walletId: "3f2a1b4c-9d8e-4f7a-b6c5-d4e3f2a1b098", categoryId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", date: "2026-09-01", createdAt: "2026-09-01" },
    ]);
  });

  it("accepts empty tables and returns zero counts", async () => {
    const counts = await importJSON(
      validBackupJSON({ wallets: [], categories: [], transactions: [], budgets: [], debts: [], recurring: [] }),
    );
    expect(counts).toEqual({ wallets: 0, categories: 0, transactions: 0, budgets: 0, debts: 0, recurring: 0 });
  });

  it("malformed JSON: rejects with a clear message, never a raw SyntaxError, DB untouched", async () => {
    let err: unknown;
    try {
      await importJSON("{not valid json!!!");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toMatch(/not valid JSON/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
    for (const t of allTables) {
      expect(t.clear).not.toHaveBeenCalled();
      expect(t.bulkPut).not.toHaveBeenCalled();
    }
  });

  it("rejects valid JSON with the wrong app field, DB untouched", async () => {
    await expect(importJSON(validBackupJSON({ app: "other-app" }))).rejects.toThrow(/doesn't look like a Blink backup/i);
    await expect(importJSON(JSON.stringify({ wallets: [] }))).rejects.toThrow(/doesn't look like a Blink backup/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a top-level array (valid JSON, wrong shape)", async () => {
    await expect(importJSON(JSON.stringify([1, 2, 3]))).rejects.toThrow(/doesn't look like a .*backup/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["wallets", "categories", "transactions", "budgets", "debts", "recurring"] as const)(
    "rejects a backup missing the %s field, DB untouched",
    async (field) => {
      const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
      delete obj[field];
      await expect(importJSON(JSON.stringify(obj))).rejects.toThrow(new RegExp(field));
      expect(mocks.transaction).not.toHaveBeenCalled();
      for (const t of allTables) expect(t.clear).not.toHaveBeenCalled();
    },
  );

  it("rejects non-array table fields and non-object rows", async () => {
    await expect(importJSON(validBackupJSON({ wallets: {} }))).rejects.toThrow(/wallets/);
    await expect(importJSON(validBackupJSON({ transactions: [null] }))).rejects.toThrow(/transactions/);
    await expect(importJSON(validBackupJSON({ debts: ["not-an-object"] }))).rejects.toThrow(/debts/);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("parseBackup returns the parsed rows without touching the DB", () => {
    const backup = parseBackup(validBackupJSON());
    expect(backup.wallets).toHaveLength(1);
    expect(backup.transactions[0].walletId).toBe("3f2a1b4c-9d8e-4f7a-b6c5-d4e3f2a1b098");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("stores hostile strings as inert text: no eval, no HTML execution, no prototype pollution", async () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
    (obj.wallets as Record<string, unknown>[])[0].name = evil;
    (obj.categories as Record<string, unknown>[])[0].name = evil;
    (obj.transactions as Record<string, unknown>[])[0].note = evil;
    (obj.wallets as Record<string, unknown>[]).push(JSON.parse('{"__proto__":{"polluted":true},"name":"p","currency":"CRC"}'));
    await importJSON(JSON.stringify(obj));
    // Passed through verbatim as inert strings — rendering is JSX text (auto-escaped).
    expect(mocks.wallets.bulkPut).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: evil })])
    );
    expect(mocks.transactions.bulkPut).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ note: evil })])
    );
    // JSON.parse creates an OWN __proto__ property; the prototype is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
  });

  it("round-trips Recurring with anchorDay and endDate: new fields preserved", async () => {
    // Regression: anchorDay and endDate were added to Recurring; ensure they survive export/import.
    const backup = validBackupJSON({
      recurring: [
        {
          id: "e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8091",
          label: "Rent",
          type: "expense",
          amount: 1000,
          currency: "USD",
          walletId: "3f2a1b4c-9d8e-4f7a-b6c5-d4e3f2a1b098",
          categoryId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
          nextDate: "2026-10-01",
          frequency: "monthly",
          active: true,
          anchorDay: 31,  // new field added in earlier passes
          endDate: "2027-12-31",  // new field added in earlier passes
        },
      ],
    });
    await importJSON(backup);
    // Verify bulkPut received the row with both new fields intact.
    expect(mocks.recurring.bulkPut).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8091",
          label: "Rent",
          anchorDay: 31,
          endDate: "2027-12-31",
        }),
      ])
    );
  });

  it("round-trips Wallet with custom currency: custom currencies survive export/import", async () => {
    // Regression: custom (non-preset) currencies should survive the round-trip.
    // CRC is not in CURRENCIES preset, testing it stays intact. A legacy
    // numeric wallet id is intentionally re-keyed, and its transaction and
    // recurring FKs must follow it to the same new UUID.
    const backup = validBackupJSON({
      wallets: [
        {
          id: 1,
          name: "Costa Rica Bank",
          kind: "bank",
          color: "blue",
          currency: "CRC",  // custom currency, not in preset list
          createdAt: "2026-01-01",
          openingBalance: 50000,
          openingDate: "2025-12-15",
        },
      ],
      transactions: [
        {
          id: 2,
          type: "income",
          amount: 1000,
          currency: "CRC",
          walletId: 1,
          date: "2026-09-01",
          createdAt: "2026-09-01",
        },
      ],
      recurring: [
        {
          id: 3,
          label: "Legacy recurring",
          type: "income",
          amount: 100,
          currency: "CRC",
          walletId: 1,
          nextDate: "2026-10-01",
          frequency: "monthly",
        },
      ],
    });
    await importJSON(backup);
    const wallet = mocks.wallets.bulkPut.mock.calls[0][0][0];
    expect(wallet).toEqual(
      expect.objectContaining({
        currency: "CRC",
        openingBalance: 50000,
        openingDate: "2025-12-15",
      })
    );
    expect(typeof wallet.id).toBe("string");
    expect(wallet.id).not.toBe(1);
    expect(mocks.transactions.bulkPut).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ walletId: wallet.id }),
      ])
    );
    expect(mocks.recurring.bulkPut).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ walletId: wallet.id }),
      ])
    );
  });
});

describe("parseTransactionsCSV", () => {
  const mockWallets = [
    { id: "w1", name: "Cash", currency: "USD", kind: "cash" as const, color: "green", createdAt: "2026-01-01" },
    { id: "w2", name: "Visa", currency: "USD", kind: "card" as const, color: "blue", createdAt: "2026-01-01" },
    { id: "w3", name: "CRC Bank", currency: "CRC", kind: "bank" as const, color: "red", createdAt: "2026-01-01" },
  ];
  const mockCategories = [
    { id: "c7", name: "Food", icon: "🍔", color: "orange", kind: "expense" as const },
    { id: "c8", name: "Transport", icon: "🚗", color: "blue", kind: "expense" as const },
    { id: "c9", name: "Salary", icon: "💰", color: "green", kind: "income" as const },
  ];

  it("round-trips: export then import produces equivalent transactions", () => {
    const original = [
      { date: "2026-09-01", type: "expense" as const, amount: 1500, currency: "USD", wallet: "Cash", toWallet: "", category: "Food", note: "Lunch" },
      { date: "2026-09-02", type: "income" as const, amount: 5000, currency: "USD", wallet: "Visa", toWallet: "", category: "Salary", note: "" },
      { date: "2026-09-03", type: "transfer" as const, amount: 1000, currency: "USD", wallet: "Cash", toWallet: "Visa", category: "", note: "" },
    ];
    const csv = transactionsToCSV(original);
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(3);
    // Check first transaction (expense with category)
    expect(transactions[0]).toMatchObject({
      type: "expense",
      amount: 1500,
      currency: "USD",
      walletId: "w1",
      categoryId: "c7",
      note: "Lunch",
    });
    // Check second transaction (income)
    expect(transactions[1]).toMatchObject({
      type: "income",
      amount: 5000,
      currency: "USD",
      walletId: "w2",
      categoryId: "c9",
      note: undefined,
    });
    // Check third transaction (transfer)
    expect(transactions[2]).toMatchObject({
      type: "transfer",
      amount: 1000,
      currency: "USD",
      walletId: "w1",
      toWalletId: "w2",
      categoryId: undefined,
    });
  });

  it("returns empty transactions and an error when CSV is empty", () => {
    const { transactions, errors } = parseTransactionsCSV("", mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns empty transactions and an error on header mismatch", () => {
    const badHeader = "date,type,amount,currency,wallet,category,note";
    const { transactions, errors } = parseTransactionsCSV(badHeader, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/Header mismatch/);
  });

  it("rejects a row with an unknown wallet name", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","UnknownWallet","","Food","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors).toContainEqual(expect.stringContaining("UnknownWallet"));
    expect(errors).toContainEqual(expect.stringContaining("not found"));
  });

  it("rejects a row with mismatched currency vs wallet", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","CRC","Cash","","Food","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/currency.*does not match.*wallet/i);
    expect(errors[0]).toContain("CRC");
    expect(errors[0]).toContain("USD");
  });

  it("rejects a row with an unknown category", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","","UnknownCategory","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/category.*not found/i);
  });

  it("rejects a row with invalid amount", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","abc","USD","Cash","","Food","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/amount.*positive number/i);
  });

  it("rejects a row with zero or negative amount", () => {
    const csv1 = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","0","USD","Cash","","Food","test"';
    const { transactions: t1, errors: e1 } = parseTransactionsCSV(csv1, mockWallets, mockCategories);
    expect(t1).toHaveLength(0);
    expect(e1[0]).toMatch(/positive/i);

    const csv2 = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","-50","USD","Cash","","Food","test"';
    const { transactions: t2, errors: e2 } = parseTransactionsCSV(csv2, mockWallets, mockCategories);
    expect(t2).toHaveLength(0);
    expect(e2[0]).toMatch(/positive/i);
  });

  it("rejects a row with an invalid date", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"not-a-date","expense","100","USD","Cash","","Food","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/date.*not a valid ISO date/i);
  });

  it("rejects a row with an invalid type", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","invalid","100","USD","Cash","","Food","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/type.*must be.*expense.*income.*transfer/i);
  });

  it("rejects a transfer without a destination wallet", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","transfer","100","USD","Cash","","","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/transfer requires a destination wallet/i);
  });

  it("rejects a transfer to an unknown destination wallet", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","transfer","100","USD","Cash","UnknownWallet","","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/destination wallet.*not found/i);
  });

  it("rejects a transfer between wallets of different currencies", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","transfer","100","USD","Cash","CRC Bank","","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/transfer wallets must have same currency/i);
  });

  it("rejects non-transfer when to_wallet column is filled", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","Visa","Food","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/to_wallet should be empty/i);
  });

  it("allows expense with no category (empty category column)", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","","","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      type: "expense",
      categoryId: undefined,
    });
  });

  it("matches wallet and category names case-insensitively", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","cash","","food","test"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].walletId).toBe("w1");
    expect(transactions[0].categoryId).toBe("c7");
  });

  it("handles rows with column count mismatch", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/expected 8 columns.*got 3/);
  });

  it("skips empty lines and parses valid rows", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","","Food","line1"\n\n"2026-09-02","income","200","USD","Visa","","Salary","line3"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(2);
    expect(transactions[0].note).toBe("line1");
    expect(transactions[1].note).toBe("line3");
  });

  it("collects multiple errors across multiple rows", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"invalid","expense","100","USD","Cash","","Food","row1"\n"2026-09-02","unknown","200","USD","Cash","","Food","row2"\n"2026-09-03","expense","0","USD","Cash","","Food","row3"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors.length).toBe(3);
    expect(errors).toContainEqual(expect.stringMatching(/Row 2.*date.*invalid/i));
    expect(errors).toContainEqual(expect.stringMatching(/Row 3.*type/i));
    expect(errors).toContainEqual(expect.stringMatching(/Row 4.*positive/i));
  });

  it("rejects a row whose wallet name matches more than one account", () => {
    const dupes = [
      ...mockWallets,
      { id: "w9", name: "Cash", currency: "USD", kind: "cash" as const, color: "green", createdAt: "2026-01-01" },
    ];
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","","Food","x"';
    const { transactions, errors } = parseTransactionsCSV(csv, dupes, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/more than one account/i);
  });

  it("rejects a row whose wallet name only differs by accents or case", () => {
    const folded = [
      ...mockWallets,
      { id: "w9", name: "cAsH", currency: "USD", kind: "cash" as const, color: "green", createdAt: "2026-01-01" },
    ];
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","","Food","x"';
    const { transactions, errors } = parseTransactionsCSV(csv, folded, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/more than one account/i);
  });

  it("still imports when exactly one account matches", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","","Food","x"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);
  });

  it("rejects an expense row that names an income-only category", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","","Salary","x"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors[0]).toMatch(/not found for type "expense"/i);
  });

  it("still matches the category when the kind agrees", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","income","100","USD","Cash","","Salary","x"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(errors).toHaveLength(0);
    expect(transactions[0].categoryId).toBe("c9");
  });

  it("handles malformed CSV gracefully (returns errors, doesn't throw)", () => {
    const malformed = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100"';
    expect(() => {
      parseTransactionsCSV(malformed, mockWallets, mockCategories);
    }).not.toThrow();
    const { transactions, errors } = parseTransactionsCSV(malformed, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("parses CSV with quoted fields containing commas and escaped quotes", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-01","expense","100","USD","Cash","","Food","lunch, dinner with ""quotes"""';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].note).toBe('lunch, dinner with "quotes"');
  });

  it("handles Windows CRLF line endings correctly", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\r\n"2026-09-01","expense","100","USD","Cash","","Food","lunch"\r\n"2026-09-02","income","200","USD","Visa","","Salary","paycheck"';
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      type: "expense",
      amount: 100,
      note: "lunch",
    });
    expect(transactions[1]).toMatchObject({
      type: "income",
      amount: 200,
      note: "paycheck",
    });
  });

  it("rejects CSV with only a header row and no data", () => {
    const csv = "date,type,amount,currency,wallet,to_wallet,category,note";
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/only a header/i);
  });

  it("rejects CSV with only a header row and blank lines (no valid data)", () => {
    const csv = "date,type,amount,currency,wallet,to_wallet,category,note\n\n";
    const { transactions, errors } = parseTransactionsCSV(csv, mockWallets, mockCategories);
    expect(transactions).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/only a header/i);
  });
});

describe("restore hardening (integrity audit)", () => {
  const wallets = [
    { id: "w1", name: "Cash", currency: "USD", kind: "cash" as const, color: "green", createdAt: "2026-01-01" },
    { id: "w2", name: "Visa", currency: "USD", kind: "card" as const, color: "blue", createdAt: "2026-01-01" },
  ];
  const categories = [
    { id: "c7", name: "Food", icon: "🍔", color: "orange", kind: "expense" as const },
  ];
  it("parseBackup rejects an unknown transaction type", () => {
    const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
    (obj.transactions as Record<string, unknown>[])[0].type = "lottery";
    expect(() => parseBackup(JSON.stringify(obj))).toThrow(/invalid type/i);
  });

  it("parseBackup rejects non-positive and non-numeric amounts", () => {
    for (const amount of [0, -5, "abc", null]) {
      const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
      (obj.transactions as Record<string, unknown>[])[0].amount = amount;
      expect(() => parseBackup(JSON.stringify(obj))).toThrow(/invalid amount/i);
    }
  });

  it("parsePercentInput refuses a rate above the ceiling instead of dropping it", () => {
    expect(parsePercentInput("2", MAX_CASHBACK_PCT)).toEqual({ pct: 2, tooHigh: false });
    expect(parsePercentInput("", MAX_CASHBACK_PCT)).toEqual({ tooHigh: false });
    expect(parsePercentInput("0", MAX_CASHBACK_PCT)).toEqual({ tooHigh: false });
    expect(parsePercentInput("-5", MAX_CASHBACK_PCT)).toEqual({ tooHigh: false });
    expect(parsePercentInput("abc", MAX_CASHBACK_PCT)).toEqual({ tooHigh: false });
    expect(parsePercentInput("100", MAX_CASHBACK_PCT)).toEqual({ pct: 100, tooHigh: false });
    expect(parsePercentInput("200", MAX_CASHBACK_PCT).tooHigh).toBe(true);
    expect(parsePercentInput("99999", MAX_ROI_PCT).tooHigh).toBe(true);
    expect(parsePercentInput("13", MAX_ROI_PCT)).toEqual({ pct: 13, tooHigh: false });
  });

  it("parseBackup rejects a malformed wallet currency", () => {
    const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
    (obj.wallets as Record<string, unknown>[])[0].currency = "usd";
    expect(() => parseBackup(JSON.stringify(obj))).toThrow(/invalid currency/i);
  });

  it("parseBackup rejects a missing or non-string currency, not just a malformed one", () => {
    for (const bad of [undefined, 42, null]) {
      const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
      (obj.wallets as Record<string, unknown>[])[0].currency = bad;
      expect(() => parseBackup(JSON.stringify(obj))).toThrow(/invalid currency/i);
    }
  });

  it("parseBackup checks the currency on every table that has one", () => {
    for (const table of ["transactions", "budgets", "debts", "recurring"]) {
      const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
      delete ((obj[table] as Record<string, unknown>[])[0] as Record<string, unknown>).currency;
      expect(() => parseBackup(JSON.stringify(obj))).toThrow(/invalid currency/i);
    }
  });

  it("parseBackup dedupes repeated ids, keeping the first row", () => {
    const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
    const txs = obj.transactions as Record<string, unknown>[];
    txs.push({ ...txs[0], note: "twin" });
    const backup = parseBackup(JSON.stringify(obj));
    expect(backup.transactions).toHaveLength(1);
    expect(backup.transactions[0].note).toBeUndefined();
  });

  it("importJSON refuses a backup with orphaned rows, DB untouched", async () => {
    const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
    (obj.transactions as Record<string, unknown>[]).push(
      { id: 12, type: "expense", amount: 400, currency: "CRC", walletId: 999, date: "2026-09-02", createdAt: "2026-09-02" }
    );
    await expect(importJSON(JSON.stringify(obj))).rejects.toThrow(/damaged.*not restored/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("importJSON refuses a cross-currency transfer row, DB untouched", async () => {
    const obj = JSON.parse(validBackupJSON()) as Record<string, unknown>;
    (obj.transactions as Record<string, unknown>[]).push(
      { id: 13, type: "transfer", amount: 500, currency: "CRC", walletId: 1, toWalletId: 999, date: "2026-09-02", createdAt: "2026-09-02" }
    );
    await expect(importJSON(JSON.stringify(obj))).rejects.toThrow(/damaged.*not restored/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("CSV date-only rows parse as local midday, not UTC midnight", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-10","expense","100","USD","Cash","","Food","x"';
    const { transactions, errors } = parseTransactionsCSV(csv, wallets, categories);
    expect(errors).toHaveLength(0);
    expect(transactions[0].date).toBe(new Date("2026-09-10T12:00:00").toISOString());
  });

  it("CSV sub-cent amounts round to cents at intake", () => {
    const csv = 'date,type,amount,currency,wallet,to_wallet,category,note\n"2026-09-10T12:00:00","expense","0.005","USD","Cash","","Food","x"';
    const { transactions, errors } = parseTransactionsCSV(csv, wallets, categories);
    expect(errors).toHaveLength(0);
    expect(transactions[0].amount).toBe(0.01);
  });
});
