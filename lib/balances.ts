import { roundCents } from "./format";
import type { Currency, Transaction, TxType, Wallet } from "./db";

/**
 * Pure balance math — extracted verbatim from the `balanceByWallet` useMemo
 * in app/page.tsx so it is unit-testable.
 *
 * Semantics (preserved exactly): each wallet is seeded with its
 * openingBalance (default 0); expenses subtract, income adds, transfers
 * debit the source and credit the destination with the same raw amount
 * (same-currency by construction, no FX). roundCents is applied per
 * operation to prevent floating-point drift.
 */
export function computeBalances(
  wallets: Pick<Wallet, "id" | "openingBalance">[],
  // `currency` is accepted (real Transaction rows carry it) but ignored:
  // balances are per-wallet and transfers move the raw amount (no FX).
  transactions: Pick<Transaction, "type" | "amount" | "currency" | "walletId" | "toWalletId">[]
): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of wallets) m.set(w.id!, w.openingBalance ?? 0);
  for (const t of transactions) {
    if (!Number.isFinite(t.amount) || t.amount === 0) continue;
    if (t.type === "expense") m.set(t.walletId, roundCents((m.get(t.walletId) ?? 0) - t.amount));
    else if (t.type === "income") m.set(t.walletId, roundCents((m.get(t.walletId) ?? 0) + t.amount));
    else {
      m.set(t.walletId, roundCents((m.get(t.walletId) ?? 0) - t.amount));
      if (t.toWalletId != null) m.set(t.toWalletId, roundCents((m.get(t.toWalletId) ?? 0) + t.amount));
    }
  }
  return m;
}

/**
 * Net worth grouped by currency, excluding archived wallets, from an
 * already-computed balances map (e.g. one with ROI growth applied via
 * computeGrownBalances). No FX: currencies stay separate, sorted by |total|
 * desc. Negative balances (overdrawn accounts) contribute as negative.
 */
