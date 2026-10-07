import type { Budget, Category, Debt, Recurring, Transaction, Wallet } from "./db";

export interface AuditIssue {
  severity: "error" | "warning";
  message: string;
  count: number;
}

export interface BooksData {
  wallets: Wallet[];
  categories: Category[];
  transactions: Transaction[];
  budgets: Budget[];
  debts: Debt[];
  recurring: Recurring[];
}

/**
 * Read-only re-verification of the core bookkeeping rules (see README
 * "Bookkeeping rules"): entry points enforce currency matching, but a
 * restored backup from an older schema, a hand-edited export, or a future
 * bug could violate it silently. Issues are grouped summaries (message +
 * count), not one entry per row, since there could be thousands of rows.
 * Returns [] when everything is clean (the common case).
 *
 * Note: Debt has no walletId in the schema (it's a plain checklist), so
 * there is no wallet reference to check on debts.
 */
export function auditBooks(data: BooksData): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const push = (severity: AuditIssue["severity"], message: string, count: number) => {
    if (count > 0) issues.push({ severity, message, count });
  };

  const walletById = new Map(data.wallets.map((w) => [w.id, w]));
  const categoryIds = new Set(data.categories.map((c) => c.id));

  let currencyMismatch = 0;
  let orphanWallet = 0;
  let orphanCategory = 0;
  let badTransfer = 0;
  for (const t of data.transactions) {
    const w = walletById.get(t.walletId);
    if (!w) {
      orphanWallet++;
    } else if (t.currency !== w.currency) {
      currencyMismatch++;
    }
    if (t.categoryId != null && !categoryIds.has(t.categoryId)) orphanCategory++;
    if (t.type === "transfer") {
      if (t.toWalletId == null) {
        badTransfer++;
      } else {
        const dest = walletById.get(t.toWalletId);
        if (!dest) badTransfer++;
        else if (w && dest.currency !== w.currency) badTransfer++;
      }
    }
  }
  push("error", "Transactions with a currency different from their wallet's", currencyMismatch);
  push("error", "Transactions pointing to a missing wallet", orphanWallet);
  push("warning", "Transactions pointing to a missing category", orphanCategory);
  push("error", "Transfers without a valid destination wallet or with a different currency", badTransfer);

  let orphanBudgetCategory = 0;
  for (const b of data.budgets) {
    if (b.categoryId != null && !categoryIds.has(b.categoryId)) orphanBudgetCategory++;
  }
  push("warning", "Budgets pointing to a missing category", orphanBudgetCategory);

  let orphanRecurringWallet = 0;
  let orphanRecurringCategory = 0;
  let badRecurringEndDate = 0;
  for (const r of data.recurring) {
    if (!walletById.has(r.walletId)) orphanRecurringWallet++;
    if (r.categoryId != null && !categoryIds.has(r.categoryId)) orphanRecurringCategory++;
    // Check for recurring items with endDate before nextDate (dead-on-arrival case).
    // Parse endDate as end-of-day (matching logNow's semantics) and compare with nextDate.
    // A non-string endDate (hand-edited restore) can't be evaluated — count it
    // as bad instead of throwing and killing the whole self-check.
    if (r.endDate != null && typeof r.endDate !== "string") {
      badRecurringEndDate++;
    } else if (typeof r.endDate === "string" && r.endDate) {
      const end = new Date(r.endDate.slice(0, 10) + "T23:59:59.999");
      const next = new Date(r.nextDate);
      if (!isNaN(end.getTime()) && end.getTime() < next.getTime()) {
        badRecurringEndDate++;
      }
    }
  }
  push("error", "Recurring items pointing to a missing wallet", orphanRecurringWallet);
  push("warning", "Recurring items pointing to a missing category", orphanRecurringCategory);
  push("warning", "Recurring items with an end date before their next occurrence", badRecurringEndDate);

  // Debt carries no walletId (plain checklist), so nothing to check there.

  const catById = new Map(data.categories.map((c) => [c.id, c]));
  let badParent = 0;
  for (const c of data.categories) {
    if (c.parentId == null) continue;
    if (!catById.has(c.parentId)) {
      badParent++;
      continue;
    }
    // Same seen-Set walk as topAncestor/countsTowardBudget in stats.ts:
    // terminates on cycles instead of hanging.
    const seen = new Set<string | undefined>([c.id]);
    let curId: string | undefined = c.parentId;
    let cyclic = false;
    while (curId != null) {
      if (seen.has(curId)) {
        cyclic = true;
        break;
      }
      seen.add(curId);
      curId = catById.get(curId)?.parentId;
    }
    if (cyclic) badParent++;
  }
  push("warning", "Categories with a missing parent or a cycle", badParent);

  return issues;
}
