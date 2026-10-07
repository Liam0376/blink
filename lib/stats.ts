import type { Category, Currency } from "./db";
import { roundCents } from "./format";

/**
 * Pure stats helpers — extracted so the money logic is unit-testable
 * and the UI stays a thin view over it.
 */

export interface BucketTx {
  date: string;
  type: "expense" | "income" | "transfer";
  amount: number;
  currency: Currency;
  categoryId?: string;
}

export type StatsRange = "week" | "month" | "year";

export interface Bucket {
  label: string;
  expense: number;
  income: number;
  start: Date;
  end: Date;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/** Last millisecond of `start`'s calendar day. NOT start + 86_400_000 − 1: a
 *  calendar day is 23h/25h across a DST transition, so fixed-ms math spills
 *  the end into the next day (double-covering ~1h of transactions). */
function endOfDay(start: Date): Date {
  const e = new Date(start);
  e.setDate(e.getDate() + 1);
  e.setMilliseconds(-1);
  return e;
}

/** Local-time day key (NOT UTC slice — Costa Rica is UTC-6). */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shortDay(d: Date): string {
  // "Tu 9" style: 2-letter weekday + day number
  const wd = d.toLocaleDateString("en-US", { weekday: "short" }).replace(".", "").slice(0, 2);
  return `${wd} ${d.getDate()}`;
}

function shortMonth(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short" }).replace(".", "");
}

export function buildBuckets(range: StatsRange, ref = new Date()): Bucket[] {
  const buckets: Bucket[] = [];
  // Day steps use calendar arithmetic (setDate), NOT ref.getTime() - i * 86_400_000:
  // a "day" is 23h/25h across a DST transition, so fixed-ms steps can land twice
  // on the same calendar day (duplicate bucket, missing day). es-CR has no DST,
  // but the buckets must stay calendar-correct in any locale.
  if (range === "week") {
    for (let i = 6; i >= 0; i--) {
      const day = new Date(ref);
      day.setDate(day.getDate() - i);
      const start = startOfDay(day);
      buckets.push({ label: shortDay(start), expense: 0, income: 0, start, end: endOfDay(start) });
    }
  } else if (range === "month") {
    for (let i = 13; i >= 0; i--) {
      const day = new Date(ref);
      day.setDate(day.getDate() - i);
      const start = startOfDay(day);
      const label = start.getDate() === 1 || i === 13 ? `${start.getDate()} ${shortMonth(start)}` : String(start.getDate());
      buckets.push({ label, expense: 0, income: 0, start, end: endOfDay(start) });
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
      const end = new Date(ref.getFullYear(), ref.getMonth() - i + 1, 0, 23, 59, 59, 999);
      buckets.push({ label: shortMonth(start), expense: 0, income: 0, start, end });
    }
  }
  return buckets;
}

export interface BucketResult {
  buckets: Bucket[];
  totalIn: number;
  totalOut: number;
  /** Same-length window immediately before, for delta. */
  prevOut: number;
  /** Expense in other currencies within the window (so filtering never lies). */
  otherCurrencyOut: { currency: Currency; amount: number }[];
}

/**
 * Single-pass O(T) bucketing. `ref` = now.
 * Window: [buckets[0].start, buckets[last].end]; prev window = same length before.
 */
export function bucketize(range: StatsRange, txs: BucketTx[], currency: Currency, ref = new Date()): BucketResult {
  const buckets = buildBuckets(range, ref);
  const wStart = buckets[0].start.getTime();
  const wEnd = buckets[buckets.length - 1].end.getTime();
  const wLen = wEnd - wStart;
  const pStart = wStart - wLen;
  let totalIn = 0;
  let totalOut = 0;
  let prevOut = 0;
  const other = new Map<Currency, number>();

  // Day-index for O(1) placement on day-granular ranges
  const dayIndex = range === "year" ? null : new Map<string, number>();
  if (dayIndex) {
    buckets.forEach((b, i) => dayIndex.set(localDayKey(b.start.toISOString()), i));
  }

  for (const t of txs) {
    if (t.type === "transfer") continue;
    const ts = new Date(t.date).getTime();
    if (isNaN(ts)) continue;
    if (t.currency !== currency) {
      if (t.type === "expense" && ts >= wStart && ts <= wEnd) {
        other.set(t.currency, roundCents((other.get(t.currency) ?? 0) + t.amount));
      }
      continue;
    }
    if (ts >= wStart && ts <= wEnd) {
      let b: Bucket | undefined;
      if (dayIndex) {
        const idx = dayIndex.get(localDayKey(t.date));
        b = idx == null ? undefined : buckets[idx];
      } else {
        // month buckets: index by year*12+month offset from window start
        const d = new Date(t.date);
        const mIdx = (d.getFullYear() * 12 + d.getMonth()) - (buckets[0].start.getFullYear() * 12 + buckets[0].start.getMonth());
        b = mIdx >= 0 && mIdx < buckets.length ? buckets[mIdx] : undefined;
      }
      if (!b) continue;
      if (t.type === "expense") {
        b.expense = roundCents(b.expense + t.amount);
        totalOut = roundCents(totalOut + t.amount);
      } else {
        b.income = roundCents(b.income + t.amount);
        totalIn = roundCents(totalIn + t.amount);
      }
    } else if (t.type === "expense" && ts >= pStart && ts < wStart) {
      prevOut = roundCents(prevOut + t.amount);
    }
  }

  return {
    buckets,
    totalIn,
    totalOut,
    prevOut,
    otherCurrencyOut: [...other.entries()].map(([currency, amount]) => ({ currency, amount })),
  };
}

export interface Slice {
  label: string;
  value: number;
  color: string;
  icon: string;
}

/** Walk to the top-level ancestor (for roll-up of subcategory spend). */
export function topAncestor(id: string | undefined, byId: Map<string | undefined, Category>): Category | undefined {
  let cur = id == null ? undefined : byId.get(id);
  const seen = new Set<string | undefined>();
  while (cur?.parentId != null && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return cur;
}

/** Spend grouped by top-level category; top 6 + aggregated "Otros". */
export function spendByTopLevel(
  txs: BucketTx[],
  categories: Category[],
  currency: Currency,
  start: Date,
  end: Date,
  maxSlices = 6
): Slice[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const sums = new Map<string | undefined, number>();
  for (const t of txs) {
    if (t.type !== "expense" || t.currency !== currency) continue;
    const ts = new Date(t.date).getTime();
    if (isNaN(ts) || ts < start.getTime() || ts > end.getTime()) continue;
    const top = topAncestor(t.categoryId, byId);
    const key = top?.id;
    sums.set(key, roundCents((sums.get(key) ?? 0) + t.amount));
  }
  const all: Slice[] = [...sums.entries()]
    .map(([id, value]) => {
      const c = id == null ? undefined : byId.get(id);
      return { label: c?.name ?? "Other", value, color: c?.color ?? "#64748b", icon: c?.icon ?? "•" };
    })
    .sort((a, b) => b.value - a.value);
  if (all.length <= maxSlices) return all;
  const head = all.slice(0, maxSlices - 1);
  const rest = all.slice(maxSlices - 1).reduce((a, s) => a + s.value, 0);
  return [...head, { label: `Other (${all.length - maxSlices + 1})`, value: rest, color: "#a1a1aa", icon: "•••" }];
}

/** Does a tx in `txCat` count toward a budget scoped to `budgetCat`? Rolls up the parent chain. */
export function countsTowardBudget(
  txCat: string | undefined,
  budgetCat: string | null | undefined,
  byId: Map<string | undefined, Category>
): boolean {
  if (budgetCat == null) return true;
  if (txCat == null) return false;
  if (txCat === budgetCat) return true;
  let cur = byId.get(txCat);
  const seen = new Set<string>();
  while (cur?.parentId != null && !seen.has(cur.parentId)) {
    if (cur.parentId === budgetCat) return true;
    seen.add(cur.parentId);
    cur = byId.get(cur.parentId);
  }
  return false;
}

/**
 * Advance a recurring item's date by one period.
 * anchorDay pins the target day-of-month so a short-month clamp (Jan 31 ->
 * Feb 28) doesn't permanently drift the series down to the 28th — the next
 * step targets anchorDay again (-> Mar 31), not the already-clamped day.
 * Falls back to `d`'s own day for rows created before anchorDay existed.
 */
export function advanceRecurring(
  d: Date,
  frequency: "weekly" | "monthly" | "yearly",
  anchorDay?: number
): Date {
  const n = new Date(d);
  if (frequency === "weekly") {
    n.setDate(n.getDate() + 7);
  } else if (frequency === "monthly") {
    const day = anchorDay ?? n.getDate();
    n.setDate(1);
    n.setMonth(n.getMonth() + 1);
    n.setDate(Math.min(day, new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate()));
  } else {
    n.setFullYear(n.getFullYear() + 1);
  }
  return n;
}

/**
 * Catch up a recurring item's nextDate to the first occurrence still in the
 * future relative to `now` (capped at 120 steps — see advanceRecurring),
 * and report whether that catch-up pushed it past `endDate` (so the caller
 * should deactivate it). Pure — callers (manual "log now" and the
 * auto-log-on-open effect) do the actual transaction/DB writes.
 */
export function advanceRecurringPastNow(
  nextDate: Date,
  frequency: "weekly" | "monthly" | "yearly",
  anchorDay: number | undefined,
  now: Date,
  endDate?: string
): { nextDate: Date; ended: boolean } {
  let next = nextDate;
  let guard = 0;
  while (next <= now && guard++ < 120) next = advanceRecurring(next, frequency, anchorDay);
  let ended = false;
  if (endDate) {
    const end = new Date(endDate.slice(0, 10) + "T23:59:59.999");
    if (!isNaN(end.getTime()) && next.getTime() > end.getTime()) ended = true;
  }
  return { nextDate: next, ended };
}