export function netWorthFromBalances(
  wallets: Pick<Wallet, "id" | "archived" | "currency">[],
  balances: Map<string, number>
): Array<{ currency: Currency; total: number }> {
  const activeWallets = wallets.filter((w) => !w.archived);
  const m = new Map<Currency, number>();
  for (const w of activeWallets) {
    const balance = balances.get(w.id!) ?? 0;
    const curr = m.get(w.currency) ?? 0;
    m.set(w.currency, roundCents(curr + balance));
  }
  return [...m.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365;

/** Local calendar day (midnight in the runtime's own timezone) a Date falls
 * on, as a timestamp. Local, not UTC: a user west of UTC (e.g. Mexico,
 * UTC-6) has their local midnight hours AFTER UTC midnight already ticked
 * over, so stepping on UTC days made the projection advance a full day
 * while it was still "today" on the user's clock — days must be counted the
 * way the user perceives them, in their own timezone. */
function localDayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Compound-grow a balance by an annual rate from `since` to `now`. Display-
 * only projection (see Wallet.roiAnnualPct) — never persisted as a
 * transaction. Steps once per whole LOCAL calendar day that has elapsed
 * since `since` — never mid-day, so it never shows a "live" number ticking
 * up before a full day has actually passed on the user's own clock. Zero/
 * negative elapsed days or a non-positive rate returns the balance
 * unchanged (no growth on debt-shaped balances by accident).
 */
export function growBalance(balance: number, roiAnnualPct: number | undefined, since: Date, now: Date): number {
  if (!roiAnnualPct || roiAnnualPct <= 0 || balance <= 0) return balance;
  const days = (localDayStart(now) - localDayStart(since)) / MS_PER_DAY;
  if (days <= 0) return balance;
  const years = days / DAYS_PER_YEAR;
  return roundCents(balance * Math.pow(1 + roiAnnualPct / 100, years));
}

/**
 * Apply ROI growth (see growBalance) on top of ledger balances, for every
 * wallet that has roiAnnualPct set. Wallets without it pass through
 * unchanged. `now` is injectable for tests.
 *
 * Interest accrues one day at a time on the balance actually held that day,
 * the way a bank credits it. An earlier version anchored the whole
 * projection to the newest transaction on the wallet, so logging a coffee
 * reset the clock and a year of accrued interest vanished.
 *
 * The daily factor is the 365th root of the annual one, so a balance left
 * untouched for a year still grows by exactly the annual rate.
 *
 * The ledger is unwound from the current balance to find what was there at
 * the start of the window, which keeps this function's answer consistent
 * with the balances map it is handed.
 */
export function computeGrownBalances(
  wallets: Pick<Wallet, "id" | "roiAnnualPct" | "roiRateSince" | "openingDate" | "createdAt">[],
  balances: Map<string, number>,
  transactions: Pick<Transaction, "type" | "amount" | "walletId" | "toWalletId" | "date">[],
  now: Date = new Date()
): Map<string, number> {
  const grown = new Map(balances);
  const today = localDayStart(now);

  for (const w of wallets) {
    if (!w.roiAnnualPct || w.roiAnnualPct <= 0 || w.id == null) continue;

    // Growth never starts before the rate did, so a rate change stays
    // prospective: days already elapsed under the old rate are not re-priced.
    let start = new Date(w.openingDate || w.createdAt);
    if (w.roiRateSince) {
      const rateSince = new Date(w.roiRateSince);
      if (!Number.isNaN(rateSince.getTime()) && rateSince > start) start = rateSince;
    }
    const startDay = localDayStart(start);
    if (Number.isNaN(startDay) || today <= startDay) continue;

    // Signed movement per local day, for this wallet only.
    const byDay = new Map<number, number>();
    for (const t of transactions) {
      if (!Number.isFinite(t.amount) || t.amount === 0) continue;
      let delta = 0;
      if (t.type === "expense") {
        if (t.walletId === w.id) delta -= t.amount;
      } else if (t.type === "income") {
        if (t.walletId === w.id) delta += t.amount;
      } else {
        if (t.walletId === w.id) delta -= t.amount;
        if (t.toWalletId === w.id) delta += t.amount;
      }
      if (delta === 0) continue;
      const day = localDayStart(new Date(t.date));
      if (Number.isNaN(day)) continue;
      byDay.set(day, (byDay.get(day) ?? 0) + delta);
    }

    // Unwind to the opening balance for the start of the window.
    let balance = balances.get(w.id) ?? 0;
    for (const [day, delta] of byDay) if (day >= startDay) balance -= delta;

    const dailyFactor = Math.pow(1 + w.roiAnnualPct / 100, 1 / DAYS_PER_YEAR);
    const cursor = new Date(startDay);
    while (localDayStart(cursor) < today) {
      balance += byDay.get(localDayStart(cursor)) ?? 0;
      if (balance > 0) balance *= dailyFactor;
      cursor.setDate(cursor.getDate() + 1);
    }
    // Today's movements are real but have not earned a day yet.
    balance += byDay.get(today) ?? 0;

    grown.set(w.id, roundCents(balance));
  }
  return grown;
}

/**
 * Cashback earned by a single expense, to snapshot onto
 * Transaction.cashbackEarned at creation time. Only real card purchases
 * earn cashback: income and transfers never do (a transfer just moves money
 * that already exists, it isn't a purchase), and only wallets of kind
 * "card" with a positive cashbackPct qualify. The caller must call this
 * ONCE, when the transaction is created, and persist the result — never
 * recompute it later from the wallet's current cashbackPct, or a rate
 * change would rewrite cashback already earned on past purchases (the same
 * class of bug fixed for ROI via roiRateSince).
 */
export function computeCashback(
  type: TxType,
  amount: number,
  wallet: Pick<Wallet, "kind" | "cashbackPct">
): number | undefined {
  if (type !== "expense") return undefined;
  if (wallet.kind !== "card") return undefined;
  if (!wallet.cashbackPct || wallet.cashbackPct <= 0) return undefined;
  return roundCents(amount * (wallet.cashbackPct / 100));
}

/** Sum of Transaction.cashbackEarned per wallet, for a "cashback earned so
 * far" display. Rows without cashbackEarned (income, transfers, cards
 * without cashback, CSV-imported history) simply don't contribute. */
export function totalCashbackByWallet(
  transactions: Pick<Transaction, "walletId" | "cashbackEarned">[]
): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of transactions) {
    if (!t.cashbackEarned) continue;
    m.set(t.walletId, roundCents((m.get(t.walletId) ?? 0) + t.cashbackEarned));
  }
  return m;
}

/** Total cashback to display for one wallet: its cashbackOpening baseline
 * (cashback earned before Blink started tracking it, e.g. read off a real
 * statement) plus everything computed from its transactions since. */
export function cashbackEarnedForWallet(
  wallet: Pick<Wallet, "id" | "cashbackOpening">,
  cashbackByWallet: Map<string, number>
): number {
  const opening = wallet.cashbackOpening ?? 0;
  const fromTransactions = wallet.id != null ? cashbackByWallet.get(wallet.id) ?? 0 : 0;
  return roundCents(opening + fromTransactions);
}

