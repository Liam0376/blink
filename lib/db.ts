import Dexie, { type Table } from "dexie";
import { upgradeV3, upgradeV4 } from "./migrate-v3";

/** ISO 4217 code. Free-form string (user-extensible): validated as
 * /^[A-Z]{3}$/ at intake points, never as a closed union — Dexie stores
 * it opaquely so no schema/version change is needed. */
export type Currency = string;

export interface Wallet {
  id?: string;
  name: string;
  kind: "cash" | "card" | "bank" | "other";
  last4?: string;
  color: string;
  currency: Currency;
  archived?: boolean;
  /** Balance at install / account opening — ledger adds on top. */
  openingBalance?: number;
  openingDate?: string;
  /** Annual interest rate (e.g. 13 for 13%/yr). Display-only projection —
   * see growBalance in balances.ts — never written as real transactions. */
  roiAnnualPct?: number;
  /** ISO datetime the CURRENT roiAnnualPct took effect. Set whenever the rate
   * is first set or changed to a different value — never backfilled from an
   * old rate change. Growth (see computeGrownBalances) anchors to whichever
   * is more recent, this or the last real transaction, so a rate change
   * never retroactively re-prices days already displayed under the old
   * rate. */
  roiRateSince?: string;
  /** True once the user has answered the "does this earn interest?" prompt
   * (yes or no) — stops the RoiPrompt banner from re-asking every visit. */
  roiAsked?: boolean;
  /** Card statement due day (1-31) — fecha límite de pago. Informational
   * (shown on the wallet). Usually set alongside corteDay; the payoff
   * itself is offered whenever the card carries a balance owed. */
  dueDay?: number;
  /** Card statement cut day (1-31) — fecha de corte. A charge logged ON
   * this day belongs to the NEXT cycle, and each cycle's billed amount is
   * computed by statementAmount in balances.ts (display only — the real
   * statement always comes from the bank). */
  corteDay?: number;
  /** True once the user has answered the "when does the statement cut?"
   * prompt (set it or decline) — stops the CortePrompt from re-asking. */
  corteAsked?: boolean;
  /** Cashback rate (e.g. 2 for 2%), card wallets only. Applied per-expense
   * at the moment it's logged (see computeCashback in balances.ts) and
   * snapshotted onto Transaction.cashbackEarned — never recomputed live
   * from this field, so changing the rate later never rewrites cashback
   * already earned on past purchases. */
  cashbackPct?: number;
  /** True once the user has answered the "does this card give cashback?"
   * prompt (yes or no) — stops the CashbackPrompt banner from re-asking. */
  cashbackAsked?: boolean;
  /** Cashback already earned on this card before Blink started tracking it
   * (e.g. read off a real statement) — the starting point for the running
   * total, same role as Wallet.openingBalance for the ledger. Always added
   * to the transaction-derived total for display. The user can additionally
   * choose, once, to post it as a real income transaction that credits it
   * onto the card (see cashbackOpeningApplied) — until then it's display
   * only, exactly like ROI's projection. */
  cashbackOpening?: number;
  /** True once cashbackOpening has been posted as a real transaction
   * (see the "Apply to balance" action). Gates that action to run exactly
   * once — without it, re-applying would credit the same starting balance
   * to the card more than once. */
  cashbackOpeningApplied?: boolean;
  createdAt: string;
}

export interface Category {
  id?: string;
  name: string;
  icon: string;
  color: string;
  kind: "expense" | "income";
  parentId?: string;
}

export type TxType = "expense" | "income" | "transfer";

export interface Transaction {
  id?: string;
  type: TxType;
  amount: number;
  currency: Currency;
  walletId: string;
  toWalletId?: string;
  categoryId?: string;
  note?: string;
  /** ISO datetime */
  date: string;
  /** dataURL receipt photo (optional, local only) */
  image?: string;
  /** Cashback earned by this specific expense, frozen at creation time from
   * the source wallet's cashbackPct as it stood then (see computeCashback in
   * balances.ts). undefined for non-expenses, non-card wallets, cards
   * without cashback, and rows imported via CSV (historical rate unknown).
   * Never recomputed later — a rate change only affects future purchases. */
  cashbackEarned?: number;
  createdAt: string;
}

