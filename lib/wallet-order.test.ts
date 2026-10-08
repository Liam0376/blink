// Imported for its side effect: importing ./db builds the Dexie instance, which
// needs an indexedDB global. Must come first.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { moveWalletOrder, sortWallets, type Wallet } from "./db";

function w(id: string, sortOrder?: number): Wallet {
  return {
    id,
    name: id,
    kind: "cash",
    color: "#000",
    currency: "USD",
    createdAt: "2026-01-01",
    ...(sortOrder !== undefined ? { sortOrder } : {}),
  };
}

/** Apply the writes to a list, then read the resulting display order. */
function apply(list: Wallet[], writes: Array<{ id: string; sortOrder: number }>): string[] {
  const byId = new Map(writes.map((x) => [x.id, x.sortOrder]));
  return sortWallets(list.map((x) => (byId.has(x.id!) ? { ...x, sortOrder: byId.get(x.id!) } : x)))
    .map((x) => x.id!);
}

describe("sortWallets", () => {
  it("keeps the order it was given when nothing has a position", () => {
    // Every wallet before the first reorder, and every brand-new one.
    expect(sortWallets([w("c"), w("a"), w("b")]).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("puts positioned wallets first, and the never-moved ones after them", () => {
    // A new card should land at the bottom, not shove its way to the top.
    const list = [w("new"), w("second", 1), w("first", 0)];
    expect(sortWallets(list).map((x) => x.id)).toEqual(["first", "second", "new"]);
  });

  it("keeps never-moved wallets in their relative order", () => {
    const list = [w("a"), w("first", 0), w("b"), w("c")];
    expect(sortWallets(list).map((x) => x.id)).toEqual(["first", "a", "b", "c"]);
  });

  it("handles the empty list and does not mutate its input", () => {
    expect(sortWallets([])).toEqual([]);
    const list = [w("b", 1), w("a", 0)];
    sortWallets(list);
    expect(list.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("moveWalletOrder", () => {
  it("materialises a position for every wallet on the first move", () => {
    // Otherwise the two that were never moved would be left without one and
    // jump to the end as soon as their neighbour was picked up.
    const list = [w("a"), w("b"), w("c")];
    expect(moveWalletOrder(list, "b", 1)).toEqual([
      { id: "a", sortOrder: 0 },
      { id: "b", sortOrder: 2 },
      { id: "c", sortOrder: 1 },
    ]);
    expect(apply(list, moveWalletOrder(list, "b", 1))).toEqual(["a", "c", "b"]);
  });

  it("writes only the two wallets that swap once positions exist", () => {
    const list = [w("a", 0), w("c", 1), w("b", 2)];
    const writes = moveWalletOrder(list, "c", -1);
    expect(writes).toHaveLength(2);
    expect(apply(list, writes)).toEqual(["c", "a", "b"]);
  });

  it("refuses to move past either end", () => {
    const list = [w("a", 0), w("b", 1)];
    expect(moveWalletOrder(list, "a", -1)).toEqual([]);
    expect(moveWalletOrder(list, "b", 1)).toEqual([]);
  });

  it("returns nothing for a wallet that is not in the list", () => {
    expect(moveWalletOrder([w("a", 0)], "gone", 1)).toEqual([]);
  });

  it("walks a wallet to the far end one slot at a time", () => {
    let list = [w("a"), w("b"), w("c")];
    for (let step = 0; step < 2; step++) {
      list = list.map((x) => {
        const hit = moveWalletOrder(list, "a", 1).find((y) => y.id === x.id);
        return hit ? { ...x, sortOrder: hit.sortOrder } : x;
      });
    }
    expect(sortWallets(list).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});
