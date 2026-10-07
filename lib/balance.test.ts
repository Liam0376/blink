import { describe, expect, it } from "vitest";
import {
  cashbackCreditTransaction,
  cashbackEarnedForWallet,
  computeBalances,
  computeCashback,
  computeGrownBalances,
  growBalance,
  lastActivityDate,
  lastCutDate,
  creditsSinceCut,
  netWorthFromBalances,
  statementAmount,
  totalCashbackByWallet,
} from "./balances";
import type { Currency } from "./db";

/**
 * Balance math tests run against the REAL `computeBalances` from
 * lib/balances.ts (the same function app/page.tsx uses for
 * `balanceByWallet`) — never a verbatim replica. If the app's money logic
 * drifts, these tests fail.
 *
 * Also pinned as-is: the cross-currency transfer semantics (raw amount, no
 * FX) and the month/budget net behaviors documented below. If FX support is
 * ever added, these tests must be updated deliberately.
 */

type TxType = "expense" | "income" | "transfer";

interface MiniTx {
  type: TxType;
  amount: number;
  currency: Currency;
  walletId: string;
  toWalletId?: string;
}

interface MiniWallet {
  id?: string;
  openingBalance?: number;
  currency: Currency;
  archived?: boolean;
}

const w = (
  id?: string,
  openingBalance?: number,
  currency: Currency = "USD",
  archived?: boolean
): MiniWallet => ({
  id,
  ...(openingBalance !== undefined && { openingBalance }),
  currency,
  ...(archived && { archived }),
});

// --- app/page.tsx: netByCurrency ---
function netByCurrency(transactions: MiniTx[]): Map<Currency, { in: number; out: number }> {
  const m = new Map<Currency, { in: number; out: number }>();
  for (const t of transactions) {
    if (t.type === "transfer") continue;
    const e = m.get(t.currency) ?? { in: 0, out: 0 };
    if (t.type === "income") e.in += t.amount;
    else e.out += t.amount;
    m.set(t.currency, e);
  }
  return m;
}

// --- app/page.tsx: budgetProgress core (spent + pct) ---
type DatedTx = MiniTx & { date: string };

function budgetSpent(
  transactions: DatedTx[],
  opts: { currency: Currency; since: Date; categoryId?: string | null },
  txCategoryId: (t: DatedTx) => string | undefined = () => undefined,
): { spent: number; pct: (limit: number) => number } {
  const spent = transactions
    .filter(
      (t) =>
        t.type === "expense" && t.currency === opts.currency && new Date(t.date) >= opts.since,
    )
    .filter((t) => (opts.categoryId ? txCategoryId(t) === opts.categoryId : true))
    .reduce((a, t) => a + t.amount, 0);
  return { spent, pct: (limit: number) => (limit > 0 ? (spent / limit) * 100 : 0) };
}