export interface Budget {
  id?: string;
  label: string;
  period: "week" | "month" | "year";
  limit: number;
  currency: Currency;
  /** null = total spending */
  categoryId?: string | null;
}

export interface Debt {
  id?: string;
  person: string;
  amount: number;
  currency: Currency;
  /** "owed" = me deben, "owe" = yo debo */
  direction: "owed" | "owe";
  note?: string;
  settled?: boolean;
  createdAt: string;
}

export interface Recurring {
  id?: string;
  label: string;
  type: "expense" | "income";
  amount: number;
  currency: Currency;
  walletId: string;
  categoryId?: string;
  /** ISO date of next occurrence */
  nextDate: string;
  frequency: "weekly" | "monthly" | "yearly";
  active?: boolean;
  /** Day-of-month (1-31) this recurrence was created on. Monthly advancement
   * targets this day every time (clamped to short months) instead of the
   * previous occurrence's already-clamped day, so a Jan-31 recurring lands
   * on Feb 28 then bounces back to Mar 31 — not drifting to Mar 28.
   * Optional/undefined for rows created before this field existed. */
  anchorDay?: number;
  /** ISO date (YYYY-MM-DD) of the last allowed occurrence. Optional/undefined
   * means "repeats forever" (rows created before this field existed).
   * Plain (unindexed) prop like anchorDay — no Dexie version bump needed. */
  endDate?: string;
}

class FinanceDB extends Dexie {
  wallets!: Table<Wallet, string>;
  categories!: Table<Category, string>;
  transactions!: Table<Transaction, string>;
  budgets!: Table<Budget, string>;
  debts!: Table<Debt, string>;
  recurring!: Table<Recurring, string>;

  constructor(name: string) {
    super(name);
    // v1/v2: legacy auto-increment integer ids. Existing databases only run
    // upgrades above their stored version; these blocks stay byte-identical
    // so their schema hash cannot shift under an installed database.
    this.version(1).stores({
      wallets: "++id, name, archived, createdAt",
      categories: "++id, kind, parentId",
      transactions: "++id, date, walletId, categoryId, type, createdAt",
      budgets: "++id, period, categoryId",
      debts: "++id, settled, createdAt",
      recurring: "++id, nextDate, active",
    });
    // v2: openingBalance/openingDate are plain (unindexed) props — no migration needed.
    this.version(2).stores({
      wallets: "++id, name, archived, createdAt",
      categories: "++id, kind, parentId",
      transactions: "++id, date, walletId, categoryId, type, createdAt",
      budgets: "++id, period, categoryId",
      debts: "++id, settled, createdAt",
      recurring: "++id, nextDate, active",
    });
    // v3/v4: re-key to UUID strings. Dexie cannot change a store's primary
    // key in place ("Not yet support for changing primary key"), so the
    // re-key spans two versions: v3 moves legacy rows into temp tables with
    // UUID ids (and clears the stale last-used-id memory), v4 moves them
    // into the final stores and drops the temps. Fresh installs run the
    // same chain and end at the same final schema.
    this.version(3).stores({
      wallets: null,
      categories: null,
      transactions: null,
      budgets: null,
      debts: null,
      recurring: null,
      wallets_v3: "id, name, archived, createdAt",
      categories_v3: "id, kind, parentId",
      transactions_v3: "id, date, walletId, categoryId, type, createdAt",
      budgets_v3: "id, period, categoryId",
      debts_v3: "id, settled, createdAt",
      recurring_v3: "id, nextDate, active",
    }).upgrade((tx) => upgradeV3(tx));
    this.version(4).stores({
      wallets: "id, name, archived, createdAt",
      categories: "id, kind, parentId",
      transactions: "id, date, walletId, categoryId, type, createdAt",
      budgets: "id, period, categoryId",
      debts: "id, settled, createdAt",
      recurring: "id, nextDate, active",
      wallets_v3: null,
      categories_v3: null,
      transactions_v3: null,
      budgets_v3: null,
      debts_v3: null,
      recurring_v3: null,
    }).upgrade((tx) => upgradeV4(tx));
  }
}

export function makeDb(name: string): FinanceDB {
  return new FinanceDB(name);
}

export const db = makeDb("blink");
