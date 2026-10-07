import { describe, expect, it } from "vitest";
import { isUuid, newId, remapIds } from "./ids";

const books = () => ({
  wallets: [{ id: 1, name: "Efectivo", kind: "cash" as const, color: "green", currency: "CRC", createdAt: "2026-01-01" }],
  categories: [
    { id: 7, name: "Comida", icon: "x", color: "red", kind: "expense" as const },
    { id: 8, name: "Restaurante", icon: "x", color: "red", kind: "expense" as const, parentId: 7 },
  ],
  transactions: [
    { id: 11, type: "expense" as const, amount: 100, currency: "CRC", walletId: 1, categoryId: 8, date: "2026-01-02", createdAt: "2026-01-02", image: "data:image/jpeg;base64,AAAA" },
  ],
  budgets: [
    { id: 3, label: "Total", period: "month" as const, limit: 1000, currency: "CRC", categoryId: null },
    { id: 4, label: "Food", period: "month" as const, limit: 500, currency: "CRC", categoryId: 7 },
  ],
  debts: [{ id: 1, person: "Ana", amount: 50, currency: "CRC", direction: "owe" as const, createdAt: "2026-01-01" }],
  recurring: [],
});

describe("remapIds", () => {
  it("keeps every foreign key pointing at the same logical row", () => {
    const { books: out } = remapIds(books());
    const catById = new Map(out.categories.map((c) => [c.id, c]));
    const walById = new Map(out.wallets.map((w) => [w.id, w]));

    expect(out.categories.find((c) => c.name === "Restaurante")!.parentId)
      .toBe(out.categories.find((c) => c.name === "Comida")!.id);
    expect(catById.get(out.transactions[0].categoryId!)!.name).toBe("Restaurante");
    expect(walById.get(out.transactions[0].walletId)!.name).toBe("Efectivo");
    expect(out.budgets[1].categoryId).toBe(out.categories.find((c) => c.name === "Comida")!.id);
  });

  it("leaves a null budget category null", () => {
    expect(remapIds(books()).books.budgets[0].categoryId).toBeNull();
  });

  it("does not collide ids across tables", () => {
    const out = remapIds(books()).books;
    expect(out.wallets[0].id).not.toBe(out.debts[0].id);
  });

  it("preserves ids that are already uuids, so it is idempotent", () => {
    const once = remapIds(books()).books;
    const twice = remapIds(once).books;
    expect(twice.transactions[0].id).toBe(once.transactions[0].id);
    expect(twice.transactions[0].categoryId).toBe(once.transactions[0].categoryId);
  });

  it("leaves an orphan foreign key alone rather than inventing a target", () => {
    const b = books();
    b.transactions[0].categoryId = 999;
    expect(remapIds(b).books.transactions[0].categoryId).toBe(999);
  });

  it("follows foreign keys when the ids are non-UUID strings", () => {
    // Legacy data is not always numeric: an import can carry string ids that
    // are not UUIDs yet. Those rows get re-keyed, so their FKs must follow.
    const b = books();
    const { books: out } = remapIds(b);
    const comida = out.categories.find((c) => c.name === "Comida")!;
    const restaurante = out.categories.find((c) => c.name === "Restaurante")!;
    expect(restaurante.parentId).toBe(comida.id);
    expect(out.transactions[0].walletId).toBe(out.wallets[0].id);
    expect(out.transactions[0].categoryId).toBe(
      out.categories.find((c) => c.name === "Restaurante")!.id,
    );
    expect(out.budgets[1].categoryId).toBe(comida.id);
  });

  it("keeps the receipt image untouched", () => {
    expect(remapIds(books()).books.transactions[0].image).toBe("data:image/jpeg;base64,AAAA");
  });
});

describe("newId / isUuid", () => {
  it("produces a v4 uuid", () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isUuid(newId())).toBe(true);
  });

  it("rejects numbers and non-uuid strings", () => {
    expect(isUuid(1)).toBe(false);
    expect(isUuid("7")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