describe("computeBalances (lib/balances.ts — app/page.tsx source of truth)", () => {
  it("adds income and subtracts expenses per wallet", () => {
    const m = computeBalances([w("w1")], [
      { type: "income", amount: 10000, currency: "CRC", walletId: "w1" },
      { type: "expense", amount: 2500, currency: "CRC", walletId: "w1" },
    ]);
    expect(m.get("w1")).toBe(7500);
  });

  it("seeds each wallet from its openingBalance", () => {
    const m = computeBalances([w("w1", 500), w("w2", 1000)], [
      { type: "expense", amount: 50, currency: "USD", walletId: "w1" },
    ]);
    expect(m.get("w1")).toBe(450);
    expect(m.get("w2")).toBe(1000);
  });

  it("keeps wallets independent", () => {
    const m = computeBalances([w("w1"), w("w2")], [
      { type: "income", amount: 100, currency: "CRC", walletId: "w1" },
      { type: "income", amount: 200, currency: "USD", walletId: "w2" },
      { type: "expense", amount: 30, currency: "CRC", walletId: "w1" },
    ]);
    expect(m.get("w1")).toBe(70);
    expect(m.get("w2")).toBe(200);
  });

  it("moves money on transfer: debit source, credit destination", () => {
    const m = computeBalances([w("w1"), w("w2")], [
      { type: "income", amount: 1000, currency: "CRC", walletId: "w1" },
      { type: "transfer", amount: 400, currency: "CRC", walletId: "w1", toWalletId: "w2" },
    ]);
    expect(m.get("w1")).toBe(600);
    expect(m.get("w2")).toBe(400);
  });

  it("drops the credit leg when a transfer has no destination (documented as-is)", () => {
    const m = computeBalances([w("w1")], [
      { type: "income", amount: 1000, currency: "CRC", walletId: "w1" },
      { type: "transfer", amount: 400, currency: "CRC", walletId: "w1" },
    ]);
    expect(m.get("w1")).toBe(600);
    expect(m.has("w2")).toBe(false);
  });

  it("transfer to self nets to zero change", () => {
    const m = computeBalances([w("w1")], [
      { type: "income", amount: 1000, currency: "CRC", walletId: "w1" },
      { type: "transfer", amount: 400, currency: "CRC", walletId: "w1", toWalletId: "w1" },
    ]);
    expect(m.get("w1")).toBe(1000);
  });

  it("CROSS-CURRENCY transfer adds the RAW amount with NO FX conversion (documented as-is)", () => {
    // 500 "CRC-side" units moved into a USD wallet credit 500 units there.
    // There is no exchange-rate logic in the app today; if FX support is
    // ever added, this test must be updated deliberately.
    const m = computeBalances([w("w1"), w("w2")], [
      { type: "income", amount: 10000, currency: "CRC", walletId: "w1" },
      { type: "transfer", amount: 500, currency: "CRC", walletId: "w1", toWalletId: "w2" },
    ]);
    expect(m.get("w1")).toBe(9500);
    expect(m.get("w2")).toBe(500);
  });

  it("starts unknown wallets from zero", () => {
    const m = computeBalances([], [{ type: "expense", amount: 50, currency: "CRC", walletId: "w9" }]);
    expect(m.get("w9")).toBe(-50);
  });

  it("rounds per operation to avoid floating-point drift", () => {
    const m = computeBalances([w("w1")], [
      { type: "income", amount: 0.1, currency: "USD", walletId: "w1" },
      { type: "income", amount: 0.2, currency: "USD", walletId: "w1" },
    ]);
    expect(m.get("w1")).toBe(0.3);
  });

  // Regression: money math must see EVERY transaction, not a paginated
  // prefix. The old app/page.tsx fed `balanceByWallet` from a live query
  // limited to `historyLimit` (120), so with >120 rows older history was
  // silently dropped and balances undercounted. The fix wires a separate
  // full-dataset query (`allTransactions`) into the money math; this test
  // pins the correct full-set result for 150 transactions so reintroducing
  // any truncation into the math path fails loudly.
  // (The Dexie live-query wiring itself can't be unit-tested here — the
  // separation in app/page.tsx plus this test is the deliverable.)
  it("REGRESSION: sees all 150 transactions, not a 120-truncated prefix", () => {
    const txs: MiniTx[] = Array.from({ length: 150 }, (_, i) => ({
      type: "expense" as const,
      amount: 1,
      currency: "USD" as Currency,
      walletId: i % 2 === 0 ? "w1" : "w2",
    }));
    const full = computeBalances([w("w1", 10000), w("w2", 10000)], txs);
    // 75 x $1 expenses per wallet.
    expect(full.get("w1")).toBe(9925);
    expect(full.get("w2")).toBe(9925);

    // What the old paginated wiring produced: the newest 120 rows only, so
    // the oldest 30 expenses ($15 per wallet) went missing from the balance.
    const truncated = computeBalances([w("w1", 10000), w("w2", 10000)], txs.slice(0, 120));
    expect(truncated.get("w1")).toBe(9940);
    expect(truncated.get("w2")).toBe(9940);
    expect(full.get("w1")).not.toBe(truncated.get("w1"));
  });
});

