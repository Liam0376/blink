import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import { makeDb } from "./db";
import { isUuid, newId } from "./sync/ids";

beforeEach(() => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as unknown as Storage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
});

const V2_STORES = {
  wallets: "++id, name, archived, createdAt",
  categories: "++id, kind, parentId",
  transactions: "++id, date, walletId, categoryId, type, createdAt",
  budgets: "++id, period, categoryId",
  debts: "++id, settled, createdAt",
  recurring: "++id, nextDate, active",
};

// v2 shape: auto-increment integer ids
async function seedV2(name: string) {
  const db = new Dexie(name);
  db.version(2).stores(V2_STORES);
  await db.open();
  const wallets = db.table("wallets");
  const categories = db.table("categories");
  const wid = await wallets.add({ name: "Efectivo", kind: "cash", color: "g", currency: "CRC", createdAt: "2026-01-01" });
  const cid = await categories.add({ name: "Comida", icon: "x", color: "r", kind: "expense" });
  await categories.add({ name: "Restaurante", icon: "x", color: "r", kind: "expense", parentId: cid });
  await db.table("transactions").add({ type: "expense", amount: 100, currency: "CRC", walletId: wid, categoryId: cid, date: "2026-01-02", createdAt: "2026-01-02" });
  await db.table("budgets").add({ label: "Total", period: "month", limit: 1000, currency: "CRC", categoryId: null });
  db.close();
}

// Richer v2 seed: a transfer (toWalletId) and a recurring item, so the FK
// remap is exercised on every FK field, not just walletId/categoryId/parentId.
async function seedV2Rich(name: string) {
  const db = new Dexie(name);
  db.version(2).stores(V2_STORES);
  await db.open();
  const wallets = db.table("wallets");
  const wid = await wallets.add({ name: "Efectivo", kind: "cash", color: "g", currency: "CRC", createdAt: "2026-01-01" });
  const wid2 = await wallets.add({ name: "Visa", kind: "card", color: "b", currency: "CRC", createdAt: "2026-01-01" });
  const cid = await db.table("categories").add({ name: "Comida", icon: "x", color: "r", kind: "expense" });
  await db.table("transactions").add({ type: "transfer", amount: 50, currency: "CRC", walletId: wid, toWalletId: wid2, date: "2026-01-03", createdAt: "2026-01-03" });
  await db.table("recurring").add({ label: "Rent", type: "expense", amount: 900, currency: "CRC", walletId: wid, categoryId: cid, nextDate: "2026-02-01", frequency: "monthly" });
  db.close();
}

describe("v3 upgrade", () => {
  it("keeps every foreign key resolving to the same logical row", async () => {
    await seedV2("mig-a");
    const db = makeDb("mig-a");
    await db.open();

    const wallets = await db.wallets.toArray();
    const cats = await db.categories.toArray();
    const tx = (await db.transactions.toArray())[0];
    const comida = cats.find((c) => c.name === "Comida")!;
    const restaurante = cats.find((c) => c.name === "Restaurante")!;

    expect(typeof wallets[0].id).toBe("string");
    expect(wallets[0].id).not.toBe("1");
    expect(restaurante.parentId).toBe(comida.id);
    expect(tx.walletId).toBe(wallets[0].id);
    expect(tx.categoryId).toBe(comida.id);
    db.close();
  });

  it("leaves a null budget category null and clears the stale id keys", async () => {
    localStorage.setItem("blink:lastWallet", "1");
    localStorage.setItem("blink:lastCategory", "7");
    await seedV2("mig-b");
    const db = makeDb("mig-b");
    await db.open();

    expect((await db.budgets.toArray())[0].categoryId).toBeNull();
    expect(localStorage.getItem("blink:lastWallet")).toBeNull();
    expect(localStorage.getItem("blink:lastCategory")).toBeNull();
    db.close();
  });

  it("re-keys transfers and recurring items, keeping every FK resolving", async () => {
    await seedV2Rich("mig-d");
    const db = makeDb("mig-d");
    await db.open();

    const wallets = await db.wallets.toArray();
    const cats = await db.categories.toArray();
    const txs = await db.transactions.toArray();
    const rec = (await db.recurring.toArray())[0];
    const wById = new Map(wallets.map((w) => [w.id, w]));
    const cById = new Map(cats.map((c) => [c.id, c]));

    const efectivo = wallets.find((w) => w.name === "Efectivo")!;
    const visa = wallets.find((w) => w.name === "Visa")!;
    const comida = cats.find((c) => c.name === "Comida")!;
    const transfer = txs.find((t) => t.type === "transfer")!;
    expect(transfer.walletId).toBe(efectivo.id);
    expect(transfer.toWalletId).toBe(visa.id);
    expect(wById.get(transfer.toWalletId!)).toBeDefined();
    expect(rec.walletId).toBe(efectivo.id);
    expect(rec.categoryId).toBe(comida.id);
    expect(cById.get(rec.categoryId!)).toBeDefined();
    db.close();
  });

  it("fresh install creates only the final stores and accepts string ids", async () => {
    const db = makeDb("mig-c");
    await db.open();

    expect(db.tables.map((t) => t.name).sort()).toEqual(
      ["wallets", "categories", "transactions", "budgets", "debts", "recurring"].sort()
    );
    const id = await db.wallets.add({ id: newId(), name: "Efectivo", kind: "cash", color: "g", currency: "CRC", createdAt: "2026-01-01" });
    expect(isUuid(id)).toBe(true);
    expect(await db.wallets.count()).toBe(1);
    db.close();
  });
});
