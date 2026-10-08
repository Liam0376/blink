"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Home, ChartPie, Wallet as WalletIcon, PiggyBank, Ellipsis, Plus, Search, Moon, Sun } from "lucide-react";
import { db, type Currency, type Transaction, sortWallets } from "@/lib/db";
import { seedIfEmpty } from "@/lib/seed";
import { CUR_SYM, currencyOptionsFor, fmtMoney, prettyDay, roundCents, startOfPeriod } from "@/lib/format";
import { cashbackCreditTransaction, cashbackEarnedForWallet, computeBalances, computeCashback, computeGrownBalances, creditsSinceCut, lastCutDate, netWorthFromBalances, statementAmount, totalCashbackByWallet } from "@/lib/balances";
import {
  advanceRecurringPastNow,
  bucketize,
  countsTowardBudget,
  localDayKey,
  spendByTopLevel,
  type StatsRange,
  isRecurringDue,
} from "@/lib/stats";
import { normText } from "@/lib/shortcut";
import { newId } from "@/lib/sync/ids";
import QuickAdd from "@/components/QuickAdd";
import { Bars, Donut, Progress } from "@/components/Charts";
import {
  ApplyCashbackOpeningBanner,
  BudgetManager,
  CardStatementSection,
  CashbackPrompt,
  CategoryManager,
  CollapsibleSection,
  CortePrompt,
  DebtManager,
  RecurringManager,
  RoiPrompt,
  SettingsPanel,
  TransactionList,
  WalletManager,
} from "@/components/Managers";

type Tab = "inicio" | "stats" | "tarjetas" | "presu" | "mas";

const RANGE: Record<StatsRange, { tab: string; sub: string }> = {
  week: { tab: "7 days", sub: "Last 7 days" },
  month: { tab: "14 days", sub: "Last 14 days" },
  year: { tab: "12 months", sub: "Last 12 months" },
};

// Shared identity for a query that has not resolved. `?? []` would allocate a
// fresh array on every render until then, so each value below would change
// identity on every render and re-run every memo and effect depending on it
// (react-hooks/exhaustive-deps). `never[]` is assignable to every element type,
// so each `?? EMPTY` still infers its real type.
const EMPTY: never[] = [];