describe("netByCurrency (app/page.tsx replica)", () => {
  it("accumulates income vs expense per currency", () => {
    const m = netByCurrency([
      { type: "income", amount: 5000, currency: "CRC", walletId: "w1" },
      { type: "expense", amount: 1500, currency: "CRC", walletId: "w1" },
      { type: "income", amount: 100, currency: "USD", walletId: "w2" },
    ]);
    expect(m.get("CRC")).toEqual({ in: 5000, out: 1500 });
    expect(m.get("USD")).toEqual({ in: 100, out: 0 });
  });

  it("excludes transfers entirely — they create/destroy no money", () => {
    const m = netByCurrency([
      { type: "income", amount: 1000, currency: "CRC", walletId: "w1" },
      { type: "transfer", amount: 1000, currency: "CRC", walletId: "w1", toWalletId: "w2" },
    ]);
    expect(m.get("CRC")).toEqual({ in: 1000, out: 0 });
    const net = (m.get("CRC")?.in ?? 0) - (m.get("CRC")?.out ?? 0);
    expect(net).toBe(1000);
  });

  it("computes net as in minus out", () => {
    const m = netByCurrency([
      { type: "income", amount: 300, currency: "USD", walletId: "w1" },
      { type: "expense", amount: 120, currency: "USD", walletId: "w1" },
    ]);
    const e = m.get("USD")!;
    expect(e.in - e.out).toBe(180);
  });
});

describe("budget progress math (app/page.tsx replica)", () => {
  const since = new Date(2026, 8, 1); // Sep 1 2026 local
  const tx = (over: Partial<MiniTx> & { date: string }): DatedTx =>
    ({ type: "expense", amount: 0, currency: "CRC", walletId: "w1", ...over });

  it("sums only expenses in the budget currency on/after the period start", () => {
    const { spent } = budgetSpent(
      [
        tx({ date: "2026-09-05T10:00", amount: 1000 }),
        tx({ date: "2026-08-20T10:00", amount: 9999 }), // before period: ignored
        tx({ date: "2026-09-06T10:00", amount: 50, currency: "USD" }), // wrong currency: ignored
        { type: "income", amount: 5000, currency: "CRC", walletId: "w1", date: "2026-09-07T10:00" }, // income: ignored
      ],
      { currency: "CRC", since },
    );
    expect(spent).toBe(1000);
  });

  it("computes pct of limit and guards divide-by-zero", () => {
    const { pct } = budgetSpent([tx({ date: "2026-09-05T10:00", amount: 250 })], {
      currency: "CRC",
      since,
    });
    expect(pct(1000)).toBe(25);
    expect(pct(0)).toBe(0);
  });

  it("overspend yields pct > 100", () => {
    const { pct } = budgetSpent([tx({ date: "2026-09-05T10:00", amount: 1500 })], {
      currency: "CRC",
      since,
    });
    expect(pct(1000)).toBe(150);
  });
});

describe("growBalance (ROI display projection)", () => {
  it("grows a balance compounding annually over exactly one year", () => {
    const since = new Date("2025-01-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:00Z");
    expect(growBalance(1000, 13, since, now)).toBeCloseTo(1130, 2);
  });

  it("returns the balance unchanged when roiAnnualPct is unset, zero, or negative", () => {
    const since = new Date("2025-01-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:00Z");
    expect(growBalance(1000, undefined, since, now)).toBe(1000);
    expect(growBalance(1000, 0, since, now)).toBe(1000);
    expect(growBalance(1000, -5, since, now)).toBe(1000);
  });

  it("never grows a non-positive balance (no compounding on debt/empty wallets)", () => {
    const since = new Date("2025-01-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:00Z");
    expect(growBalance(0, 13, since, now)).toBe(0);
    expect(growBalance(-500, 13, since, now)).toBe(-500);
  });

  it("returns the balance unchanged when `now` is not after `since`", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    expect(growBalance(1000, 13, t, t)).toBe(1000);
    expect(growBalance(1000, 13, new Date("2026-06-01"), new Date("2026-01-01"))).toBe(1000);
  });

  it("compounds partial years correctly (~half a year)", () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-07-02T00:00:00Z"); // ~182.5 days
    const grown = growBalance(1000, 13, since, now);
    // sqrt(1.13) ≈ 1.06301 for half a year
    expect(grown).toBeCloseTo(1063, 0);
  });
});

