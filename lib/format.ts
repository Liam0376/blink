import { db, type Budget, type Category, type Currency, type Debt, type Recurring, type Transaction, type Wallet } from "./db";
import { matchWallet, matchCategory, normText } from "./shortcut";
import { auditBooks } from "./audit";
import { APP_ID } from "./keys";
import { remapIds } from "./sync/ids";

/** Suggested/quick-pick currencies — not exhaustive. Users can add any
 * ISO 4217-shaped code (see WalletManager "Other…"); elsewhere options are
 * derived from currencies actually in use (orderedCurrencyOptions). */
export const CURRENCIES: Currency[] = ["MXN", "USD", "EUR"];

/** Display symbol for known currencies; unknown/custom codes fall back to the code itself. */
export const CUR_SYM: Record<string, string> = { MXN: "$", USD: "$", EUR: "€" };

/**
 * <select> options from currencies actually in use: preset suggestions
 * first (in CURRENCIES order) when present, then custom codes A–Z.
 * With only preset currencies in use this equals the old fixed list.
 */
export function orderedCurrencyOptions(used: readonly string[]): string[] {
  const set = new Set(used);
  const presets = CURRENCIES.filter((c) => set.has(c));
  const customs = [...set].filter((c) => !CURRENCIES.includes(c)).sort();
  return [...presets, ...customs];
}

/**
 * Every currency actually in use (presets first, then customs A-Z); falls
 * back to the suggestions when there are no wallets yet, and always keeps
 * `current` selectable even if nothing uses it.
 */
export function currencyOptionsFor(wallets: readonly { currency: Currency }[], current: Currency): string[] {
  const list = orderedCurrencyOptions(wallets.map((w) => w.currency));
  const base = list.length > 0 ? list : [...CURRENCIES];
  return base.includes(current) ? base : [current, ...base];
}

const fmtCache = new Map<string, Intl.NumberFormat>();

/**
 * Round to 2 decimal places (cents) to prevent floating-point drift.
 * Used for internal arithmetic only — display formatting uses Intl.NumberFormat.
 */
export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Sanitize a free-typed amount field. es-CR uses "," as the decimal separator
 * and mobile decimal pads emit it, so commas map to "." — stripping them (the
 * old behavior) silently turned "12,50" into 1250. Leftover garbage like
 * "1.2.3" still parses as NaN and is rejected downstream by the
 * finite-amount checks (fail closed, never mis-posted).
 */
/** Ceilings for the two rate fields. A stray zero turns a typo into money. */
export const MAX_CASHBACK_PCT = 100;
export const MAX_ROI_PCT = 1000;

/**
 * Parse a percentage the user typed. `undefined` when it is empty, zero,
 * negative or unparseable; `tooHigh` flags a value above the ceiling so the
 * caller can say why instead of silently dropping it.
 */
export function parsePercentInput(raw: string, max: number): { pct?: number; tooHigh: boolean } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { tooHigh: false };
  if (n > max) return { tooHigh: true };
  return { pct: n, tooHigh: false };
}

export function sanitizeAmountInput(v: string, opts?: { allowNegative?: boolean }): string {
  const stripped = v.replace(/,/g, ".").replace(/[^0-9.\-]/g, "");
  return opts?.allowNegative ? stripped : stripped.replace(/-/g, "");
}