/**
 * Fields for a real income transaction that immediately credits cashback
 * earned on a purchase back onto the same card — the user chose to have
 * cashback actually reduce card debt, not just sit in a display total.
 * Deliberately carries no `cashbackEarned` of its own: that field is how
 * totalCashbackByWallet tallies "earned so far", and this credit's amount
 * is already counted there via the ORIGINAL expense's cashbackEarned — a
 * cashbackEarned on this row too would double it. Returns undefined when
 * there's nothing to credit (expense earned no cashback), so callers can
 * skip posting a $0 transaction.
 */
export function cashbackCreditTransaction(
  cashbackEarned: number | undefined,
  wallet: Pick<Wallet, "id" | "currency">,
  dateIso: string
): Pick<Transaction, "type" | "amount" | "currency" | "walletId" | "note" | "date"> | undefined {
  if (!cashbackEarned || cashbackEarned <= 0 || wallet.id == null) return undefined;
  return {
    type: "income",
    amount: cashbackEarned,
    currency: wallet.currency,
    walletId: wallet.id,
    note: "Cashback",
    date: dateIso,
  };
}

/** Local midnight on day `day` of month `m` (0-based), clamped to the
 * month's length — a cut day of 31 lands on Feb 28, the same clamp idea
 * as Recurring.anchorDay. Month/year roll over via Date normalization
 * (m = -1 is December of the previous year). */
function dateWithDay(y: number, m: number, day: number): Date {
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last));
}

/** Midnight of the most recent statement cut for a card with cut day
 * `corteDay`: the latest such date (clamped to short months) on or before
 * `now`. On the cut day itself the statement has already been fixed —
 * charges logged from that day on fall in the NEXT cycle. */
export function lastCutDate(corteDay: number, now: Date): Date {
  const thisCut = dateWithDay(now.getFullYear(), now.getMonth(), corteDay);
  return thisCut <= now ? thisCut : dateWithDay(now.getFullYear(), now.getMonth() - 1, corteDay);
}

/** Amount on the card's latest statement — what the bank expects for this
 * cycle: the card's balance AS OF THE LAST CUT (see lastCutDate), i.e.
 * rolled older debt + this cycle's charges − payments and credits made
 * before the cut. A charge logged ON the cut day starts the NEXT cycle
 * (excluded here), matching how the bank fixes the statement at the cut.
 * ponytail: fixed at the cut — payments made after the cut don't shrink it
 * (edit the payoff amount if you already paid part of it), and the bank's
 * interest is unknown to the app. Returns undefined without a corteDay. */
export function statementAmount(
  wallet: Pick<Wallet, "id" | "corteDay" | "openingBalance">,
  transactions: Pick<Transaction, "type" | "amount" | "currency" | "walletId" | "toWalletId" | "date">[],
  now: Date = new Date()
): number | undefined {
  const cd = wallet.corteDay;
  if (cd == null || cd < 1 || cd > 31 || wallet.id == null) return undefined;
  const cut = lastCutDate(cd, now);
  const cutMs = cut.getTime();
  // Balance as of the cut: the same ledger math as the live balance
  // (computeBalances), restricted to activity before the cut day. A
  // negative balance = debt the bank billed on this statement.
  const before = transactions.filter((t) => localDayStart(new Date(t.date)) < cutMs);
  const bal = computeBalances([wallet], before).get(wallet.id) ?? 0;
  return roundCents(Math.max(0, -bal));
}

/** Credits a card received on/after `sinceMs` (a cut midnight from
 * lastCutDate): transfers in plus income (cashback payouts, refunds),
 * compared on LOCAL calendar days like statementAmount. The billed
 * statement stays fixed at the cut — this is what shrinks the remaining
 * due after the user pays. Skips zero/non-finite amounts, same guard as
 * the other money math. */
export function creditsSinceCut(
  walletId: string,
  transactions: Pick<Transaction, "type" | "amount" | "walletId" | "toWalletId" | "date">[],
  sinceMs: number
): number {
  let sum = 0;
  for (const t of transactions) {
    if (!Number.isFinite(t.amount) || t.amount === 0) continue;
    const credit =
      (t.type === "transfer" && t.toWalletId === walletId) ||
      (t.type === "income" && t.walletId === walletId);
    if (!credit) continue;
    if (localDayStart(new Date(t.date)) < sinceMs) continue;
    sum = roundCents(sum + t.amount);
  }
  return roundCents(sum);
}