describe("lastActivityDate", () => {
  it("falls back to openingDate, then createdAt, when there's no matching transaction", () => {
    expect(
      lastActivityDate({ id: "w1", openingDate: "2025-06-01", createdAt: "2025-01-01" }, [])
    ).toEqual(new Date("2025-06-01"));
    expect(lastActivityDate({ id: "w1", createdAt: "2025-01-01" }, [])).toEqual(new Date("2025-01-01"));
  });

  it("picks the most recent transaction touching the wallet as source or transfer destination", () => {
    const d = lastActivityDate({ id: "w1", createdAt: "2020-01-01" }, [
      { walletId: "w1", date: "2025-03-01" },
      { walletId: "w2", toWalletId: "w1", date: "2025-08-15" },
      { walletId: "w1", date: "2025-05-01" },
    ]);
    expect(d).toEqual(new Date("2025-08-15"));
  });

  it("ignores transactions that don't reference the wallet at all", () => {
    const d = lastActivityDate({ id: "w1", createdAt: "2020-01-01" }, [
      { walletId: "w99", toWalletId: "w98", date: "2025-08-15" },
    ]);
    expect(d).toEqual(new Date("2020-01-01"));
  });
});

describe("computeGrownBalances", () => {
  it("leaves wallets without roiAnnualPct untouched", () => {
    const balances = new Map([["w1", 1000]]);
    const grown = computeGrownBalances([{ id: "w1", createdAt: "2025-01-01" }], balances, [], new Date("2026-01-01"));
    expect(grown.get("w1")).toBe(1000);
  });

  it("grows a wallet with roiAnnualPct set, anchored to its last activity", () => {
    const balances = new Map([["w1", 1000]]);
    const grown = computeGrownBalances(
      [{ id: "w1", roiAnnualPct: 13, createdAt: "2025-01-01" }],
      balances,
      [{ walletId: "w1", date: "2025-01-01" }],
      new Date("2026-01-01")
    );
    expect(grown.get("w1")).toBeCloseTo(1130, 2);
  });

  it("does not mutate the input balances map", () => {
    const balances = new Map([["w1", 1000]]);
    computeGrownBalances([{ id: "w1", roiAnnualPct: 13, createdAt: "2025-01-01" }], balances, [], new Date("2026-01-01"));
    expect(balances.get("w1")).toBe(1000);
  });

  it("anchors to roiRateSince instead of retroactively re-pricing elapsed days when the rate changes", () => {
    const balances = new Map([["w1", 1000]]);
    // A month has already elapsed at 13% (no new transaction since), then the
    // rate drops to 7% today. Growth must restart from today at 7% - it must
    // NOT apply 7% to the whole month that already elapsed under 13%.
    const grown = computeGrownBalances(
      [{ id: "w1", roiAnnualPct: 7, roiRateSince: "2026-01-31", createdAt: "2025-01-01" }],
      balances,
      [{ walletId: "w1", date: "2026-01-01" }],
      new Date("2026-01-31") // same instant as the rate change - zero days at the new rate yet
    );
    expect(grown.get("w1")).toBe(1000);
  });

  it("still grows at the old rate for days before roiRateSince took effect (rate change is prospective only)", () => {
    // Same setup, but 10 more days pass after the rate change to 7%.
    const balances = new Map([["w1", 1000]]);
    const grown = computeGrownBalances(
      [{ id: "w1", roiAnnualPct: 7, roiRateSince: "2026-01-31", createdAt: "2025-01-01" }],
      balances,
      [{ walletId: "w1", date: "2026-01-01" }],
      new Date("2026-02-10")
    );
    // 10 days at 7%/yr on 1000, not 40 days (Jan 1 -> Feb 10) at 7%.
    const expected = 1000 * Math.pow(1.07, 10 / 365);
    expect(grown.get("w1")).toBeCloseTo(expected, 2);
  });
});

describe("netWorthFromBalances", () => {
  it("sums an already-computed balances map by currency, excluding archived wallets", () => {
    const result = netWorthFromBalances(
      [
        { id: "w1", currency: "USD" },
        { id: "w2", currency: "USD", archived: true },
        { id: "w3", currency: "EUR" },
      ],
      new Map([["w1", 1130], ["w2", 99999], ["w3", 50]])
    );
    expect(result).toEqual([
      { currency: "USD", total: 1130 },
      { currency: "EUR", total: 50 },
    ]);
  });

  it("returns [] when there are no active wallets", () => {
    expect(netWorthFromBalances([{ id: "w1", currency: "USD", archived: true }], new Map([["w1", 500]]))).toEqual([]);
  });

  it("sorts by absolute value descending, negative balances included as negative", () => {
    const result = netWorthFromBalances(
      [
        { id: "w1", currency: "USD" },
        { id: "w2", currency: "EUR" },
        { id: "w3", currency: "CRC" },
      ],
      new Map([["w1", 100], ["w2", -80], ["w3", 200]])
    );
    expect(result).toEqual([
      { currency: "CRC", total: 200 },
      { currency: "USD", total: 100 },
      { currency: "EUR", total: -80 },
    ]);
  });
});