export default function App() {
  const [historyLimit, setHistoryLimit] = useState(120);
  // Sorted here, once: every wallet list in the app (home rows, the More
  // manager, the QuickAdd picker, the transfer and budget dropdowns) takes
  // this array as a prop.
  const wallets = useLiveQuery(async () => sortWallets(await db.wallets.toArray()), []) ?? EMPTY;
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? EMPTY;
  const transactions = useLiveQuery(() => db.transactions.orderBy("date").reverse().limit(historyLimit).toArray(), [historyLimit]) ?? EMPTY;
  // Full-dataset query for MONEY MATH ONLY (balances, month sums, budget
  // progress, stats). `transactions` above is paginated to `historyLimit`
  // for list performance, so money math must never read from it — with more
  // than `historyLimit` rows it would silently undercount older history.
  // O(T) toArray() over local IndexedDB rows is fine at this app's scale.
  const allTransactions = useLiveQuery(() => db.transactions.toArray(), []) ?? EMPTY;
  const budgets = useLiveQuery(() => db.budgets.toArray(), []) ?? EMPTY;
  const debts = useLiveQuery(() => db.debts.toArray(), []) ?? EMPTY;
  const recurring = useLiveQuery(() => db.recurring.toArray(), []) ?? EMPTY;

  const [tab, setTab] = useState<Tab>("inicio");
  const [showAdd, setShowAdd] = useState(false);
  const [editTx, setEditTx] = useState<Transaction | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filterWallet, setFilterWallet] = useState<string>("");
  const [statsRange, setStatsRange] = useState<StatsRange>("month");
  const [statsCurrency, setStatsCurrency] = useState<Currency>("MXN");
  // Progressive disclosure for the Cards + More tabs: all sections start
  // collapsed, multiple may be open at once.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleSection = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Lazy initializer (runs once, synchronously, during the first render —
  // not in a later effect): a separate "read real preference" effect used
  // to run AFTER a second effect that syncs `dark` to the DOM/localStorage,
  // so that second effect always fired first with the stale `false` default,
  // briefly removing the `.dark` class the pre-paint script (layout.tsx)
  // had already correctly added and persisting "0" to localStorage. Computing
  // the real value up front removes the race entirely: the one remaining
  // effect below always syncs from the correct value, from its very first
  // run. This also matches the pre-paint script's own fallback — saved
  // preference if present, else the device preference — so the first render
  // and that script never disagree.
  const [dark, setDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("blink:dark");
      return saved != null ? saved === "1" : !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // iOS Safari has a known cold-open race on IndexedDB (especially launching
    // from a home-screen icon): the very first open can fail even though
    // storage is healthy, and a retry a moment later succeeds. Try a few
    // times with backoff before surfacing an error.
    let cancelled = false;
    async function seedWithRetry() {
      const delays = [0, 300, 800];
      let lastErr: unknown;
      for (const delay of delays) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        try {
          await seedIfEmpty();
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    }
    seedWithRetry()
      .then(() => {
        if (navigator.storage?.persist) {
          navigator.storage.persist().then((granted) => {
            if (!granted) console.warn("Persistent storage denied — data may be evicted under pressure (private browsing?)");
          }).catch(() => {});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("seedIfEmpty failed after retries:", err);
        const detail = err instanceof Error ? ` (${err.name}: ${err.message})` : "";
        setToast(`Couldn't open the local database (private browsing? storage full?). Close and reopen the app.${detail}`);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-log recurring items whose nextDate has already passed, the moment
  // the app is opened — no confirm step (that's the point: it's automatic).
  // recurringAutoLogging guards against a duplicate write for the same row
  // while its async add/update is still in flight (Dexie's live query can
  // re-render this effect before that completes); once nextDate advances
  // past now, the row naturally stops matching and the effect leaves it alone.
  // The sweep additionally runs under a cross-tab lock (navigator.locks)
  // and each row posts inside one IndexedDB transaction, so neither a
  // second tab nor a crash mid-write can duplicate an occurrence.
  const recurringAutoLogging = useRef(new Set<string>());
  useEffect(() => {
    if (!ready) return;
    const now = new Date();
    const due = recurring.filter(
      (r) => r.id != null && isRecurringDue(r, now) && !recurringAutoLogging.current.has(r.id!)
    );
    if (due.length === 0) return;
    let cancelled = false;
    const run = async () => {
      for (const r of due) {
        if (cancelled || r.id == null) continue;
        const w = wallets.find((x) => x.id === r.walletId);
        if (!w) continue; // orphaned wallet — leave it for the user to fix manually
        const id = r.id;
        if (recurringAutoLogging.current.has(id)) continue;
        // Dead-on-arrival guard (mirrors logNow): a row born with endDate
        // before nextDate must deactivate without posting a phantom row.
        if (typeof r.endDate === "string" && r.endDate) {
          const end = new Date(r.endDate.slice(0, 10) + "T23:59:59.999");
          if (!isNaN(end.getTime()) && new Date(r.nextDate).getTime() > end.getTime()) {
            recurringAutoLogging.current.add(id);
            try {
              await db.recurring.update(id, { active: false });
            } catch (err) {
              console.error("auto-log recurring failed:", err);
            } finally {
              recurringAutoLogging.current.delete(id);
            }
            continue;
          }
        }
        recurringAutoLogging.current.add(id);
        try {
          const nowIso = now.toISOString();
          // One IndexedDB transaction: a crash between the add and the
          // update can no longer duplicate the occurrence on next open.
          let posted = false;
          await db.transaction("rw", [db.transactions, db.recurring], async () => {
            // Re-read inside the transaction: the render that built `due`
            // used a snapshot, so a second tab can advance this row between
            // the render and the lock — and then both would post it.
            const fresh = await db.recurring.get(id);
            if (!fresh || !isRecurringDue(fresh, now)) return;
            const amt = roundCents(fresh.amount);
            const cashbackEarned = computeCashback(r.type, amt, w);
            const txId = newId();
            await db.transactions.add({
              id: txId,
              type: r.type, amount: amt, currency: w.currency, walletId: w.id!,
              categoryId: r.categoryId, note: r.label, date: nowIso,
              cashbackEarned,
              createdAt: nowIso,
            });
            const credit = cashbackCreditTransaction(cashbackEarned, w, nowIso, txId);
            if (credit) await db.transactions.add({ ...credit, id: newId(), createdAt: nowIso });
            const { nextDate, ended } = advanceRecurringPastNow(new Date(r.nextDate), r.frequency, r.anchorDay, now, r.endDate);
            await db.recurring.update(id, ended ? { nextDate: nextDate.toISOString(), active: false } : { nextDate: nextDate.toISOString() });
            posted = true;
          });
          if (posted) setToast(`Logged automatically: ${r.label} · ${fmtMoney(r.amount, w.currency)}`);
        } catch (err) {
          console.error("auto-log recurring failed:", err);
        } finally {
          recurringAutoLogging.current.delete(id);
        }
      }
    };
    (async () => {
      try {
        // Serialize across tabs: two tabs open on the same store would
        // otherwise read the same stale nextDate and both post the row.
        const locks = typeof navigator !== "undefined"
          ? (navigator as unknown as { locks?: { request: (name: string, fn: () => Promise<void>) => Promise<void> } }).locks
          : undefined;
        if (locks) await locks.request("blink:recurring-autolog", run);
        else await run();
      } catch (err) {
        console.error("auto-log recurring failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, recurring, wallets]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("blink:dark", dark ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [dark]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const cById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const wById = useMemo(() => new Map(wallets.map((w) => [w.id, w])), [wallets]);

  // Balances: opening balance + ledger over the FULL dataset (transfers
  // move money, same currency by construction). Never use the paginated
  // `transactions` here — see the query comment above.
  const balanceByWallet = useMemo(() => computeBalances(wallets, allTransactions), [allTransactions, wallets]);

  // Display-only ROI projection on top of the real ledger balance (see
  // Wallet.roiAnnualPct / computeGrownBalances) — ledger truth (balanceByWallet)
  // is untouched and stays what everything else (transfers, CSV, backups) uses.
  const grownBalanceByWallet = useMemo(
    () => computeGrownBalances(wallets, balanceByWallet, allTransactions),
    [wallets, balanceByWallet, allTransactions]
  );

  // Cashback earned per wallet: sum of each expense's cashbackEarned,
  // frozen at the time it was logged (see computeCashback) — never
  // recomputed live from the wallet's current cashbackPct.
  const cashbackByWallet = useMemo(() => totalCashbackByWallet(allTransactions), [allTransactions]);

  // Net worth grouped by currency (excludes archived wallets, sorted by absolute
  // value descending), built from the grown balances so ROI growth is reflected
  // in "Available to spend" too — same money, same total, just also shown growing.
  const netWorth = useMemo(() => netWorthFromBalances(wallets, grownBalanceByWallet), [wallets, grownBalanceByWallet]);

  const monthStart = useMemo(() => startOfPeriod("month"), []);
  // Upper-bounded at now: a future-dated row (fat-fingered year, CSV) must
  // not inflate the current month's "spent" or the budget progress. `nowEnd`
  // is built inside the memo so it stops being a dep that changes identity
  // every render; it still refreshes on any change to the ledger below it.
  const monthTx = useMemo(() => {
    const nowEnd = new Date();
    return allTransactions.filter((t) => { const d = new Date(t.date); return d >= monthStart && d <= nowEnd; });
  }, [allTransactions, monthStart]);

  // Single-pass month sums per currency (one source for the whole header)
  const monthSums = useMemo(() => {
    const m = new Map<Currency, { in: number; out: number }>();
    for (const t of monthTx) {
      if (t.type === "transfer") continue;
      const e = m.get(t.currency) ?? { in: 0, out: 0 };
      if (t.type === "income") e.in = roundCents(e.in + t.amount);
      else e.out = roundCents(e.out + t.amount);
      m.set(t.currency, e);
    }
    return m;
  }, [monthTx]);

  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });

  const history = useMemo(() => {
    // Accent-folded so "super" finds "Súper" (toLowerCase alone won't).
    const q = normText(deferredQuery);
    return transactions.filter((t) => {
      if (filterWallet && String(t.walletId) !== filterWallet && String(t.toWalletId) !== filterWallet) return false;
      if (q) {
        const c = t.categoryId != null ? (cById.get(t.categoryId)?.name ?? "") : "";
        const w = wById.get(t.walletId)?.name ?? "";
        if (!normText(`${c} ${w} ${t.note ?? ""}`).includes(q)) return false;
      }
      return true;
    });
  }, [transactions, filterWallet, deferredQuery, cById, wById]);

  // ---- Stats (pure helpers, O(T), over the FULL dataset) ----
  const stats = useMemo(() => {
    const r = bucketize(statsRange, allTransactions, statsCurrency);
    const wStart = r.buckets[0].start;
    const wEnd = r.buckets[r.buckets.length - 1].end;
    const slices = spendByTopLevel(allTransactions, categories, statsCurrency, wStart, wEnd);
    return { ...r, slices, wStart, wEnd };
  }, [allTransactions, statsRange, statsCurrency, categories]);

  const otherCurNote =
    stats.otherCurrencyOut.length > 0
      ? `Only ${statsCurrency} · also ${stats.otherCurrencyOut.map((o) => fmtMoney(o.amount, o.currency)).join(" + ")} in other currencies`
      : `All in ${statsCurrency} in this period`;

  const statsOptions = useMemo(() => currencyOptionsFor(wallets, statsCurrency), [wallets, statsCurrency]);

  // ---- Budget progress (subcategory spend rolls up to the parent budget; FULL dataset) ----
  const budgetProgress = useMemo(() => {
    const now = new Date();
    return budgets.map((b) => {
      const start = startOfPeriod(b.period);
      const spent = roundCents(
        allTransactions
          .filter((t) => t.type === "expense" && t.currency === b.currency && new Date(t.date) >= start && new Date(t.date) <= now)
          .filter((t) => countsTowardBudget(t.categoryId, b.categoryId, cById))
          .reduce((a, t) => a + t.amount, 0)
      );
      return { b, spent, pct: b.limit > 0 ? (spent / b.limit) * 100 : 0 };
    });
  }, [budgets, allTransactions, cById]);

  const groupedHistory = useMemo(() => {
    const groups = new Map<string, typeof history>();
    for (const t of history) {
      const k = localDayKey(t.date);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    return [...groups.entries()];
  }, [history]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "inicio", label: "Home", icon: <Home size={20} /> },
    { id: "stats", label: "Stats", icon: <ChartPie size={20} /> },
    { id: "tarjetas", label: "Cards", icon: <WalletIcon size={20} /> },
    { id: "presu", label: "Budget", icon: <PiggyBank size={20} /> },
    { id: "mas", label: "More", icon: <Ellipsis size={20} /> },
  ];

  const openManualAdd = () => {
    setShowAdd(true);
  };

  return (
    <div className="min-h-dvh" style={{ background: "var(--background)", color: "var(--foreground)" }}>
      <div className="mx-auto max-w-md min-h-dvh flex flex-col">
        <header className="pt-safe px-5 pb-2">
          <div className="flex items-center justify-between mb-1">
            <div>
              <p className="text-[11px] font-semibold tracking-widest uppercase" style={{ color: "var(--muted)" }}>Blink</p>
              <p className="text-[10px] mt-0.5" style={{ color: "var(--muted)" }}>On this phone only</p>
            </div>
            <div className="flex items-center gap-3">
              {netWorth[0] && (
                <div className="text-right leading-tight">
                  <p className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: "var(--muted)" }}>Available</p>
                  <p className="text-sm font-extrabold animate-number-in">{fmtMoney(netWorth[0].total, netWorth[0].currency)}</p>
                </div>
              )}
              {/* Both icons, picked by CSS, not by `dark`. The pre-paint script
                  in layout.tsx already set `.dark` on <html>, but the server
                  cannot know the theme, so rendering `dark` here made the first
                  client render disagree with the server HTML and React threw a
                  hydration mismatch on every dark-mode load. The label is static
                  for the same reason: React leaves a suppressed attribute at the
                  server's value, so a dynamic one would be stale anyway. */}
              <button onClick={() => setDark(!dark)} className="p-2.5 rounded-xl min-w-[44px] min-h-[44px] flex items-center justify-center press" style={{ background: "var(--surface)" }} aria-label="Switch theme">
                <Sun size={17} className="hidden dark:block" />
                <Moon size={17} className="dark:hidden" />
              </button>
            </div>
          </div>
          <div className="card-hero p-5 animate-scale-in">
            <p className="label mb-1.5">Spent in {monthName}</p>
            {!ready ? (
              <div className="space-y-2 animate-pulse" aria-hidden>
                <div className="h-10 w-44 rounded-lg" style={{ background: "var(--surface)" }} />
                <div className="h-4 w-64 rounded" style={{ background: "var(--surface)" }} />
              </div>
            ) : monthSums.size === 0 ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>No transactions this month — tap + below</p>
            ) : (
              <div className="space-y-3">
                {[...monthSums.entries()].map(([cur, v]) => (
                  <div key={cur}>
                    <p className="text-4xl font-extrabold tracking-tight animate-number-in">{fmtMoney(v.out, cur)}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>
                        +{fmtMoney(v.in, cur)}
                      </span>
                      <span className="text-xs" style={{ color: "var(--muted)" }}>
                        Net {fmtMoney(v.in - v.out, cur)} · {monthTx.filter((t) => t.currency === cur && t.type !== "transfer").length} txns
                      </span>
                    </div>
                  </div>
                ))}
                {budgetProgress[0] && (
                  <div className="flex items-center gap-2 pt-1">
                    <div className="h-1.5 flex-1 rounded-full overflow-hidden" style={{ background: "var(--surface)" }}>
                      <div className={`h-full rounded-full transition-all ${budgetProgress[0].pct > 100 ? "bg-rose-500" : ""}`} style={{ width: `${Math.min(100, budgetProgress[0].pct)}%`, ...( budgetProgress[0].pct <= 100 ? { background: "var(--accent)" } : {}) }} />
                    </div>
                    <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: "var(--muted)" }}>
                      {fmtMoney(Math.max(0, budgetProgress[0].b.limit - budgetProgress[0].spent), budgetProgress[0].b.currency)} left
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 px-5 py-3 pb-28 overflow-y-auto">
          {tab === "inicio" && (
            <div className="space-y-4 animate-tab-in">
              {/* Single-currency total already shown in the header on every tab;
                  only repeat the breakdown here when there's more than one currency. */}
              {netWorth.length > 1 && (
                <div className="card p-5 animate-scale-in">
                  <h3 className="label mb-3">AVAILABLE TO SPEND</h3>
                  <ul className="space-y-2 list-none">
                    {netWorth.map((nw) => (
                      <li key={nw.currency} className="flex justify-between items-baseline">
                        <span className="text-sm" style={{ color: "var(--muted)" }}>{nw.currency}</span>
                        <span className="text-xl font-extrabold animate-number-in">{fmtMoney(nw.total, nw.currency)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>Cash + cards, net of what you owe on each card.</p>
                </div>
              )}
              {budgetProgress.slice(0, 2).map(({ b, spent, pct }, i) => (
                <div key={b.id} className={`card p-4 animate-slide-up stagger-${i + 1}`}>
                  <div className="flex justify-between text-xs mb-2">
                    <span className="font-semibold">{b.label}</span>
                    <span className={`font-bold ${pct > 100 ? "text-rose-500" : ""}`} style={pct <= 100 ? { color: "var(--accent)" } : {}}>{Math.round(pct)}%</span>
                  </div>
                  <Progress pct={pct} spent={spent} limit={b.limit} currency={b.currency} />
                </div>
              ))}

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex items-center gap-2 flex-1 px-3 py-2.5 rounded-xl min-h-[44px]" style={{ background: "var(--surface)" }}>
                    <Search size={15} style={{ color: "var(--muted)" }} aria-hidden />
                    <label htmlFor="hist-search" className="sr-only">Search transactions</label>
                    <input id="hist-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search transactions…" className="bg-transparent outline-none text-sm flex-1" />
                  </div>
                  <label htmlFor="hist-wallet" className="sr-only">Filter by account</label>
                  <select id="hist-wallet" value={filterWallet} onChange={(e) => setFilterWallet(e.target.value)} className="px-2.5 py-2.5 rounded-xl text-xs font-semibold max-w-28 min-h-[44px]" style={{ background: "var(--surface)" }}>
                    <option value="">All</option>
                    {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
                {!ready ? (
                  <div className="space-y-2 animate-pulse" aria-hidden>
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="h-14 rounded-xl" style={{ background: "var(--surface)" }} />
                    ))}
                  </div>
                ) : (
                  <>
                    {groupedHistory.map(([day, txs]) => (
                      <div key={day} className="mb-1">
                        <p className="label mt-4 mb-1.5">{prettyDay(day)}</p>
                        <TransactionList txs={txs} wallets={wallets} categories={categories} onEdit={(tx) => {
                          if (tx.id == null) return;
                          setEditTx(tx as Transaction);
                        }} />
                      </div>
                    ))}
                    {history.length === 0 && <p className="text-center text-sm py-8" style={{ color: "var(--muted)" }}>Nothing here yet. Tap + to log your first expense.</p>}
                    {history.length >= historyLimit && (
                      <button onClick={() => setHistoryLimit((l) => l + 120)} className="w-full py-3 text-xs font-bold min-h-[44px]" style={{ color: "var(--accent)" }}>
                        Show more transactions
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {tab === "stats" && (
            <div className="space-y-4 animate-tab-in">
              <div className="flex gap-2">
                {(["week", "month", "year"] as const).map((r) => (
                  <button key={r} onClick={() => setStatsRange(r)} aria-pressed={statsRange === r} className={`flex-1 py-2.5 rounded-xl text-xs font-semibold min-h-[44px] transition-all ${statsRange === r ? "text-white" : ""}`} style={statsRange === r ? { background: "var(--accent)" } : { background: "var(--surface)", color: "var(--muted)" }}>
                    {RANGE[r].tab}
                  </button>
                ))}
                <label htmlFor="stats-cur" className="sr-only">Stats currency</label>
                <select id="stats-cur" value={statsCurrency} onChange={(e) => setStatsCurrency(e.target.value as Currency)} className="px-2 rounded-xl text-xs font-semibold min-h-[44px]" style={{ background: "var(--surface)" }}>
                  {statsOptions.map((c) => <option key={c} value={c}>{CUR_SYM[c] ? `${CUR_SYM[c]} ${c}` : c}</option>)}
                </select>
              </div>
              <div className="card p-5 animate-slide-up">
                <p className="label mb-3">INCOME VS EXPENSES · {RANGE[statsRange].sub.toUpperCase()}</p>
                <Bars
                  data={stats.buckets}
                  currency={statsCurrency}
                  totalIn={stats.totalIn}
                  totalOut={stats.totalOut}
                  deltaOut={stats.totalOut - stats.prevOut}
                  subtitle={otherCurNote}
                />
              </div>
              <div className="card p-5 animate-slide-up stagger-2">
                <p className="label mb-3">SPENDING BY CATEGORY · {RANGE[statsRange].sub.toUpperCase()}</p>
                <Donut
                  slices={stats.slices}
                  currency={statsCurrency}
                  emptyNote={`No ${statsCurrency} spending in this period. ${stats.otherCurrencyOut.length > 0 ? `There is ${stats.otherCurrencyOut.map((o) => fmtMoney(o.amount, o.currency)).join(" + ")} in other currencies.` : ""}`}
                />
              </div>
            </div>
          )}

          {tab === "tarjetas" && (
            <div className="space-y-4 animate-tab-in">
              {netWorth.length > 0 && (
                <div className="card p-5 animate-scale-in">
                  <h3 className="label mb-3">AVAILABLE TO SPEND</h3>
                  <ul className="space-y-2 list-none">
                    {netWorth.map((nw) => (
                      <li key={nw.currency} className="flex justify-between items-baseline">
                        <span className="text-sm" style={{ color: "var(--muted)" }}>{nw.currency}</span>
                        <span className="text-xl font-extrabold animate-number-in">{fmtMoney(nw.total, nw.currency)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>Cash + cards, net of what you owe on each card.</p>
                </div>
              )}
              <ul className="space-y-2">
                {wallets.filter((w) => !w.archived).map((w, i) => {
                  const bal = grownBalanceByWallet.get(w.id!) ?? 0;
                  const ledgerBal = balanceByWallet.get(w.id!) ?? 0;
                  const interestEarned = w.roiAnnualPct ? roundCents(bal - ledgerBal) : 0;
                  const cashbackEarned = cashbackEarnedForWallet(w, cashbackByWallet);
                  const owes = w.kind === "card" && bal < 0;
                  const cutMs = w.corteDay != null ? lastCutDate(w.corteDay, new Date()).getTime() : null;
                  const paid = cutMs != null && w.id != null ? creditsSinceCut(w.id, allTransactions, cutMs) : 0;
                  const canAskRoi = w.kind !== "card" && w.roiAnnualPct == null && !w.roiAsked;
                  const canAskCashback = w.kind === "card" && w.cashbackPct == null && !w.cashbackAsked;
                  const canAskCorte = w.kind === "card" && w.corteDay == null && !w.corteAsked;
                  return (
                    <li key={w.id} className={`card p-4 animate-slide-up stagger-${Math.min(i + 1, 5)}`}>
                      <div className="flex items-center gap-3">
                        <span className="w-2.5 h-10 rounded-full shrink-0" style={{ background: w.color }} aria-hidden />
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm truncate">{w.name}{w.last4 ? <span className="font-mono font-medium" style={{ color: "var(--muted)" }}> ····{w.last4}</span> : null}</p>
                          <p className="text-[11px] capitalize" style={{ color: "var(--muted)" }}>{w.kind === "card" ? "Card" : w.kind} · {w.currency}{w.roiAnnualPct ? ` · growing ${w.roiAnnualPct}%/yr` : ""}{w.cashbackPct ? ` · ${w.cashbackPct}% cashback` : ""}</p>
                        </div>
                        <p className="font-extrabold text-base">{fmtMoney(bal, w.currency)}</p>
                      </div>
                      {interestEarned > 0 && (
                        <p className="text-[11px] mt-1 pl-[calc(0.625rem+0.75rem)]" style={{ color: "var(--muted)" }}>
                          +{fmtMoney(interestEarned, w.currency)} earned from interest
                        </p>
                      )}
                      {cashbackEarned > 0 && (
                        <p className="text-[11px] mt-1 pl-[calc(0.625rem+0.75rem)]" style={{ color: "var(--muted)" }}>
                          +{fmtMoney(cashbackEarned, w.currency)} earned from cashback
                        </p>
                      )}
                      {(w.cashbackOpening ?? 0) > 0 && !w.cashbackOpeningApplied && (
                        <ApplyCashbackOpeningBanner wallet={w} />
                      )}
                      {owes && (
                        <CardStatementSection card={w} owed={-bal} statement={statementAmount(w, allTransactions)} paidSinceCut={paid} wallets={wallets} />
                      )}
                      {canAskRoi && <RoiPrompt wallet={w} />}
                      {canAskCashback && <CashbackPrompt wallet={w} />}
                      {canAskCorte && <CortePrompt wallet={w} />}
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] px-1" style={{ color: "var(--muted)" }}>
                Balances = opening balance + income − expenses ± transfers, calculated on this phone.
                {wallets.some((w) => w.roiAnnualPct) ? " Interest-bearing accounts show a live projected value; it's a display estimate, not a posted transaction." : ""}
              </p>
              <CollapsibleSection id="cards-wallets" title="Cards and accounts" expanded={expanded.has("cards-wallets")} onToggle={() => toggleSection("cards-wallets")}>
                <WalletManager wallets={wallets} balances={grownBalanceByWallet} />
              </CollapsibleSection>
              <CollapsibleSection id="cards-categories" title="Categories and subcategories" expanded={expanded.has("cards-categories")} onToggle={() => toggleSection("cards-categories")}>
                <CategoryManager categories={categories} />
              </CollapsibleSection>
            </div>
          )}

          {tab === "presu" && (
            <div className="space-y-4 animate-tab-in">
              <div className="space-y-3">
                {budgetProgress.map(({ b, spent, pct }, i) => (
                  <div key={b.id} className={`card p-4 animate-slide-up stagger-${Math.min(i + 1, 5)}`}>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="font-semibold">{b.label}</span>
                      <span className={`font-bold ${pct > 100 ? "text-rose-500" : ""}`} style={pct <= 100 ? { color: "var(--accent)" } : {}}>{Math.round(pct)}%</span>
                    </div>
                    <Progress pct={pct} spent={spent} limit={b.limit} currency={b.currency} />
                  </div>
                ))}
                {budgets.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>Create your first budget below</p>}
              </div>
              <CollapsibleSection id="presu-budgets" title="Manage budgets" expanded={expanded.has("presu-budgets")} onToggle={() => toggleSection("presu-budgets")}>
                <BudgetManager budgets={budgets} categories={categories} wallets={wallets} />
              </CollapsibleSection>
            </div>
          )}

          {tab === "mas" && (
            <div className="space-y-4 animate-tab-in">
              <CollapsibleSection id="more-debts" title="Debts" expanded={expanded.has("more-debts")} onToggle={() => toggleSection("more-debts")}>
                <DebtManager debts={debts} wallets={wallets} />
              </CollapsibleSection>
              <CollapsibleSection id="more-recurring" title="Recurring" expanded={expanded.has("more-recurring")} onToggle={() => toggleSection("more-recurring")}>
                <RecurringManager items={recurring} wallets={wallets} categories={categories} />
              </CollapsibleSection>
              <CollapsibleSection id="more-settings" title="Settings and backup" expanded={expanded.has("more-settings")} onToggle={() => toggleSection("more-settings")}>
                <SettingsPanel wallets={wallets} categories={categories} txCount={allTransactions.length} dark={dark} setDark={setDark} />
              </CollapsibleSection>
              <p className="text-center text-[11px] pb-4" style={{ color: "var(--muted)" }}>Blink · your data stays on this phone</p>
            </div>
          )}
        </main>

        <nav aria-label="Main" className="pb-safe fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md glass-nav">
          <div className="flex items-end justify-around px-3 pt-2 pb-2">
            {tabs.map((t) =>
              t.id === "inicio" ? (
                <div key={t.id} className="flex flex-col items-center -mt-5">
                  <button
                    onClick={openManualAdd}
                    className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg transition-transform active:scale-95 animate-glow-pulse"
                    style={{ background: "var(--accent)" }}
                    aria-label="Log expense"
                  >
                    <Plus size={24} strokeWidth={2.5} />
                  </button>
                  <button onClick={() => setTab("inicio")} aria-current={tab === "inicio" ? "page" : undefined} className="text-[10px] font-semibold mt-0.5 min-h-[28px]" style={{ color: tab === "inicio" ? "var(--accent)" : "var(--muted)" }}>
                    Home
                  </button>
                  {tab === "inicio" && <span className="nav-dot mt-0.5" />}
                </div>
              ) : (
                <button key={t.id} onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined} className="flex flex-col items-center gap-0.5 py-1 text-[10px] font-semibold min-h-[44px] justify-center transition-colors" style={{ color: tab === t.id ? "var(--accent)" : "var(--muted)" }}>
                  <span className="p-1.5 rounded-xl transition-all" style={tab === t.id ? { background: "var(--accent-light)" } : {}} aria-hidden>{t.icon}</span>
                  {t.label}
                  {tab === t.id && <span className="nav-dot" />}
                </button>
              )
            )}
          </div>
        </nav>

        {toast && (
          <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2.5rem)] max-w-sm px-4 py-3.5 rounded-2xl text-sm font-semibold text-center shadow-xl animate-toast-in" style={{ background: "var(--card)", border: "1px solid var(--card-border)", boxShadow: "var(--card-shadow), 0 8px 32px rgba(0,0,0,0.12)" }}>
            {toast}
          </div>
        )}

        {(showAdd || editTx) && (
          <QuickAdd
            wallets={wallets}
            categories={categories}
            defaultCurrency="MXN"
            initialType={editTx?.type as import("@/lib/db").TxType | undefined}
            initialAmount={editTx ? String(editTx.amount) : undefined}
            initialWalletId={editTx?.walletId}
            initialToWalletId={editTx?.toWalletId}
            initialCategoryId={editTx?.categoryId}
            initialNote={editTx?.note}
            initialDate={editTx?.date}
            editingTx={editTx?.id != null ? { id: editTx.id, image: editTx.image, cashbackEarned: editTx.cashbackEarned } : undefined}
            onClose={() => { setShowAdd(false); setEditTx(null); }}
            onSaved={() => { setTab("inicio"); setEditTx(null); }}
          />
        )}

      </div>
    </div>
  );
}
