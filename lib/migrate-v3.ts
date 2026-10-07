import type { Transaction as DexieTransaction } from "dexie";
import { remapIds } from "./sync/ids";

const TABLES = ["wallets", "categories", "transactions", "budgets", "debts", "recurring"] as const;
type MigTable = (typeof TABLES)[number];
const temp = (t: MigTable) => `${t}_v3`;

const STALE_ID_KEYS = ["blink:lastWallet", "blink:lastCategory"];

/**
 * v3: move legacy auto-increment rows into temp tables with UUID ids.
 * Dexie cannot change a store's primary key in place, so the re-key spans
 * v3 (old → temp) and v4 (temp → final). Runs inside Dexie's upgrade
 * transaction — a throw rolls the whole version back.
 */
export async function upgradeV3(tx: DexieTransaction): Promise<void> {
  const books = {
    wallets: await tx.table("wallets").toArray(),
    categories: await tx.table("categories").toArray(),
    transactions: await tx.table("transactions").toArray(),
    budgets: await tx.table("budgets").toArray(),
    debts: await tx.table("debts").toArray(),
    recurring: await tx.table("recurring").toArray(),
  };
  const { books: rekeyed } = remapIds(books);
  for (const t of TABLES) {
    await tx.table(temp(t)).bulkAdd(rekeyed[t] as never[]);
  }
  // The last-used wallet/category memory holds legacy integer ids; clear it
  // so QuickAdd doesn't pre-select a row that no longer exists.
  for (const k of STALE_ID_KEYS) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* non-fatal */
    }
  }
}

/** v4: move the re-keyed rows from the temp tables into the final stores. */
export async function upgradeV4(tx: DexieTransaction): Promise<void> {
  for (const t of TABLES) {
    const rows = await tx.table(temp(t)).toArray();
    await tx.table(t).bulkAdd(rows);
  }
}