describe("computeCashback", () => {
  it("earns cashback on an expense against a card with a positive rate", () => {
    expect(computeCashback("expense", 500, { kind: "card", cashbackPct: 2 })).toBe(10);
  });

  it("never earns cashback on income or transfers, even on a cashback card", () => {
    expect(computeCashback("income", 500, { kind: "card", cashbackPct: 2 })).toBeUndefined();
    expect(computeCashback("transfer", 500, { kind: "card", cashbackPct: 2 })).toBeUndefined();
  });

  it("never earns cashback on a non-card wallet", () => {
    expect(computeCashback("expense", 500, { kind: "cash", cashbackPct: 2 })).toBeUndefined();
    expect(computeCashback("expense", 500, { kind: "bank", cashbackPct: 2 })).toBeUndefined();
  });

  it("never earns cashback when the card has no rate, or a zero/negative one", () => {
    expect(computeCashback("expense", 500, { kind: "card" })).toBeUndefined();
    expect(computeCashback("expense", 500, { kind: "card", cashbackPct: 0 })).toBeUndefined();
    expect(computeCashback("expense", 500, { kind: "card", cashbackPct: -3 })).toBeUndefined();
  });

  it("rounds to cents", () => {
    expect(computeCashback("expense", 33.33, { kind: "card", cashbackPct: 2.5 })).toBeCloseTo(0.83, 2);
  });
});

describe("totalCashbackByWallet", () => {
  it("sums cashbackEarned per wallet, ignoring rows without it", () => {
    const result = totalCashbackByWallet([
      { walletId: "w1", cashbackEarned: 10 },
      { walletId: "w1", cashbackEarned: 5.5 },
      { walletId: "w2", cashbackEarned: 3 },
      { walletId: "w1" },
      { walletId: "w3", cashbackEarned: 0 },
    ]);
    expect(result.get("w1")).toBeCloseTo(15.5, 2);
    expect(result.get("w2")).toBe(3);
    expect(result.has("w3")).toBe(false);
  });

  it("returns an empty map for no cashback-earning transactions", () => {
    expect(totalCashbackByWallet([{ walletId: "w1" }]).size).toBe(0);
  });

  it("a rate change never rewrites cashback already earned and stored on past transactions", () => {
    // Same transaction list, computed once when the card was at 2%, then the
    // card's rate changes to 5%. totalCashbackByWallet only ever reads the
    // frozen per-transaction values - it must not re-derive from the wallet's
    // current rate, so the total stays exactly what was actually earned.
    const pastTransactions = [
      { walletId: "w1", cashbackEarned: computeCashback("expense", 500, { kind: "card", cashbackPct: 2 }) },
    ];
    const totalBefore = totalCashbackByWallet(pastTransactions).get("w1");
    // Rate changes on the wallet - pastTransactions is untouched.
    const totalAfter = totalCashbackByWallet(pastTransactions).get("w1");
    expect(totalBefore).toBe(10);
    expect(totalAfter).toBe(10);
  });

  it("turning on cashback for a card with an existing debt/history never credits cashback on that pre-existing balance", () => {
    // A card set up with -6975.84 already owed (openingBalance), plus a
    // pre-existing expense logged before cashback existed on this wallet
    // (no cashbackEarned field at all - the realistic shape of old rows).
    const card = { id: "w1", kind: "card" as const, openingBalance: -6975.84, cashbackPct: 1 };
    const priorTransactions = [
      { type: "expense" as const, amount: 200, currency: "MXN", walletId: "w1", toWalletId: undefined },
    ];
    // Balances never look at cashbackPct/cashbackEarned at all.
    const balances = computeBalances([card], priorTransactions);
    expect(balances.get("w1")).toBe(-7175.84); // unaffected by cashbackPct being set

    // Nor does the cashback total: the prior expense has no cashbackEarned,
    // so turning cashbackPct on today doesn't retroactively invent one.
    const total = totalCashbackByWallet(priorTransactions.map((t) => ({ walletId: t.walletId })));
    expect(total.has("w1")).toBe(false);
  });
});