export function fmtMoney(amount: number, currency: Currency = "MXN"): string {
  const key = currency;
  if (!fmtCache.has(key)) {
    try {
      fmtCache.set(
        key,
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency,
          maximumFractionDigits: 2,
        })
      );
    } catch {
      // Syntactically valid but non-existent code (e.g. "ZZZ"): Intl throws
      // RangeError. Degrade to a plain number + code instead of crashing render.
      return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} ${currency}`;
    }
  }
  return fmtCache.get(key)!.format(amount);
}

export function toInputDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/**
 * Whole days elapsed since an ISO timestamp (backup-reminder nag).
 * Plain Math.floor arithmetic — no dependency; a DST edge (~1h) is
 * irrelevant against a 30-day threshold. NaN for an unparseable input.
 */
export function daysSince(iso: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

export function prettyDay(iso: string): string {
  const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export function startOfPeriod(period: "week" | "month" | "year", ref = new Date()): Date {
  const d = new Date(ref);
  if (period === "week") {
    const day = (d.getDay() + 6) % 7; // Monday start
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
  } else if (period === "month") {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
  } else {
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
  }
  return d;
}

export async function exportJSON(opts?: { images?: boolean }): Promise<string> {
  const [wallets, categories, transactions, budgets, debts, recurring] =
    await Promise.all([
      db.wallets.toArray(),
      db.categories.toArray(),
      db.transactions.toArray(),
      db.budgets.toArray(),
      db.debts.toArray(),
      db.recurring.toArray(),
    ]);
  const txs = opts?.images
    ? transactions
    : transactions.map((t) => ({ ...t, image: undefined }));
  return JSON.stringify(
    { app: APP_ID, exportedAt: new Date().toISOString(), imagesIncluded: !!opts?.images, wallets, categories, transactions: txs, budgets, debts, recurring },
    null,
    2
  );
}

export interface ImportCounts {
  wallets: number;
  categories: number;
  transactions: number;
  budgets: number;
  debts: number;
  recurring: number;
}

export interface ParsedBackup {
  wallets: Wallet[];
  categories: Category[];
  transactions: Transaction[];
  budgets: Budget[];
  debts: Debt[];
  recurring: Recurring[];
  exportedAt?: string;
}

const BACKUP_TABLES = ["wallets", "categories", "transactions", "budgets", "debts", "recurring"] as const;

/** Every table except categories carries a currency. */
const CURRENCY_TABLES = ["wallets", "transactions", "budgets", "debts", "recurring"] as const;

/**
 * Parse + validate backup text without touching the database.
 * Throws an Error with a user-facing (English) message on any problem.
 */
export function parseBackup(text: string): ParsedBackup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON. Choose the backup file you downloaded from the app.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("The file doesn't look like a Blink backup: unrecognized format.");
  }
  const obj = data as Record<string, unknown>;
  if (obj.app !== APP_ID) {
    throw new Error("The file doesn't look like a Blink backup (invalid or missing “app” field).");
  }
  for (const key of BACKUP_TABLES) {
    if (!Array.isArray(obj[key])) {
      throw new Error(`The backup is incomplete or damaged: the “${key}” field is missing (expected a list).`);
    }
    for (const row of obj[key] as unknown[]) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error(`The backup is damaged: an entry in “${key}” is not a valid object.`);
      }
    }
  }
  // Field-level validation: a hand-edited or foreign backup with a bad
  // type or a non-finite/non-positive amount would otherwise poison
  // balances (unknown types fall into the transfer branch, NaN sticks).
  const txs = obj.transactions as Transaction[];
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i] as unknown as Record<string, unknown>;
    if (t.type !== "expense" && t.type !== "income" && t.type !== "transfer") {
      throw new Error(`The backup is damaged: transaction ${i + 1} has an invalid type.`);
    }
    if (typeof t.amount !== "number" || !Number.isFinite(t.amount) || t.amount <= 0) {
      throw new Error(`The backup is damaged: transaction ${i + 1} has an invalid amount.`);
    }
  }

  // Every row that carries a currency must carry a well-formed ISO 4217 code.
  // Requiring a string, not merely rejecting a bad one: a missing or numeric
  // currency used to slip through and install a wallet whose currency was
  // `undefined`, which split net worth into a phantom bucket and rendered as
  // MXN by accident of fmtMoney's default.
  for (const key of CURRENCY_TABLES) {
    const rows = obj[key] as Array<Record<string, unknown>>;
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i].currency;
      if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
        throw new Error(`The backup is damaged: ${key} entry ${i + 1} has an invalid currency.`);
      }
    }
  }

  // Deduplicate ids within each table (keep first): merged exports often
  // repeat ids, and bulkPut last-wins would silently drop rows while the
  // restored-count toast claims them all.
  function deduped<T extends { id?: unknown }>(rows: T[]): T[] {
    const seen = new Set<unknown>();
    return rows.filter((r) => {
      if (typeof r.id !== "number" && typeof r.id !== "string") return true;
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }

  return {
    wallets: deduped(obj.wallets as Wallet[]),
    categories: deduped(obj.categories as Category[]),
    transactions: deduped(txs),
    budgets: deduped(obj.budgets as Budget[]),
    debts: deduped(obj.debts as Debt[]),
    recurring: deduped(obj.recurring as Recurring[]),
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : undefined,
  };
}

/**
 * Restore a backup produced by exportJSON(). Destructive: wipes all six
 * tables first. Runs inside a single Dexie read-write transaction so a
 * failure partway through rolls back instead of leaving a half-restored DB.
 * Legacy numeric ids are re-keyed before writing; UUID ids pass through
 * unchanged, so re-importing a current export stays idempotent.
 */
export async function importJSON(text: string): Promise<ImportCounts> {
  // Validate BEFORE touching the DB: a malformed file never wipes anything.
  const backup = parseBackup(text);
  // Fail closed on error-severity integrity problems (orphaned wallets,
  // currency mismatches, bad transfers): installing them would silently
  // corrupt every balance behind a success message. Warnings (missing
  // categories, end-date quirks) still restore — they degrade gracefully
  // in the UI and Check books will flag them.
  const problems = auditBooks(backup).filter((i) => i.severity === "error");
  if (problems.length > 0) {
    throw new Error(
      `The backup is damaged and was not restored: ${problems.map((p) => `${p.message} (${p.count})`).join("; ")}. Your current data is untouched.`
    );
  }
  // Re-key before writing: a legacy export carries numeric ids that would
  // orphan every FK in a string-PK table. remapIds preserves ids that are
  // already UUIDs, so re-importing a current export is idempotent. Pass only
  // the six tables: ParsedBackup also carries exportedAt, which is not a table.
  const { books } = remapIds({
    wallets: backup.wallets,
    categories: backup.categories,
    transactions: backup.transactions,
    budgets: backup.budgets,
    debts: backup.debts,
    recurring: backup.recurring,
  });
  await db.transaction("rw", [db.wallets, db.categories, db.transactions, db.budgets, db.debts, db.recurring], async () => {
    await db.wallets.clear();
    await db.categories.clear();
    await db.transactions.clear();
    await db.budgets.clear();
    await db.debts.clear();
    await db.recurring.clear();
    await db.wallets.bulkPut(books.wallets);
    await db.categories.bulkPut(books.categories);
    await db.transactions.bulkPut(books.transactions);
    await db.budgets.bulkPut(books.budgets);
    await db.debts.bulkPut(books.debts);
    await db.recurring.bulkPut(books.recurring);
  });
  return {
    wallets: backup.wallets.length,
    categories: backup.categories.length,
    transactions: backup.transactions.length,
    budgets: backup.budgets.length,
    debts: backup.debts.length,
    recurring: backup.recurring.length,
  };
}

export interface CSVRow {
  date: string;
  type: string;
  amount: number;
  currency: string;
  wallet: string;
  toWallet?: string;
  category: string;
  note?: string;
}

/** Neutralize spreadsheet formula injection (=, +, -, @ at cell start). */
function csvCell(v: string | number): string {
  let s = String(v);
  if (/^\s*[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function transactionsToCSV(rows: CSVRow[]): string {
  const head = "date,type,amount,currency,wallet,to_wallet,category,note";
  const lines = rows.map((r) =>
    [r.date, r.type, r.amount, r.currency, r.wallet, r.toWallet ?? "", r.category, r.note ?? ""].map(csvCell).join(",")
  );
  return [head, ...lines].join("\n");
}

/**
 * Parse a CSV file into transactions using this app's own export format.
 * Round-trip: transactionsToCSV output → parseTransactionsCSV → new transactions.
 *
 * NOTE: This importer expects the EXACT format produced by transactionsToCSV:
 * 8 columns (date,type,amount,currency,wallet,to_wallet,category,note),
 * quoted fields with "" escaping. This is NOT a generic bank-statement importer —
 * each wallet/category name must already exist in the app. If you need to import
 * from another format or app, restore the full backup JSON instead.
 *
 * Returns both successfully parsed transactions AND human-readable error messages
 * for invalid rows (wallet/category not found, bad amount/date, currency mismatch).
 */
/** Names that fold to the same thing as `name` (accents, case, spacing). */
function sameName<T extends { name: string }>(name: string, rows: T[]): T[] {
  const n = normText(name);
  return rows.filter((r) => normText(r.name) === n);
}

/**
 * Resolve a CSV name to exactly one row. Two accounts called "Efectivo" (or
 * "Súper" and "Super", which normText folds together) would otherwise send
 * the charge to whichever happened to be first, silently.
 */
function resolveUnique<T extends { name: string }>(name: string, rows: T[]): T | "ambiguous" | undefined {
  const matches = sameName(name, rows);
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

export function parseTransactionsCSV(
  text: string,
  wallets: Wallet[],
  categories: Category[]
): { transactions: Omit<Transaction, "id">[]; errors: string[] } {
  // Normalize line endings: CRLF (Windows) and LF (Unix) both split correctly
  const lines = text.trim().replace(/\r\n/g, "\n").split("\n");
  const errors: string[] = [];
  const transactions: Omit<Transaction, "id">[] = [];

  // Helper: parse a CSV row (handle quoted fields with "" escaping).
  function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote: "" → "
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  // Header validation: expect exactly these columns in order
  const expectedHeader = ["date", "type", "amount", "currency", "wallet", "to_wallet", "category", "note"];
  if (lines.length === 0) {
    errors.push("CSV is empty");
    return { transactions, errors };
  }

  const headerFields = parseCSVLine(lines[0]);
  if (headerFields.length !== 8 || !headerFields.every((f, i) => f === expectedHeader[i])) {
    errors.push(`Header mismatch: expected "${expectedHeader.join(",")}" but got "${headerFields.join(",")}"`);
    return { transactions, errors };
  }

  // Require at least one data row (header alone is not valid)
  if (lines.length < 2) {
    errors.push("CSV has only a header row; no transactions to import");
    return { transactions, errors };
  }

  // Parse data rows (skip header at index 0)
  for (let rowNum = 1; rowNum < lines.length; rowNum++) {
    const line = lines[rowNum].trim();
    if (!line) continue; // Skip empty lines

    const fields = parseCSVLine(line);
    if (fields.length !== 8) {
      errors.push(`Row ${rowNum + 1}: expected 8 columns, got ${fields.length}`);
      continue;
    }

    const [dateStr, typeStr, amountStr, currencyStr, walletStr, toWalletStr, categoryStr, noteStr] = fields;

    // Validate type
    const type = typeStr.toLowerCase();
    if (!["expense", "income", "transfer"].includes(type)) {
      errors.push(`Row ${rowNum + 1}: type must be "expense", "income", or "transfer", got "${typeStr}"`);
      continue;
    }

    // Validate amount
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`Row ${rowNum + 1}: amount must be a positive number, got "${amountStr}"`);
      continue;
    }

    // Validate date. A bare YYYY-MM-DD parses as UTC midnight, which lands
    // on the previous local day west of UTC — treat it as local noon
    // instead (same convention as prettyDay).
    const dateObj = new Date(/^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `${dateStr}T12:00:00` : dateStr);
    if (Number.isNaN(dateObj.getTime())) {
      errors.push(`Row ${rowNum + 1}: date "${dateStr}" is not a valid ISO date`);
      continue;
    }

    // Resolve wallet by name, refusing an ambiguous one rather than
    // guessing: a charge in the wrong account is worse than a failed import.
    const walletMatch = resolveUnique(walletStr, wallets);
    if (walletMatch === "ambiguous") {
      errors.push(`Row ${rowNum + 1}: "${walletStr}" matches more than one account — rename one to import this row`);
      continue;
    }
    const wallet = walletMatch ?? matchWallet(walletStr, wallets);
    if (!wallet || wallet.id == null) {
      errors.push(`Row ${rowNum + 1}: wallet "${walletStr}" not found (case-insensitive match)`);
      continue;
    }

    // Validate currency matches wallet currency (bookkeeping rule)
    if (currencyStr !== wallet.currency) {
      errors.push(`Row ${rowNum + 1}: currency "${currencyStr}" does not match wallet "${walletStr}"'s currency "${wallet.currency}"`);
      continue;
    }

    // Resolve category by name (only for expense/income, not transfer)
    let categoryId: string | undefined = undefined;
    if (type !== "transfer" && categoryStr) {
      // Scope to the row's kind: "Salary" is income-only, so an expense row
      // naming it must fail rather than quietly tag itself with it.
      const scoped = categories.filter((c) => c.kind === (type as "expense" | "income"));
      const categoryMatch = resolveUnique(categoryStr, scoped);
      if (categoryMatch === "ambiguous") {
        errors.push(`Row ${rowNum + 1}: "${categoryStr}" matches more than one category — rename one to import this row`);
        continue;
      }
      const category = categoryMatch ?? matchCategory(categoryStr, categories, type as "expense" | "income");
      if (!category || category.id == null) {
        errors.push(`Row ${rowNum + 1}: category "${categoryStr}" not found for type "${type}"`);
        continue;
      }
      categoryId = category.id;
    }

    // For transfer: resolve destination wallet
    let toWalletId: string | undefined = undefined;
    if (type === "transfer") {
      if (!toWalletStr) {
        errors.push(`Row ${rowNum + 1}: transfer requires a destination wallet (to_wallet column)`);
        continue;
      }
      const toMatch = resolveUnique(toWalletStr, wallets);
      if (toMatch === "ambiguous") {
        errors.push(`Row ${rowNum + 1}: "${toWalletStr}" matches more than one account — rename one to import this row`);
        continue;
      }
      const toWallet = toMatch ?? matchWallet(toWalletStr, wallets);
      if (!toWallet || toWallet.id == null) {
        errors.push(`Row ${rowNum + 1}: destination wallet "${toWalletStr}" not found`);
        continue;
      }
      // For transfers, check both are same currency
      if (toWallet.currency !== wallet.currency) {
        errors.push(`Row ${rowNum + 1}: transfer wallets must have same currency (${wallet.name} is ${wallet.currency}, ${toWallet.name} is ${toWallet.currency})`);
        continue;
      }
      toWalletId = toWallet.id;
    } else {
      // For non-transfer, to_wallet should be empty
      if (toWalletStr) {
        errors.push(`Row ${rowNum + 1}: to_wallet should be empty for ${type} transaction`);
        continue;
      }
    }

    // Build transaction (round to cents at intake: the balance math's
    // per-operation rounding would otherwise absorb sub-cent amounts).
    const now = new Date().toISOString();
    transactions.push({
      type: type as "expense" | "income" | "transfer",
      amount: roundCents(amount),
      currency: currencyStr,
      walletId: wallet.id,
      toWalletId,
      categoryId,
      note: noteStr || undefined,
      date: dateObj.toISOString(),
      createdAt: now,
    });
  }

  return { transactions, errors };
}
