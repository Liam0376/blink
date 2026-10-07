import { describe, expect, it } from "vitest";
import { auditBooks, type BooksData } from "./audit";
import type { Category, Transaction, Wallet } from "./db";

const wCRC: Wallet = { id: "w1", name: "Efectivo", kind: "cash", color: "green", currency: "CRC", createdAt: "2026-01-01" };
const wUSD: Wallet = { id: "w2", name: "Ahorros", kind: "bank", color: "blue", currency: "USD", createdAt: "2026-01-01" };
const wCRC2: Wallet = { id: "w3", name: "Caja", kind: "cash", color: "red", currency: "CRC", createdAt: "2026-01-01" };
const food: Category = { id: "c7", name: "Comida", icon: "🍔", color: "red", kind: "expense" };
const sup: Category = { id: "c8", name: "Súper", icon: "🛒", color: "red", kind: "expense", parentId: "c7" };

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    type: "expense",
    amount: 1000,
    currency: "CRC",
    walletId: "w1",
    categoryId: "c7",
    date: "2026-09-01T12:00:00",
    createdAt: "2026-09-01T12:00:00",
    ...over,
  };
}

function clean(): BooksData {
  return {
    wallets: [wCRC, wUSD, wCRC2],
    categories: [food, sup],
    transactions: [
      tx(),
      tx({ type: "income", walletId: "w2", currency: "USD" }),
      tx({ type: "transfer", categoryId: undefined, toWalletId: "w3" }),
    ],
    budgets: [
      { id: "b1", label: "Comida", period: "month", limit: 100000, currency: "CRC", categoryId: "c7" },
      { id: "b2", label: "Total", period: "month", limit: 500000, currency: "CRC", categoryId: null },
    ],
    debts: [{ id: "d1", person: "Ana", amount: 20, currency: "USD", direction: "owed", createdAt: "2026-09-01" }],
    recurring: [
      { id: "r1", label: "Alquiler", type: "expense", amount: 100, currency: "CRC", walletId: "w1", categoryId: "c7", nextDate: "2026-10-01", frequency: "monthly" },
    ],
  };
}

describe("auditBooks", () => {
  it("returns [] for a clean dataset (and for fully empty tables)", () => {
    expect(auditBooks(clean())).toEqual([]);
    expect(auditBooks({ wallets: [], categories: [], transactions: [], budgets: [], debts: [], recurring: [] })).toEqual([]);
  });

  it("groups currency mismatches into one error with the row count", () => {
    const d = clean();
    d.transactions.push(tx({ currency: "USD" }), tx({ currency: "USD", amount: 5 }));
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", count: 2 });
    expect(issues[0].message).toMatch(/currency/i);
  });

  it("flags transactions pointing at a missing wallet as one error", () => {
    const d = clean();
    d.transactions.push(tx({ walletId: "w999" }));
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", count: 1 });
    expect(issues[0].message).toMatch(/missing wallet/i);
  });

  it("flags transactions pointing at a missing category as one warning", () => {
    const d = clean();
    d.transactions.push(tx({ categoryId: "c999" }));
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", count: 1 });
    expect(issues[0].message).toMatch(/missing category/i);
  });

  it("flags a transfer without destination as one error", () => {
    const d = clean();
    d.transactions.push(tx({ type: "transfer", categoryId: undefined, toWalletId: undefined }));
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", count: 1 });
    expect(issues[0].message).toMatch(/transfer/i);
  });

  it("flags a transfer across currencies as one error", () => {
    const d = clean();
    // CRC wallet -> USD wallet: violates the same-currency transfer rule.
    d.transactions.push(tx({ type: "transfer", categoryId: undefined, toWalletId: "w2" }));
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", count: 1 });
  });

  it("flags a transfer to a missing wallet as one error", () => {
    const d = clean();
    d.transactions.push(tx({ type: "transfer", categoryId: undefined, toWalletId: "w999" }));
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", count: 1 });
  });

  it("flags budgets pointing at a missing category as one warning", () => {
    const d = clean();
    d.budgets.push({ id: "b3", label: "Rota", period: "month", limit: 10, currency: "CRC", categoryId: "c999" });
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", count: 1 });
    expect(issues[0].message).toMatch(/budget/i);
  });

  it("flags recurring items pointing at a missing wallet as one error", () => {
    const d = clean();
    d.recurring.push({ id: "r2", label: "Roto", type: "expense", amount: 5, currency: "CRC", walletId: "w999", nextDate: "2026-10-01", frequency: "monthly" });
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", count: 1 });
    expect(issues[0].message).toMatch(/recurring/i);
  });

  it("catches missing parents, self-parents, and cycles in one warning without hanging", () => {
    const d = clean();
    d.categories.push(
      { id: "c10", name: "Huérfana", icon: "•", color: "x", kind: "expense", parentId: "c999" },
      { id: "c11", name: "Auto", icon: "•", color: "x", kind: "expense", parentId: "c11" },
      { id: "c12", name: "CicloA", icon: "•", color: "x", kind: "expense", parentId: "c13" },
      { id: "c13", name: "CicloB", icon: "•", color: "x", kind: "expense", parentId: "c12" },
    );
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", count: 4 });
    expect(issues[0].message).toMatch(/categor/i);
  });

  it("reports several corruption types at once, one grouped issue each", () => {
    const d = clean();
    d.transactions.push(tx({ currency: "USD" }), tx({ categoryId: "c999" }));
    const issues = auditBooks(d);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.count)).toEqual([1, 1]);
  });

  it("flags recurring items with an end date before their next occurrence as one warning", () => {
    const d = clean();
    // Create a recurring that ended before its first occurrence could happen.
    d.recurring.push({
      id: "r2",
      label: "Dead",
      type: "expense",
      amount: 50,
      currency: "CRC",
      walletId: "w1",
      nextDate: "2026-10-15",
      endDate: "2026-10-10",
      frequency: "monthly",
    });
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", count: 1 });
    expect(issues[0].message).toMatch(/end date/i);
  });

  it("does not flag a recurring with a valid future end date (after next occurrence)", () => {
    const d = clean();
    // Recurring with endDate after nextDate: valid, not flagged.
    d.recurring.push({
      id: "r2",
      label: "Future",
      type: "expense",
      amount: 50,
      currency: "CRC",
      walletId: "w1",
      nextDate: "2026-10-01",
      endDate: "2026-10-31",
      frequency: "monthly",
    });
    const issues = auditBooks(d);
    expect(issues).toEqual([]);
  });

  it("does not flag a recurring without an end date (the common case)", () => {
    const d = clean();
    // Recurring with no endDate: valid, not flagged.
    d.recurring.push({
      id: "r2",
      label: "Forever",
      type: "income",
      amount: 100,
      currency: "CRC",
      walletId: "w1",
      nextDate: "2026-10-01",
      frequency: "yearly",
    });
    const issues = auditBooks(d);
    expect(issues).toEqual([]);
  });

  it("counts a non-string endDate as bad instead of throwing", () => {
    const d = clean();
    d.recurring.push({
      id: "r2",
      label: "Corrupt",
      type: "expense",
      amount: 50,
      currency: "CRC",
      walletId: "w1",
      nextDate: "2026-10-01",
      frequency: "monthly",
      endDate: 12345 as unknown as string,
    });
    const issues = auditBooks(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", count: 1 });
    expect(issues[0].message).toMatch(/end date/i);
  });
});