describe("cashbackEarnedForWallet", () => {
  it("adds the cashbackOpening baseline to cashback earned from transactions since", () => {
    const cashbackByWallet = new Map([["w1", 5.5]]);
    expect(cashbackEarnedForWallet({ id: "w1", cashbackOpening: 19.13 }, cashbackByWallet)).toBeCloseTo(24.63, 2);
  });

  it("is just the transaction total when there's no cashbackOpening baseline set", () => {
    const cashbackByWallet = new Map([["w1", 5.5]]);
    expect(cashbackEarnedForWallet({ id: "w1" }, cashbackByWallet)).toBe(5.5);
  });

  it("is just the opening baseline when the wallet has no transactions with cashback yet", () => {
    expect(cashbackEarnedForWallet({ id: "w1", cashbackOpening: 19.13 }, new Map())).toBe(19.13);
  });
});

describe("cashbackCreditTransaction", () => {
  const card = { id: "w1", currency: "MXN" };

  it("builds an income transaction crediting the exact cashback amount back onto the card", () => {
    const credit = cashbackCreditTransaction(10, card, "2026-09-14T12:00:00.000Z");
    expect(credit).toEqual({
      type: "income",
      amount: 10,
      currency: "MXN",
      walletId: "w1",
      note: "Cashback",
      date: "2026-09-14T12:00:00.000Z",
    });
  });

  it("never carries its own cashbackEarned, so totalCashbackByWallet can't double-count it", () => {
    const credit = cashbackCreditTransaction(10, card, "2026-09-14T12:00:00.000Z");
    expect(credit).toBeDefined();
    expect("cashbackEarned" in (credit as object)).toBe(false);
  });

  it("returns undefined when there's nothing to credit (no cashback earned, zero, or a missing wallet id)", () => {
    expect(cashbackCreditTransaction(undefined, card, "2026-09-14")).toBeUndefined();
    expect(cashbackCreditTransaction(0, card, "2026-09-14")).toBeUndefined();
    expect(cashbackCreditTransaction(-5, card, "2026-09-14")).toBeUndefined();
    expect(cashbackCreditTransaction(10, { id: undefined, currency: "MXN" }, "2026-09-14")).toBeUndefined();
  });

  it("a credit transaction never itself earns cashback (type income is excluded by computeCashback)", () => {
    const credit = cashbackCreditTransaction(10, card, "2026-09-14")!;
    expect(computeCashback(credit.type, credit.amount, { kind: "card", cashbackPct: 2 })).toBeUndefined();
  });
});

describe("statementAmount / lastCutDate (statement = debt as of the last cut: a charge ON the cut day starts the next cycle)", () => {
  const now = new Date(2026, 8, 20); // Sep 20, 2026 -> last cut Sep 15
  const card = { id: "w1", corteDay: 15, openingBalance: 0 };
  const e = (y: number, m: number, d: number, amount: number, walletId = "w1") =>
    ({ type: "expense" as const, amount, walletId, currency: "MXN" as const, date: new Date(y, m, d, 12).toISOString() });
  const pay = (y: number, m: number, d: number, amount: number) =>
    ({ type: "transfer" as const, amount, walletId: "w2", toWalletId: "w1", currency: "MXN", date: new Date(y, m, d, 12).toISOString() });

  it("lastCutDate picks the most recent cut on or before now, clamped to short months", () => {
    expect(lastCutDate(15, now).getTime()).toBe(new Date(2026, 8, 15).getTime()); // cut Sep 15
    expect(lastCutDate(31, new Date(2026, 2, 20)).getTime()).toBe(new Date(2026, 1, 28).getTime()); // Mar 20 -> Feb 28
    expect(lastCutDate(31, new Date(2026, 11, 1)).getTime()).toBe(new Date(2026, 10, 30).getTime()); // Dec 1 -> Nov 30
  });

  it("bills ALL debt as of the cut: rolled older debt + cycle charges − payments made before the cut", () => {
    const txs = [
      e(2026, 6, 30, 999), // older cycle — rolled onto this statement too
      e(2026, 7, 15, 100),
      e(2026, 7, 20, 250),
      e(2026, 8, 14, 40), // last day before the cut
      e(2026, 8, 15, 75), // ON the cut day -> next cycle
      e(2026, 8, 18, 30), // after the cut -> next cycle
      pay(2026, 7, 21, 200), // payment before the cut reduces the statement
    ];
    expect(statementAmount(card, txs, now)).toBe(1189);
  });

  it("counts the card's opening debt too (a card created already owing)", () => {
    const owing = { id: "w1", corteDay: 15, openingBalance: -3000 };
    expect(statementAmount(owing, [e(2026, 8, 14, 40)], now)).toBe(3040);
  });

  it("cashback credits (income) before the cut reduce the statement", () => {
    const credit = { type: "income" as const, amount: 5, walletId: "w1", currency: "MXN", date: new Date(2026, 7, 22, 12).toISOString() };
    expect(statementAmount(card, [e(2026, 8, 14, 40), credit], now)).toBe(35);
  });

  it("bills only the card's own activity (another wallet's charge never lands on this statement)", () => {
    const other = e(2026, 7, 21, 80, "w2");
    expect(statementAmount(card, [e(2026, 8, 14, 40), other], now)).toBe(40);
  });

  it("on the cut day itself the new statement is already fixed — today's charge is next cycle", () => {
    const cutMorning = new Date(2026, 8, 15, 10);
    expect(lastCutDate(15, cutMorning).getTime()).toBe(new Date(2026, 8, 15).getTime());
    expect(statementAmount(card, [e(2026, 8, 15, 50)], cutMorning)).toBe(0);
  });

  it("returns undefined without a valid corteDay (payoff falls back to the full owed balance)", () => {
    expect(statementAmount({ id: "w1", corteDay: undefined, openingBalance: 0 }, [e(2026, 7, 20, 250)], now)).toBeUndefined();
    expect(statementAmount({ id: "w1", corteDay: 0, openingBalance: 0 }, [e(2026, 7, 20, 250)], now)).toBeUndefined();
    expect(statementAmount({ id: "w1", corteDay: 32, openingBalance: 0 }, [e(2026, 7, 20, 250)], now)).toBeUndefined();
  });
});

describe("creditsSinceCut (post-cut credits shrink the remaining due; the billed statement never moves)", () => {
  const cutMs = new Date(2026, 8, 15).getTime(); // Sep 15 cut
  const d = (y: number, m: number, day: number) => new Date(y, m, day, 12).toISOString();
  const txs = [
    { type: "transfer" as const, amount: 200, walletId: "w2", toWalletId: "w1", currency: "MXN", date: d(2026, 8, 16) }, // payoff after cut -> counted
    { type: "transfer" as const, amount: 999, walletId: "w2", toWalletId: "w1", currency: "MXN", date: d(2026, 8, 14) }, // before cut -> excluded
    { type: "income" as const, amount: 25, walletId: "w1", currency: "MXN", date: d(2026, 8, 17) }, // cashback payout -> counted
    { type: "income" as const, amount: 10, walletId: "w1", currency: "MXN", date: d(2026, 8, 15) }, // ON the cut day -> counted
    { type: "transfer" as const, amount: 50, walletId: "w1", toWalletId: "w2", currency: "MXN", date: d(2026, 8, 18) }, // paid OUT of the card -> excluded
    { type: "income" as const, amount: 40, walletId: "w2", currency: "MXN", date: d(2026, 8, 18) }, // another wallet's income -> excluded
    { type: "expense" as const, amount: 300, walletId: "w1", currency: "MXN", date: d(2026, 8, 18) }, // charges aren't credits -> excluded
  ];

  it("sums transfers-in and income on/after the cut, nothing else", () => {
    expect(creditsSinceCut("w1", txs, cutMs)).toBe(235);
  });

  it("skips zero and non-finite amounts", () => {
    const bad = [
      { type: "income" as const, amount: 0, walletId: "w1", currency: "MXN", date: d(2026, 8, 18) },
      { type: "income" as const, amount: NaN, walletId: "w1", currency: "MXN", date: d(2026, 8, 18) },
    ];
    expect(creditsSinceCut("w1", bad, cutMs)).toBe(0);
  });

  it("returns 0 when the card got nothing since the cut", () => {
    expect(creditsSinceCut("w1", [], cutMs)).toBe(0);
  });
});
