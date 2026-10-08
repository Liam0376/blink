"use client";

import { memo, useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { Plus, Trash2, Archive, Pencil, ChevronDown, RefreshCw } from "lucide-react";
import { db, type Budget, type Category, type Currency, type Debt, type Recurring, type Transaction, type Wallet } from "@/lib/db";
import { CURRENCIES, currencyOptionsFor, daysSince, exportJSON, fmtMoney, importJSON, parseBackup, parseTransactionsCSV, prettyDay, roundCents, sanitizeAmountInput, transactionsToCSV } from "@/lib/format";
import { auditBooks, type AuditIssue } from "@/lib/audit";
import { cashbackCreditTransaction, computeBalances, computeCashback } from "@/lib/balances";
import { browserKV } from "@/lib/shortcut";
import { assignColor } from "@/lib/palette";
import { advanceRecurringPastNow } from "@/lib/stats";
import { newId } from "@/lib/sync/ids";

/** Reusable disclosure wrapper: tappable header row + collapsible body
 *  (button with aria-expanded/aria-controls, body with matching id). */
export function CollapsibleSection({
  id,
  title,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  title: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={id}
        className="w-full flex items-center justify-between gap-2 py-2 min-h-[44px] text-left press"
      >
        <span className="font-bold text-sm">{title}</span>
        <ChevronDown
          size={16}
          aria-hidden
          className={`shrink-0 transition-transform`}
          style={{ color: "var(--muted)" }}
        />
      </button>
      {expanded && <div id={id} className="animate-slide-up">{children}</div>}
    </div>
  );
}

export const TransactionList = memo(function TransactionList({
  txs,
  wallets,
  categories,
  onEdit,
}: {
  txs: { id?: string; type: string; amount: number; currency: Currency; walletId: string; toWalletId?: string; categoryId?: string; note?: string; date: string; image?: string; cashbackEarned?: number; createdAt: string }[];
  wallets: Wallet[];
  categories: Category[];
  onEdit?: (tx: { id?: string; type: string; amount: number; currency: Currency; walletId: string; toWalletId?: string; categoryId?: string; note?: string; date: string; image?: string; cashbackEarned?: number; createdAt: string }) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  // One clock read for the whole list. Calling Date.now() per row is impure
  // during render, and rows disagreeing about "now" would be worse.
  const [nowMs] = useState(() => Date.now());
  const wById = new Map(wallets.map((w) => [w.id, w]));
  const cById = new Map(categories.map((c) => [c.id, c]));
  if (txs.length === 0)
    return <p className="text-sm text-center py-8" style={{ color: "var(--muted)" }}>No transactions yet. Tap + to log your first in 3 seconds.</p>;
  return (
    <>
    {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 font-semibold px-4 py-2">{error}</p>}
    <ul className="card px-4 animate-slide-up">
      {txs.map((t) => {
        const w = wById.get(t.walletId);
        const c = t.categoryId != null ? cById.get(t.categoryId) : undefined;
        const sign = t.type === "expense" ? "-" : t.type === "income" ? "+" : "⇄";
        const isTransfer = t.type === "transfer";
        const primaryLabel = isTransfer
          ? `Transfer ${w?.name ?? "(deleted account)"} → ${wById.get(t.toWalletId ?? "")?.name ?? "(deleted account)"}`
          : (t.note || c?.name || (t.type === "income" ? "Income" : "Expense"));
        const secondaryParts = [
          !isTransfer && t.note && c?.name ? c.name : null,
          `${w?.name ?? "(deleted account)"}${w?.last4 ? ` •${w.last4}` : ""}`,
          new Date(t.date).toLocaleString("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
        ].filter(Boolean).join(" · ");
        // Dated ahead of today: it is in the ledger but deliberately kept out
        // of the balance, so say so rather than let it look like a bug.
        const isFuture = new Date(t.date).getTime() > nowMs;
        return (
          <li key={t.id} className="tx-row" onClick={() => onEdit?.(t)} style={onEdit ? { cursor: "pointer" } : undefined}>
            <span className="w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0" style={{ background: "var(--surface)" }} aria-hidden>
              {isTransfer ? "⇄" : (c?.icon ?? (t.type === "income" ? "💰" : "💸"))}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold truncate">
                {primaryLabel}
                {isFuture && (
                  <span className="ml-1.5 text-[10px] font-bold text-amber-600 dark:text-amber-400" title="Dated in the future — not counted in the balance yet">
                    SCHEDULED
                  </span>
                )}
              </p>
              <p className="text-[11px] truncate" style={{ color: "var(--muted)" }}>
                {secondaryParts}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[13px] font-bold" style={{ color: t.type === "expense" ? "#e11d48" : t.type === "income" ? "var(--accent)" : "#0284c7" }}>
                {sign}{fmtMoney(t.amount, t.currency)}
              </p>
              <button
                className="text-[11px] min-h-[32px] px-1"
                style={{ color: "var(--muted)" }}
                aria-label={`Delete: ${primaryLabel} ${fmtMoney(t.amount, t.currency)}`}
                onClick={async () => {
                  if (t.id != null && confirm("Delete this transaction? This can't be undone.")) {
                    try {
                      await db.transactions.delete(t.id);
                      setError(null);
                    } catch {
                      setError("Couldn't delete. Close and reopen the app, then try again.");
                    }
                  }
                }}
              >
                delete
              </button>
            </div>
          </li>
        );
      })}
    </ul>
    </>
  );
});

export function WalletManager({ wallets, balances }: { wallets: Wallet[]; balances?: Map<string, number> }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Wallet["kind"]>("cash");
  const [last4, setLast4] = useState("");
  const [currencySel, setCurrencySel] = useState<string>("MXN");
  const [customCurrency, setCustomCurrency] = useState("");
  const [opening, setOpening] = useState("");
  const [hasRoi, setHasRoi] = useState(false);
  const [roiPct, setRoiPct] = useState("");
  const [hasDueDay, setHasDueDay] = useState(false);
  const [dueDay, setDueDay] = useState("");
  const [hasCorte, setHasCorte] = useState(false);
  const [corteDay, setCorteDay] = useState("");
  const [hasCashback, setHasCashback] = useState(false);
  const [cashbackPctStr, setCashbackPctStr] = useState("");
  const [cashbackOpeningStr, setCashbackOpeningStr] = useState("");
  const [editing, setEditing] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function resetForm() {
    setName(""); setKind("cash"); setLast4(""); setOpening(""); setCurrencySel("MXN"); setCustomCurrency("");
    setHasRoi(false); setRoiPct(""); setHasDueDay(false); setDueDay(""); setHasCorte(false); setCorteDay(""); setHasCashback(false); setCashbackPctStr(""); setCashbackOpeningStr("");
  }

  async function save() {
    setError(null);
    if (!name.trim()) {
      setError("Enter a name, e.g. Visa debit");
      return;
    }
    let finalCurrency = currencySel;
    if (!editing && currencySel === "OTHER") {
      const code = customCurrency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        setError("Enter a valid 3-letter currency code, e.g. GBP");
        return;
      }
      finalCurrency = code;
    }
    if (editing?.id && kind !== editing.kind) {
      // Switching type drops what the new type can't hold (interest rate
      // on a card, cashback rate off a card) — confirm, don't surprise.
      const dropping: string[] = [];
      if (kind === "card" && editing.roiAnnualPct != null) dropping.push(`interest rate (${editing.roiAnnualPct}%/yr)`);
      if (kind !== "card" && editing.cashbackPct != null) dropping.push(`cashback rate (${editing.cashbackPct}%)`);
      if (dropping.length > 0 && !confirm(`Switching "${editing.name}" to ${kind} will drop its ${dropping.join(" and ")} (already-earned cashback baseline is kept). Continue?`)) return;
    }
    const roiNum = Number(roiPct);
    const roiAnnualPct = kind !== "card" && hasRoi && Number.isFinite(roiNum) && roiNum > 0 ? roiNum : undefined;
    const dueDayNum = kind === "card" && hasDueDay && Number(dueDay) >= 1 && Number(dueDay) <= 31 ? Number(dueDay) : undefined;
    const corteDayNum = kind === "card" && hasCorte && Number(corteDay) >= 1 && Number(corteDay) <= 31 ? Number(corteDay) : undefined;
    const cbNum = Number(cashbackPctStr);
    const cashbackPct = kind === "card" && hasCashback && Number.isFinite(cbNum) && cbNum > 0 ? cbNum : undefined;
    const cbOpenNum = Number(cashbackOpeningStr);
    const cashbackOpening = kind === "card" && hasCashback && Number.isFinite(cbOpenNum) && cbOpenNum > 0 ? cbOpenNum : undefined;
    // Once posted as a transaction the baseline is frozen; changing it here
    // would make the card's total disagree with the balance.
    if (editing?.cashbackOpeningApplied && cashbackOpening !== editing.cashbackOpening) {
      setError("This card's cashback baseline has already been posted, so it can't change.");
      return;
    }
    // For a card, "opening balance" is entered as a positive "amount owed" —
    // store it negative so it correctly reduces (not inflates) net worth.
    // Non-card wallets keep the raw signed value (what's actually in them).
    const openingNum = Number(opening);
    const openingRaw = kind === "card" ? -Math.abs(Number.isFinite(openingNum) ? openingNum : 0) : Number.isFinite(openingNum) ? openingNum : 0;
    const openingBalance = roundCents(openingRaw);
    const color = editing?.color ?? assignColor(wallets.map((w) => w.color));
    try {
      if (editing?.id) {
        // Only bump roiRateSince when the rate actually changed — an
        // unrelated edit (name, due day, ...) must not reset the growth
        // anchor. See computeGrownBalances in lib/balances.ts.
        // Re-read the row first: a Roi/Cashback prompt answered after this
        // form was opened would otherwise be clobbered by the stale
        // snapshot — fields untouched in this form keep the live values.
        const fresh = await db.wallets.get(editing.id).catch(() => undefined);
        const roiChanged = roiAnnualPct !== editing.roiAnnualPct;
        const roiRateSince = roiChanged
          ? (roiAnnualPct ? new Date().toISOString() : undefined)
          : (fresh?.roiRateSince ?? editing.roiRateSince);
        await db.wallets.update(editing.id, {
          name: name.trim().slice(0, 40),
          kind,
          last4: last4 || undefined,
          // La moneda se fija al crear: cambiarla re-etiquetaría todo el historial.
          openingBalance,
          roiAnnualPct: roiChanged ? roiAnnualPct : (fresh?.roiAnnualPct ?? roiAnnualPct),
          roiRateSince,
          dueDay: dueDayNum !== editing.dueDay ? dueDayNum : (fresh?.dueDay ?? dueDayNum),
          corteDay: corteDayNum !== editing.corteDay ? corteDayNum : (fresh?.corteDay ?? corteDayNum),
          cashbackPct: cashbackPct !== editing.cashbackPct ? cashbackPct : (fresh?.cashbackPct ?? cashbackPct),
          // Ending the promo (unchecking the box) must not wipe the
          // already-earned baseline unless the field itself was edited —
          // the displayed total would otherwise drop with no undo.
          cashbackOpening: cashbackOpeningStr !== (editing.cashbackOpening ? String(editing.cashbackOpening) : "")
            ? cashbackOpening
            : (fresh?.cashbackOpening ?? editing.cashbackOpening),
        });
      } else {
        await db.wallets.add({
          id: newId(),
          name: name.trim().slice(0, 40),
          kind,
          last4: last4 || undefined,
          color,
          currency: finalCurrency,
          openingBalance,
          openingDate: new Date().toISOString(),
          roiAnnualPct,
          roiRateSince: roiAnnualPct ? new Date().toISOString() : undefined,
          dueDay: dueDayNum,
          corteDay: corteDayNum,
          cashbackPct,
          cashbackOpening,
          createdAt: new Date().toISOString(),
        });
      }
      resetForm(); setEditing(null); setShowForm(false);
    } catch {
      setError("Couldn't save the account.");
    }
  }

  function cancelEdit() {
    setEditing(null); resetForm(); setError(null); setShowForm(false);
  }

  async function toggleArchive(w: Wallet) {
    if (w.id == null) return;
    if (!w.archived) {
      // Archiving hides the wallet from "Available to spend" — warn when
      // it still holds money so it doesn't read as vanished funds.
      let bal = 0;
      try {
        const [out, inc] = await Promise.all([
          db.transactions.where("walletId").equals(w.id).toArray(),
          db.transactions.filter((t) => t.toWalletId === w.id).toArray(),
        ]);
        bal = computeBalances([{ id: w.id, openingBalance: w.openingBalance }], [...out, ...inc]).get(w.id) ?? 0;
      } catch {
        setError("Couldn't check the balance. Close and reopen the app, then try again.");
        return;
      }
      if (Math.abs(bal) >= 0.01 && !confirm(`"${w.name}" still holds ${fmtMoney(bal, w.currency)}. Archiving hides it from "Available to spend" — nothing is deleted, unarchive anytime to restore. Continue?`)) return;
    }
    db.wallets.update(w.id, { archived: !w.archived }).catch(() => setError("Couldn't archive. Try again."));
  }

  async function remove(w: Wallet) {
    if (w.id == null) return;
    const countRefs = async () => {
      const [txCount, recCount] = await Promise.all([
        db.transactions.where("walletId").equals(w.id!).count(),
        db.recurring.where("walletId").equals(w.id!).count(),
      ]);
      return txCount + recCount + await db.transactions.filter((t) => t.toWalletId === w.id).count();
    };
    let refs = 0;
    try {
      refs = await countRefs();
    } catch {
      setError("Couldn't check the linked transactions. Close and reopen the app, then try again.");
      return;
    }
    if (refs > 0) {
      setError(`"${w.name}" has ${refs} linked transaction(s). Archive it instead — orphaned transactions would throw off your balances.`);
      return;
    }
    if (!confirm(`Delete "${w.name}"? It has no transactions.`)) return;
    try {
      await db.transaction("rw", [db.wallets, db.transactions, db.recurring], async () => {
        // Re-check inside the write transaction: a save in another tab may
        // have landed between the check and the confirm.
        if ((await countRefs()) > 0) throw new Error("referenced");
        await db.wallets.delete(w.id!);
      });
    } catch (err) {
      setError(err instanceof Error && err.message === "referenced"
        ? `"${w.name}" gained linked transactions just now — archive it instead.`
        : "Couldn't delete.");
    }
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {wallets.map((w) => (
          <li key={w.id} className="flex items-center gap-3 p-3 rounded-2xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none">
            <span className="w-3 h-10 rounded-full" style={{ background: w.color }} aria-hidden />
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm">{w.name} {w.archived ? "(archived)" : ""}</p>
              <p className="text-[11px] text-zinc-500 capitalize">{w.kind}{w.last4 ? ` •${w.last4}` : ""} · {w.currency}{(() => { const bal = balances?.get(w.id!) ?? w.openingBalance ?? 0; return bal !== 0 ? (w.kind === "card" && bal < 0 ? ` · owes ${fmtMoney(Math.abs(bal), w.currency)}` : ` · ${fmtMoney(bal, w.currency)}`) : ""; })()}{w.roiAnnualPct ? ` · ${w.roiAnnualPct}%/yr` : ""}{w.dueDay ? ` · due day ${w.dueDay}` : ""}{w.corteDay ? ` · cuts day ${w.corteDay}` : ""}{w.cashbackPct ? ` · ${w.cashbackPct}% cashback` : ""}</p>
            </div>
            <button className="p-2.5 text-zinc-500 dark:text-zinc-400 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label={`Edit ${w.name}`} onClick={() => { setEditing(w); setName(w.name); setKind(w.kind); setLast4(w.last4 ?? ""); setCurrencySel(w.currency); setCustomCurrency(""); setOpening(String(w.kind === "card" ? Math.abs(w.openingBalance ?? 0) : (w.openingBalance ?? 0))); setHasRoi(!!w.roiAnnualPct); setRoiPct(w.roiAnnualPct ? String(w.roiAnnualPct) : ""); setHasDueDay(!!w.dueDay); setDueDay(w.dueDay ? String(w.dueDay) : ""); setHasCorte(!!w.corteDay); setCorteDay(w.corteDay ? String(w.corteDay) : ""); setHasCashback(!!w.cashbackPct); setCashbackPctStr(w.cashbackPct ? String(w.cashbackPct) : ""); setCashbackOpeningStr(w.cashbackOpening ? String(w.cashbackOpening) : ""); setShowForm(true); }}>
              <Pencil size={15} />
            </button>
            <button className="p-2.5 text-zinc-500 dark:text-zinc-400 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label={w.archived ? `Unarchive ${w.name}` : `Archive ${w.name}`} onClick={() => toggleArchive(w)}>
              <Archive size={15} />
            </button>
            <button className="p-2.5 text-zinc-500 dark:text-zinc-400 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label={`Delete ${w.name}`} onClick={() => remove(w)}>
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
      {!showForm ? (
        <button onClick={() => { setEditing(null); setError(null); setShowForm(true); }} aria-expanded={false} aria-controls="wallet-form" className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold flex items-center justify-center gap-1 min-h-[44px]">
          <Plus size={15} /> Add card / account
        </button>
      ) : (
      <div id="wallet-form" className="p-3 rounded-2xl bg-zinc-50 dark:bg-zinc-900 space-y-2">
        <p className="text-xs font-bold text-zinc-500">{editing ? "EDIT CARD / ACCOUNT" : "NEW CARD / ACCOUNT"}</p>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="E.g. Visa debit (name only, never the full number)" aria-label="Account or card name" className="w-full rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm outline-none min-h-[44px]" />
        <div className="flex gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as Wallet["kind"])} aria-label="Account type" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]">
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="bank">Bank</option>
            <option value="other">Other</option>
          </select>
          <input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Last 4" inputMode="numeric" aria-label="Last 4 digits" className="w-24 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]" />
          <select value={editing ? currencySel : (CURRENCIES.includes(currencySel) ? currencySel : "OTHER")} onChange={(e) => setCurrencySel(e.target.value)} disabled={editing != null} title={editing ? "Currency is fixed at creation so history isn't relabeled" : "Currency"} aria-label="Currency" className="w-24 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px] disabled:opacity-50">
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            {editing
              ? (!CURRENCIES.includes(currencySel) && currencySel ? <option value={currencySel}>{currencySel}</option> : null)
              : <option value="OTHER">Other…</option>}
          </select>
        </div>
        {!editing && currencySel === "OTHER" && (
          <input value={customCurrency} onChange={(e) => setCustomCurrency(e.target.value.toUpperCase())} maxLength={3} placeholder="E.g. GBP" aria-label="Currency code (3 letters)" className="w-full rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm outline-none min-h-[44px] uppercase" />
        )}
        <div className="space-y-1">
          <label htmlFor="wm-opening" className="text-xs text-zinc-500">
            {kind === "card" ? "Amount currently owed (0 if none)" : `Opening balance${editing ? "" : " (what's in it today)"}`}
          </label>
          <input
            id="wm-opening"
            value={opening}
            onChange={(e) => setOpening(sanitizeAmountInput(e.target.value, { allowNegative: kind !== "card" }))}
            inputMode="decimal"
            placeholder="0"
            className="w-full rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px]"
          />
        </div>
        {kind === "card" && <p className="text-[11px] text-zinc-500 -mt-1">Entered as a positive number — it&apos;s automatically counted as debt, reducing your total.</p>}
        {kind !== "card" && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={hasRoi} onChange={(e) => setHasRoi(e.target.checked)} className="w-4 h-4" />
              This account earns interest
            </label>
            {hasRoi && (
              <div className="flex items-center gap-2">
                <label htmlFor="wm-roi" className="text-xs text-zinc-500 shrink-0">Annual rate (%)</label>
                <input id="wm-roi" value={roiPct} onChange={(e) => setRoiPct(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="e.g. 13" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px] disabled:opacity-60" />
              </div>
            )}
          </div>
        )}
        {kind === "card" && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={hasDueDay} onChange={(e) => setHasDueDay(e.target.checked)} className="w-4 h-4" />
              Remind me when the statement is due
            </label>
            {hasDueDay && (
              <div className="flex items-center gap-2">
                <label htmlFor="wm-dueday" className="text-xs text-zinc-500 shrink-0">Due day of month</label>
                <input id="wm-dueday" value={dueDay} onChange={(e) => setDueDay(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" placeholder="1-31" className="w-20 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px]" />
              </div>
            )}
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={hasCorte} onChange={(e) => setHasCorte(e.target.checked)} className="w-4 h-4" />
              My statements cut on a fixed day
            </label>
            {hasCorte && (
              <div className="flex items-center gap-2">
                <label htmlFor="wm-corteday" className="text-xs text-zinc-500 shrink-0">Cut day of month</label>
                <input id="wm-corteday" value={corteDay} onChange={(e) => setCorteDay(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" placeholder="1-31" className="w-20 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px]" />
              </div>
            )}
            {hasCorte && (
              <p className="text-[11px] text-zinc-500 -mt-1">Charges from the cut day on go to the next cycle — the payoff pre-fills with the last statement&apos;s charges.</p>
            )}
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={hasCashback} onChange={(e) => setHasCashback(e.target.checked)} className="w-4 h-4" />
              This card gives cashback
            </label>
            {hasCashback && (
              <div className="flex items-center gap-2">
                <label htmlFor="wm-cashback" className="text-xs text-zinc-500 shrink-0">Cashback rate (%)</label>
                <input id="wm-cashback" value={cashbackPctStr} onChange={(e) => setCashbackPctStr(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="e.g. 2" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px] disabled:opacity-60" />
              </div>
            )}
            {hasCashback && (
              <div className="flex items-center gap-2">
                <label htmlFor="wm-cashback-opening" className="text-xs text-zinc-500 shrink-0">Already earned (optional)</label>
                <input id="wm-cashback-opening" value={cashbackOpeningStr} disabled={!!editing?.cashbackOpeningApplied} onChange={(e) => setCashbackOpeningStr(sanitizeAmountInput(e.target.value, { allowNegative: false }))} inputMode="decimal" placeholder="0" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px] disabled:opacity-60" />
              </div>
            )}
            {hasCashback && Number(cashbackPctStr) > 0 && (
              <p className="text-[11px] text-zinc-500">Rate applies to purchases logged from now on, and is credited back to this card automatically — it won&apos;t rewrite cashback already earned, or change if you edit this rate later. Use &quot;Already earned&quot; to set your starting point (e.g. from a real statement); you&apos;ll get an &quot;Apply to balance&quot; option in the Cards tab to credit it once.</p>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
        <button onClick={save} className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold flex items-center justify-center gap-1 min-h-[44px]">
          <Plus size={15} /> {editing ? "Save changes" : "Add"}
        </button>
        <button onClick={cancelEdit} className="w-full text-xs text-zinc-500 min-h-[44px]">cancel</button>
      </div>
      )}
    </div>
  );
}

/** Per-card debt breakdown with payoff, shown for any card carrying a
 * balance owed. Rows: statement due (the bank's fixed amount as of the
 * last cut, see statementAmount in lib/balances.ts — or the full owed
 * balance when no cut day is set), paid toward it (credits logged since
 * the cut, see creditsSinceCut — the billed statement never moves, only
 * the remaining shrinks), next cycle so far (post-cut activity net of
 * payments, a preview of the coming statement, not bank truth), and owes
 * now (full ledger balance). Once the statement is fully paid the billed
 * rows collapse away, leaving next-cycle + owes. Pay opens the transfer
 * form with the remaining pre-filled and editable (partial payment = one
 * keystroke), capped at owed. The payoff is a real Transfer (source
 * wallet -> card), so it nets to zero in Available to spend — the same
 * money just moves from one wallet to another that's already counted,
 * it doesn't get subtracted twice. */
export function CardStatementSection({ card, owed, statement, paidSinceCut, wallets }: { card: Wallet; owed: number; statement?: number; paidSinceCut?: number; wallets: Wallet[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sources = wallets.filter((w) => !w.archived && w.id !== card.id && w.currency === card.currency);
  const [sourceId, setSourceId] = useState<string>(() => String(sources[0]?.id ?? ""));
  // Statement pre-fill: the bank fixed this amount at the cut, so it's the
  // natural default — clamped to owed (older payments may have brought the
  // balance below the billed amount) so it never fails the cap in pay().
  const [amount, setAmount] = useState<string>(() => String(Math.min(statement ?? owed, owed)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    if (busy) return;
    const source = sources.find((w) => String(w.id) === sourceId);
    if (!source || card.id == null || source.id == null) {
      setError("Pick an account to pay from.");
      return;
    }
    const amt = roundCents(Number(sanitizeAmountInput(amount)));
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter how much to pay.");
      return;
    }
    if (amt > owed) {
      setError(`That's more than ${card.name} owes (${fmtMoney(owed, card.currency)}).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      await db.transactions.add({
        id: newId(),
        type: "transfer",
        amount: amt,
        currency: card.currency,
        walletId: source.id,
        toWalletId: card.id,
        note: `${card.name} statement payoff`,
        date: now,
        createdAt: now,
      });
      setOpen(false);
    } catch {
      setError("Couldn't log the payoff. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Next cycle so far: post-cut charges net of post-cut payments. A
  // preview of the coming statement, not bank truth (interest, MSI
  // capital, and late-posting charges only exist on the real statement).
  // Paid since cut shrinks only the remaining — the billed statement is
  // what the bank fixed, it never moves.
  const billed = statement ?? owed;
  const paid = paidSinceCut ?? 0;
  const remaining = statement != null ? Math.max(0, roundCents(billed - paid)) : owed;
  const nextCycle = statement != null ? roundCents(owed - billed) : 0;
  const prefill = String(remaining > 0 ? Math.min(remaining, owed) : owed);

  if (!open) {
    const settled = statement != null && remaining <= 0;
    // Paid-off cards go neutral: rose reads as emergency, and a settled
    // statement isn't one. Unpaid keeps the rose tint.
    const box = settled ? "bg-zinc-100 dark:bg-zinc-800" : "bg-rose-50 dark:bg-rose-950";
    const accent = settled ? "text-zinc-600 dark:text-zinc-300" : "text-rose-600 dark:text-rose-400";
    if (!expanded) {
      return (
        <button
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          className={`w-full mt-3 px-3 py-2 rounded-xl text-xs font-bold min-h-[44px] flex items-center justify-between gap-2 ${box} ${accent}`}
        >
          <span>{settled ? `Statement paid · owes ${fmtMoney(owed, card.currency)}` : `Statement ${fmtMoney(billed, card.currency)} due`}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      );
    }
    return (
      <div className={`w-full mt-3 rounded-xl px-3 py-2 space-y-0.5 ${box}`}>
        <button onClick={() => setExpanded(false)} aria-expanded={true} aria-label="Collapse statement breakdown" className="w-full flex items-center justify-between gap-2 min-h-[32px]">
          <span className={`text-[11px] font-semibold ${accent}`}>{settled ? "Statement paid." : "Statement breakdown"}</span>
          <ChevronDown size={14} className={`shrink-0 rotate-180 ${accent}`} />
        </button>
        {!settled && (
          <div className="flex items-baseline justify-between gap-2">
            <p className={`text-[11px] font-semibold ${accent}`}>{statement != null ? "Statement due" : "Owes"}</p>
            <p className={`text-sm font-extrabold ${accent}`}>{fmtMoney(billed, card.currency)}</p>
          </div>
        )}
        {!settled && paid > 0 && (
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[11px]" style={{ color: "var(--muted)" }}>Paid toward it</p>
            <p className="text-xs font-bold" style={{ color: "var(--muted)" }}>{fmtMoney(paid, card.currency)}</p>
          </div>
        )}
        {!settled && statement != null && (
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[11px]" style={{ color: "var(--muted)" }}>Remaining</p>
            <p className="text-xs font-bold" style={{ color: "var(--muted)" }}>{fmtMoney(remaining, card.currency)}</p>
          </div>
        )}
        {statement != null && (
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[11px]" style={{ color: "var(--muted)" }}>Next cycle so far</p>
            <p className="text-xs font-bold" style={{ color: "var(--muted)" }}>{fmtMoney(nextCycle, card.currency)}</p>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[11px]" style={{ color: "var(--muted)" }}>Owes now</p>
          <p className="text-xs font-bold" style={{ color: "var(--muted)" }}>{fmtMoney(owed, card.currency)}</p>
        </div>
        <button
          onClick={() => { setAmount(prefill); setOpen(true); }}
          className="w-full mt-1 py-2 rounded-lg text-xs font-bold bg-rose-600 dark:bg-rose-400 text-white dark:text-black min-h-[44px]"
        >
          Pay {fmtMoney(Number(prefill), card.currency)}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-3 p-3 rounded-xl bg-zinc-50 dark:bg-zinc-900 space-y-2">
      <p className="text-xs font-semibold">Pay {card.name} from:</p>
      <div className="flex items-center gap-2">
        <label htmlFor={`cpb-amount-${card.id}`} className="text-xs text-zinc-500 shrink-0">Amount</label>
        <input id={`cpb-amount-${card.id}`} value={amount} onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))} inputMode="decimal" placeholder="e.g. 500" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 bg-transparent px-3 py-2.5 text-sm min-h-[44px]" />
      </div>
      <p className="text-[11px] text-zinc-500 -mt-1">
        {statement != null
          ? `Pre-filled with what's left of the statement (${fmtMoney(remaining, card.currency)}). Edit to pay part of it.`
          : "Pre-filled with the full balance owed. Edit to pay part of it, or set a cut day for statement amounts."}
      </p>
      {sources.length === 0 ? (
        <p className="text-xs text-rose-600 dark:text-rose-400">No other {card.currency} account to pay from. Add one first.</p>
      ) : (
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Pay from account" className="w-full rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 bg-transparent px-3 py-2.5 text-sm min-h-[44px]">
          {sources.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.currency}</option>)}
        </select>
      )}
      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
      <div className="flex gap-2">
        <button onClick={pay} disabled={busy || sources.length === 0} className="flex-1 py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold min-h-[44px] disabled:opacity-50">
          {busy ? "Paying…" : "Confirm payoff"}
        </button>
        <button onClick={() => { setOpen(false); setError(null); }} className="px-4 text-xs text-zinc-500 min-h-[44px]">cancel</button>
      </div>
    </div>
  );
}

/** Actively asks — once — whether a non-card wallet earns interest, instead
 * of leaving ROI buried behind Edit. Answering "no" still records roiAsked
 * so it doesn't nag again; answering "yes" asks for the rate right there. */
export function RoiPrompt({ wallet }: { wallet: Wallet }) {
  const [asking, setAsking] = useState(false);
  const [pct, setPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answerNo() {
    if (wallet.id == null) return;
    try {
      await db.wallets.update(wallet.id, { roiAsked: true });
    } catch {
      /* non-fatal — will just ask again next visit */
    }
  }

  async function confirmYes() {
    const n = Number(pct);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a rate above 0, e.g. 13");
      return;
    }
    if (wallet.id == null) return;
    setBusy(true);
    setError(null);
    try {
      await db.wallets.update(wallet.id, {
        roiAnnualPct: n,
        // Re-anchoring without a rate change would forget the interest already
        // accrued since the old anchor and drop the displayed balance.
        roiRateSince: n === wallet.roiAnnualPct ? wallet.roiRateSince : new Date().toISOString(),
        roiAsked: true,
      });
    } catch {
      setError("Couldn't save. Try again.");
      setBusy(false);
    }
  }

  if (!asking) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <p className="flex-1 text-xs" style={{ color: "var(--muted)" }}>Does {wallet.name} earn interest?</p>
        <button onClick={() => setAsking(true)} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px]" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>Yes</button>
        <button onClick={answerNo} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px]" style={{ background: "var(--surface)", color: "var(--muted)" }}>No</button>
      </div>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-2">
      <label htmlFor={`roi-ask-${wallet.id}`} className="sr-only">Annual interest rate for {wallet.name}</label>
      <input id={`roi-ask-${wallet.id}`} value={pct} onChange={(e) => setPct(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="% per year, e.g. 13" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 bg-transparent px-3 py-2 text-sm min-h-[36px]" />
      <button onClick={confirmYes} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px] disabled:opacity-50" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>{busy ? "…" : "Save"}</button>
      {error && <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-400 font-semibold w-full">{error}</p>}
    </div>
  );
}

/** Actively asks — once — whether a card gives cashback, mirroring
 * RoiPrompt. Answering "no" records cashbackAsked so it doesn't nag again;
 * answering "yes" asks for the rate right there. The rate only applies to
 * purchases logged from now on (see computeCashback in lib/balances.ts) —
 * it never rewrites cashback already earned on past purchases. */
export function CashbackPrompt({ wallet }: { wallet: Wallet }) {
  const [asking, setAsking] = useState(false);
  const [pct, setPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answerNo() {
    if (wallet.id == null) return;
    try {
      await db.wallets.update(wallet.id, { cashbackAsked: true });
    } catch {
      /* non-fatal — will just ask again next visit */
    }
  }

  async function confirmYes() {
    const n = Number(pct);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a rate above 0, e.g. 2");
      return;
    }
    if (wallet.id == null) return;
    setBusy(true);
    setError(null);
    try {
      await db.wallets.update(wallet.id, { cashbackPct: n, cashbackAsked: true });
    } catch {
      setError("Couldn't save. Try again.");
      setBusy(false);
    }
  }

  if (!asking) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <p className="flex-1 text-xs" style={{ color: "var(--muted)" }}>Does {wallet.name} give cashback?</p>
        <button onClick={() => setAsking(true)} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px]" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>Yes</button>
        <button onClick={answerNo} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px]" style={{ background: "var(--surface)", color: "var(--muted)" }}>No</button>
      </div>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-2">
      <label htmlFor={`cashback-ask-${wallet.id}`} className="sr-only">Cashback rate for {wallet.name}</label>
      <input id={`cashback-ask-${wallet.id}`} value={pct} onChange={(e) => setPct(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="% per purchase, e.g. 2" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 bg-transparent px-3 py-2 text-sm min-h-[36px]" />
      <button onClick={confirmYes} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px] disabled:opacity-50" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>{busy ? "…" : "Save"}</button>
      {error && <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-400 font-semibold w-full">{error}</p>}
    </div>
  );
}

/** Actively asks — once — when a card's statements cut, mirroring
 * CashbackPrompt. The cut day drives per-cycle statement amounts (see
 * statementAmount in lib/balances.ts) and a charge logged ON it starts
 * the next cycle; the due day is informational. Declining records
 * corteAsked so it doesn't nag again. */
export function CortePrompt({ wallet }: { wallet: Wallet }) {
  const [asking, setAsking] = useState(false);
  const [corte, setCorte] = useState("");
  const [due, setDue] = useState(() => (wallet.dueDay ? String(wallet.dueDay) : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answerNo() {
    if (wallet.id == null) return;
    try {
      await db.wallets.update(wallet.id, { corteAsked: true });
    } catch {
      /* non-fatal — will just ask again next visit */
    }
  }

  async function save() {
    const c = Number(corte);
    if (!Number.isFinite(c) || c < 1 || c > 31) {
      setError("Enter a cut day of 1-31");
      return;
    }
    const d = due.trim() === "" ? undefined : Number(due);
    if (d != null && (!Number.isFinite(d) || d < 1 || d > 31)) {
      setError("Due day must be 1-31, or leave it empty");
      return;
    }
    if (wallet.id == null) return;
    // Only write dueDay when the user typed one — an empty field must not
    // wipe a due day set earlier in the edit form.
    const patch: Partial<Wallet> = { corteDay: c, corteAsked: true };
    if (d != null) patch.dueDay = d;
    setBusy(true);
    setError(null);
    try {
      await db.wallets.update(wallet.id, patch);
    } catch {
      setError("Couldn't save. Try again.");
      setBusy(false);
    }
  }

  if (!asking) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <p className="flex-1 text-xs" style={{ color: "var(--muted)" }}>Set {wallet.name}&apos;s statement cycle?</p>
        <button onClick={() => setAsking(true)} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px]" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>Yes</button>
        <button onClick={answerNo} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px]" style={{ background: "var(--surface)", color: "var(--muted)" }}>No</button>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2">
        <label htmlFor={`corte-ask-${wallet.id}`} className="sr-only">Cut day for {wallet.name}</label>
        <input id={`corte-ask-${wallet.id}`} value={corte} onChange={(e) => setCorte(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" placeholder="Cut day of month, 1-31" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 bg-transparent px-3 py-2 text-sm min-h-[36px]" />
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={`corte-due-${wallet.id}`} className="sr-only">Due day for {wallet.name}</label>
        <input id={`corte-due-${wallet.id}`} value={due} onChange={(e) => setDue(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" placeholder="Due day (optional), 1-31" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 bg-transparent px-3 py-2 text-sm min-h-[36px]" />
        <button onClick={save} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px] disabled:opacity-50" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>{busy ? "…" : "Save"}</button>
      </div>
      {error && <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
    </div>
  );
}

/** One-time action: post a card's cashbackOpening baseline (cashback earned
 * before Blink started tracking it) as a real income transaction, crediting
 * it onto the card's actual balance instead of leaving it as a display-only
 * number forever. Gated by cashbackOpeningApplied so it can only fire once —
 * re-running it would credit the same starting amount to the card twice. */
export function ApplyCashbackOpeningBanner({ wallet }: { wallet: Wallet }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    const amount = wallet.cashbackOpening;
    if (!amount || amount <= 0 || wallet.id == null) return;
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      // Atomic: the credit transaction and the applied flag post together,
      // so a crash between the two can never re-offer (and double-post) it.
      await db.transaction("rw", [db.transactions, db.wallets], async () => {
        await db.transactions.add({
          id: newId(),
          type: "income",
          amount: roundCents(amount),
          currency: wallet.currency,
          walletId: wallet.id!,
          note: "Cashback starting balance applied",
          date: now,
          createdAt: now,
        });
        await db.wallets.update(wallet.id!, { cashbackOpeningApplied: true });
      });
    } catch {
      setError("Couldn't apply it. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <p className="flex-1 text-[11px]" style={{ color: "var(--muted)" }}>
        Still just a running total — hasn&apos;t reduced {wallet.name}&apos;s balance yet.
      </p>
      <button onClick={apply} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold min-h-[36px] disabled:opacity-50 shrink-0" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>
        {busy ? "…" : "Apply to balance"}
      </button>
      {error && <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-400 font-semibold w-full">{error}</p>}
    </div>
  );
}

export function CategoryManager({ categories }: { categories: Category[] }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🛒");
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [parentId, setParentId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function save() {
    setError(null);
    if (!name.trim()) return;
    try {
      await db.categories.add({
        id: newId(),
        name: name.trim().slice(0, 30),
        icon: icon || "•",
        color: assignColor(categories.map((c) => c.color)),
        kind,
        parentId: parentId || undefined,
      });
      setName(""); setShowForm(false);
    } catch {
      setError("Couldn't save the category.");
    }
  }

  async function remove(c: Category) {
    if (c.id == null) return;
    const countRefs = async () => {
      const [txCount, childCount] = await Promise.all([
        db.transactions.where("categoryId").equals(c.id!).count(),
        db.categories.where("parentId").equals(c.id!).count(),
      ]);
      const budCount = await db.budgets.filter((b) => b.categoryId === c.id).count();
      const recCount = await db.recurring.filter((r) => r.categoryId === c.id).count();
      return { txCount, childCount, budCount, recCount };
    };
    const describeRefs = (r: { txCount: number; childCount: number; budCount: number; recCount: number }) =>
      `${r.txCount} transactions, ${r.childCount} subcategories, ${r.budCount} budgets`;
    try {
      const refs = await countRefs();
      if (refs.txCount + refs.childCount + refs.budCount + refs.recCount > 0) {
        setError(`"${c.name}" is in use (${describeRefs(refs)}). Rename it or stop using it instead.`);
        return;
      }
    } catch {
      setError("Couldn't delete the category. Close and reopen the app, then try again.");
      return;
    }
    if (!confirm(`Delete "${c.name}"?`)) return;
    try {
      await db.transaction("rw", [db.categories, db.transactions, db.budgets, db.recurring], async () => {
        // Re-check inside the write transaction: a save in another tab may
        // have landed between the check and the confirm.
        const refs = await countRefs();
        if (refs.txCount + refs.childCount + refs.budCount + refs.recCount > 0) throw new Error("referenced");
        await db.categories.delete(c.id!);
      });
    } catch (err) {
      setError(err instanceof Error && err.message === "referenced"
        ? `"${c.name}" gained linked items just now — rename it or stop using it instead.`
        : "Couldn't delete the category. Close and reopen the app, then try again.");
    }
  }

  const parents = categories.filter((c) => !c.parentId && c.kind === kind);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {categories.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-900 text-xs font-semibold">
            {c.icon} {c.parentId ? "↳ " : ""}{c.name}
            <button className="text-zinc-500 dark:text-zinc-400 ml-1 min-w-[24px] min-h-[24px]" aria-label={`Delete category ${c.name}`} onClick={() => remove(c)}>×</button>
          </span>
        ))}
      </div>
      {!showForm ? (
        <button onClick={() => { setError(null); setShowForm(true); }} aria-expanded={false} aria-controls="category-form" className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold flex items-center justify-center gap-1 min-h-[44px]">
          <Plus size={15} /> Add category
        </button>
      ) : (
      <div id="category-form" className="p-3 rounded-2xl bg-zinc-50 dark:bg-zinc-900 space-y-2">
        <p className="text-xs font-bold text-zinc-500">NEW CATEGORY / SUBCATEGORY</p>
        <div className="flex gap-2">
          <input value={icon} onChange={(e) => setIcon(e.target.value)} aria-label="Emoji" className="w-14 text-center rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 min-h-[44px]" />
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Category name" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm outline-none min-h-[44px]" />
        </div>
        <div className="flex gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as "expense" | "income")} aria-label="Type" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]">
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Parent category" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]">
            <option value="">No parent (top level)</option>
            {parents.map((p) => <option key={p.id} value={p.id}>↳ {p.name}</option>)}
          </select>
        </div>
        <button onClick={save} className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold min-h-[44px]">Add category</button>
        <button onClick={() => { setError(null); setShowForm(false); }} className="w-full text-xs text-zinc-500 min-h-[44px]">cancel</button>
        {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
      </div>
      )}
    </div>
  );
}

export function BudgetManager({ budgets, categories, wallets }: { budgets: Budget[]; categories: Category[]; wallets: Wallet[] }) {
  const [label, setLabel] = useState("");
  const [limit, setLimit] = useState("");
  const [period, setPeriod] = useState<Budget["period"]>("month");
  const [currency, setCurrency] = useState<Currency>("MXN");
  const [categoryId, setCategoryId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const currencyOptions = currencyOptionsFor(wallets, currency);

  async function save() {
    setError(null);
    if (!label.trim() || !(Number(limit) > 0)) return;
    const limitNum = Number(limit);
    if (!Number.isFinite(limitNum) || limitNum <= 0) return;
    try {
      await db.budgets.add({ id: newId(), label: label.trim().slice(0, 40), limit: roundCents(limitNum), period, currency, categoryId: categoryId || null });
      setLabel(""); setLimit(""); setShowForm(false);
    } catch {
      setError("Couldn't save the budget.");
    }
  }

  function cancelCreate() {
    setError(null); setLabel(""); setLimit(""); setPeriod("month"); setCurrency("MXN"); setCategoryId(""); setShowForm(false);
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {budgets.map((b) => (
          <li key={b.id} className="flex items-center gap-2 p-3 rounded-2xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none">
            <div className="flex-1">
              <p className="text-sm font-bold">{b.label}</p>
              <p className="text-[11px] text-zinc-500">{b.period === "month" ? "Monthly" : b.period === "week" ? "Weekly" : "Yearly"} · {fmtMoney(b.limit, b.currency)}{b.categoryId ? ` · ${categories.find((c) => c.id === b.categoryId)?.name ?? "(deleted category)"} + subcategories` : " · all spending"}</p>
            </div>
            <button className="p-2.5 text-zinc-500 dark:text-zinc-400 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label={`Delete budget ${b.label}`} onClick={() => { if (b.id != null && confirm("Delete budget?")) db.budgets.delete(b.id).catch(() => setError("Couldn't delete the budget.")); }}><Trash2 size={15} /></button>
          </li>
        ))}
        {budgets.length === 0 && <p className="text-xs text-zinc-500">No budgets. Create a monthly one to avoid overdrawing your card.</p>}
      </ul>
      {!showForm ? (
        <button onClick={() => { setError(null); setShowForm(true); }} aria-expanded={false} aria-controls="budget-form" className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold flex items-center justify-center gap-1 min-h-[44px]">
          <Plus size={15} /> Add budget
        </button>
      ) : (
      <div id="budget-form" className="p-3 rounded-2xl bg-zinc-50 dark:bg-zinc-900 space-y-2">
        <input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="E.g. Food for the month" aria-label="Budget name" className="w-full rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm outline-none min-h-[44px]" />
        <div className="flex gap-2">
          <input value={limit} onChange={(e) => setLimit(sanitizeAmountInput(e.target.value))} inputMode="decimal" placeholder="Limit" aria-label="Limit" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px] disabled:opacity-60" />
          <select value={period} onChange={(e) => setPeriod(e.target.value as Budget["period"])} aria-label="Period" className="rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]">
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
            <option value="year">Yearly</option>
          </select>
          <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} aria-label="Currency" className="rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]">
            {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Budget category" className="w-full rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]">
          <option value="">All spending (total)</option>
          {categories.filter((c) => c.kind === "expense" && !c.parentId).map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name} (+ subs)</option>)}
        </select>
        <button onClick={save} className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold min-h-[44px]">Add budget</button>
        <button onClick={cancelCreate} className="w-full text-xs text-zinc-500 min-h-[44px]">cancel</button>
        {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
      </div>
      )}
    </div>
  );
}

export function DebtManager({ debts, wallets }: { debts: Debt[]; wallets: Wallet[] }) {
  const [person, setPerson] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("MXN");
  const [direction, setDirection] = useState<Debt["direction"]>("owed");
  const [settling, setSettling] = useState<string | null>(null);
  const [settleWallet, setSettleWallet] = useState<string>("");
  const [settleBusy, setSettleBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currencyOptions = currencyOptionsFor(wallets, currency);

  async function save() {
    const amtNum = Number(amount);
    if (!person.trim() || !Number.isFinite(amtNum) || amtNum <= 0) return;
    try {
      await db.debts.add({ id: newId(), person: person.trim().slice(0, 30), amount: roundCents(amtNum), currency, direction, createdAt: new Date().toISOString() });
      setPerson(""); setAmount(""); setCurrency("MXN"); setDirection("owed"); setShowForm(false); setError(null);
    } catch {
      setError("Couldn't save the debt. Try again.");
    }
  }

  function cancelCreate() {
    setPerson(""); setAmount(""); setCurrency("MXN"); setDirection("owed"); setShowForm(false);
  }

  /** Saldar puede ser solo lista, o lista + movimiento real en una tarjeta. */
  async function settle(d: Debt, withMovement: boolean) {
    if (d.id == null || settleBusy) return;
    try {
      const w = withMovement ? wallets.find((x) => String(x.id) === settleWallet) : undefined;
      if (withMovement) {
        if (!w) {
          setError("Pick the card or account where the money moved.");
          return;
        }
        if (w.currency !== d.currency) {
          setError(`"${w.name}" is ${w.currency} but the debt is ${d.currency}. Use a ${d.currency} account.`);
          return;
        }
        if (!Number.isFinite(d.amount) || d.amount <= 0) return;
      }
      setSettleBusy(true);
      // Atomic: a crash between the add and the update would otherwise
      // re-post the movement on the next settle attempt.
      await db.transaction("rw", [db.transactions, db.debts], async () => {
        if (withMovement) {
          const now = new Date().toISOString();
          const settleType = d.direction === "owed" ? "income" : "expense";
          const amt = roundCents(d.amount);
          await db.transactions.add({
            id: newId(),
            // Me pagaron lo que me debían = ingreso · Pagué lo que debía = gasto.
            // A debt settlement is not a purchase, so it never earns
            // cashback (see computeCashback) — no cashbackEarned field.
            type: settleType,
            amount: amt,
            currency: d.currency,
            walletId: w!.id!,
            note: `Debt: ${d.person}`,
            date: now,
            createdAt: now,
          });
        }
        await db.debts.update(d.id!, { settled: true });
      });
      setSettling(null);
    } catch {
      setError("Couldn't settle.");
    } finally {
      setSettleBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-zinc-500">Checklist: settling just marks it, unless you also log the movement on a card.</p>
      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
      <ul className="space-y-2">
        {debts.filter((d) => !d.settled).map((d) => (
          <li key={d.id} className="p-3 rounded-2xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <p className="text-sm font-bold">{d.person}</p>
                <p className="text-[11px] text-zinc-500">{d.direction === "owed" ? "Owes me" : "I owe"} · {fmtMoney(d.amount, d.currency)}</p>
              </div>
              <button className="text-xs font-bold text-zinc-500 px-2 py-2 min-h-[44px]" onClick={() => { if (d.id != null && confirm(`Mark as settled (without moving money)?`)) db.debts.update(d.id!, { settled: true }).catch(() => setError("Couldn't mark as settled.")); }}>mark only</button>
              <button className="text-xs font-bold text-violet-600 dark:text-violet-400 px-2 py-2 min-h-[44px]" onClick={() => { setSettling(d.id!); setSettleWallet(""); }}>settle…</button>
              <button className="p-2 text-zinc-500 dark:text-zinc-400 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label={`Delete debt for ${d.person}`} onClick={() => { if (d.id != null && confirm("Delete this record?")) db.debts.delete(d.id).catch(() => setError("Couldn't delete.")); }}><Trash2 size={14} /></button>
            </div>
            {settling === d.id && (
              <div className="flex gap-2 mt-2">
                <select value={settleWallet} onChange={(e) => setSettleWallet(e.target.value)} aria-label="Account for the movement" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2 text-xs min-h-[44px]">
                  <option value="">Which account did it move in?</option>
                  {wallets.filter((w) => !w.archived).map((w) => <option key={w.id} value={w.id}>{w.name} · {w.currency}</option>)}
                </select>
                <button onClick={() => settle(d, true)} disabled={settleBusy} className="px-3 rounded-xl bg-violet-600 text-white text-xs font-bold min-h-[44px] disabled:opacity-50">
                  {settleBusy ? "settling…" : `settle & log ${d.direction === "owed" ? "income" : "expense"}`}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!showForm ? (
        <button onClick={() => { setShowForm(true); }} aria-expanded={false} aria-controls="debt-form" className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold flex items-center justify-center gap-1 min-h-[44px]">
          <Plus size={15} /> Add debt
        </button>
      ) : (
      <div id="debt-form" className="p-3 rounded-2xl bg-zinc-50 dark:bg-zinc-900 space-y-2">
        <div className="flex gap-2">
          <input value={person} maxLength={30} onChange={(e) => setPerson(e.target.value)} placeholder="Who? (first name)" aria-label="Person" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px] disabled:opacity-60" />
          <input value={amount} onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))} inputMode="decimal" placeholder="Amount" aria-label="Amount" className="w-28 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px]" />
        </div>
        <div className="flex gap-2">
          <select value={direction} onChange={(e) => setDirection(e.target.value as Debt["direction"])} aria-label="Direction" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]">
            <option value="owed">They owe me</option>
            <option value="owe">I owe</option>
          </select>
          <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} aria-label="Currency" className="w-24 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-sm min-h-[44px]">
            {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button onClick={save} className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold min-h-[44px]">Add debt</button>
        <button onClick={cancelCreate} className="w-full text-xs text-zinc-500 min-h-[44px]">cancel</button>
      </div>
      )}
    </div>
  );
}


export function RecurringManager({ items, wallets, categories }: { items: Recurring[]; wallets: Wallet[]; categories: Category[] }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [rtype, setRtype] = useState<"expense" | "income">("expense");
  const [walletId, setWalletId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [frequency, setFrequency] = useState<Recurring["frequency"]>("monthly");
  const [hasEnd, setHasEnd] = useState(false);
  const [endDate, setEndDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [logBusy, setLogBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const activeWallets = wallets.filter((w) => !w.archived);

  function startEdit(r: Recurring) {
    setLabel(r.label); setAmount(String(r.amount)); setRtype(r.type as "expense" | "income");
    setWalletId(String(r.walletId)); setCategoryId(r.categoryId != null ? String(r.categoryId) : "");
    setFrequency(r.frequency); setHasEnd(!!r.endDate); setEndDate(r.endDate ?? "");
    setEditingId(r.id!); setShowForm(true); setError(null);
  }

  async function save() {
    setError(null);
    const w = wallets.find((x) => String(x.id) === walletId);
    const amtNum = Number(amount);
    if (!label.trim() || !Number.isFinite(amtNum) || amtNum <= 0) {
      setError("Name and amount are missing.");
      return;
    }
    if (!w) {
      setError("Pick the card or account.");
      return;
    }
    if (hasEnd && endDate) {
      const end = new Date(endDate.slice(0, 10) + "T23:59:59.999");
      if (!isNaN(end.getTime()) && end.getTime() < Date.now()) {
        setError("The end date is in the past — this item would post one transaction it shouldn't, then stop.");
        return;
      }
    }
    try {
      const data = {
        label: label.trim().slice(0, 40),
        type: rtype,
        amount: roundCents(amtNum),
        currency: w.currency,
        walletId: w.id!,
        categoryId: categoryId || undefined,
        frequency,
        ...(hasEnd && endDate ? { endDate } : { endDate: undefined }),
      };
      if (editingId != null) {
        // Saving is the only way to put an item back on a real date: one whose
        // stored nextDate is unreadable is never due, so the auto-log skips it
        // forever and "log now" refuses it.
        const existing = await db.recurring.get(editingId);
        const broken = !existing || !Number.isFinite(new Date(existing.nextDate).getTime());
        await db.recurring.update(editingId, broken ? { ...data, nextDate: new Date().toISOString() } : data);
      } else {
        await db.recurring.add({
          ...data,
          id: newId(),
          nextDate: new Date().toISOString(),
          active: true,
          anchorDay: new Date().getDate(),
        });
      }
      cancelCreate();
    } catch {
      setError("Couldn't save the recurring item.");
    }
  }

  function cancelCreate() {
    setLabel(""); setAmount(""); setRtype("expense"); setWalletId(""); setCategoryId(""); setFrequency("monthly"); setHasEnd(false); setEndDate(""); setError(null); setShowForm(false); setEditingId(null);
  }

  async function logNow(r: Recurring) {
    if (r.id == null || logBusy != null) return;
    const w = wallets.find((x) => x.id === r.walletId);
    if (!w) {
      setError("This recurring item's account no longer exists. Delete it and create it again.");
      return;
    }
    if (!Number.isFinite(r.amount) || r.amount <= 0) return;
    if (!Number.isFinite(new Date(r.nextDate).getTime())) {
      setError("This item's next date can't be read. Edit it and set a new date.");
      return;
    }
    // Dead-on-arrival guard: if the due occurrence is already past the end
    // date, deactivate without posting a phantom transaction.
    if (typeof r.endDate === "string" && r.endDate) {
      const end = new Date(r.endDate.slice(0, 10) + "T23:59:59.999");
      if (!isNaN(end.getTime()) && new Date(r.nextDate).getTime() > end.getTime()) {
        try {
          await db.recurring.update(r.id, { active: false });
        } catch {
          /* non-fatal */
        }
        return;
      }
    }
    try {
      setLogBusy(r.id);
      const now = new Date();
      // Atomic: a crash between the add and the update would otherwise
      // re-post the occurrence on the next attempt.
      await db.transaction("rw", [db.transactions, db.recurring], async () => {
        const amt = roundCents(r.amount);
        const nowIso = now.toISOString();
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
        // Catch up missed periods so nextDate never stays in the past. Con
        // fecha de fin: si el próximo vencimiento ya la supera, el recurrente
        // se desactiva en este mismo update (la lista solo muestra active !== false).
        const { nextDate, ended } = advanceRecurringPastNow(new Date(r.nextDate), r.frequency, r.anchorDay, now, r.endDate);
        await db.recurring.update(r.id!, ended ? { nextDate: nextDate.toISOString(), active: false } : { nextDate: nextDate.toISOString() });
      });
    } catch {
      setError("Couldn't log it.");
    } finally {
      setLogBusy(null);
    }
  }

  const kindCats = categories.filter((c) => c.kind === rtype);

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {items.filter((r) => r.active !== false).map((r) => {
          const w = wallets.find((x) => x.id === r.walletId);
          return (
            <li key={r.id} className="flex items-center gap-2 p-3 rounded-2xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none">
              <div className="flex-1">
                <p className="text-sm font-bold">{r.label}</p>
                <p className="text-[11px] text-zinc-500">{r.type === "income" ? "Income" : "Expense"} · {fmtMoney(r.amount, r.currency)} · {r.frequency === "monthly" ? "monthly" : r.frequency === "weekly" ? "weekly" : "yearly"} · {new Date(r.nextDate) <= new Date() ? <span className="text-amber-600 dark:text-amber-400 font-semibold">Due now</span> : <>Next {prettyDay(r.nextDate)}</>} · {w?.name ?? "(deleted account)"}{r.endDate ? (
                  <>
                    {" · "}
                    <button
                      onClick={() => { if (r.id != null && confirm(`Remove the end date for "${r.label}"? It will repeat indefinitely.`)) db.recurring.update(r.id, { endDate: undefined }).catch(() => setError("Couldn't remove the end date.")); }}
                      title="Tap to remove the end date"
                      className="underline underline-offset-2"
                    >
                      Ends {new Date(r.endDate.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}
                    </button>
                  </>
                ) : null}</p>
              </div>
              <button onClick={() => logNow(r)} disabled={!w || logBusy === r.id} aria-label={`Log ${r.label} now`} title="Log now" className="p-2 text-zinc-400 dark:text-zinc-500 min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-40">{logBusy === r.id ? "…" : <RefreshCw size={14} />}</button>
              <button className="p-2 text-zinc-500 dark:text-zinc-400 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label={`Edit recurring ${r.label}`} onClick={() => startEdit(r)}><Pencil size={14} /></button>
              <button className="p-2 text-zinc-500 dark:text-zinc-400 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label={`Delete recurring ${r.label}`} onClick={() => { if (r.id != null && confirm("Delete this recurring item?")) db.recurring.delete(r.id).catch(() => setError("Couldn't delete.")); }}><Trash2 size={14} /></button>
            </li>
          );
        })}
      </ul>
      {!showForm ? (
        <button onClick={() => { setShowForm(true); }} aria-expanded={false} aria-controls="recurring-form" className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold flex items-center justify-center gap-1 min-h-[44px]">
          <Plus size={15} /> {editingId != null ? "Editing recurring" : "Add recurring"}
        </button>
      ) : (
      <div id="recurring-form" className="p-3 rounded-2xl bg-zinc-50 dark:bg-zinc-900 space-y-2">
        <div className="flex gap-2">
          <input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="E.g. Rent, Netflix" aria-label="Name" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px] disabled:opacity-60" />
          <input value={amount} onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))} inputMode="decimal" placeholder="Amount" aria-label="Amount" className="w-24 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-3 py-2.5 text-sm min-h-[44px]" />
        </div>
        <div className="flex gap-2">
          <select value={rtype} onChange={(e) => { setRtype(e.target.value as "expense" | "income"); setCategoryId(""); }} aria-label="Type" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-xs min-h-[44px]">
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
          <select value={walletId} onChange={(e) => setWalletId(e.target.value)} aria-label="Account" className="flex-1 rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-xs min-h-[44px]">
            <option value="">Account…</option>
            {activeWallets.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.currency}</option>)}
          </select>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as Recurring["frequency"])} aria-label="Frequency" className="rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-xs min-h-[44px]">
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category" className="w-full rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-xs min-h-[44px]">
          <option value="">No category</option>
          {kindCats.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs font-semibold px-1">
          <input type="checkbox" checked={hasEnd} onChange={(e) => setHasEnd(e.target.checked)} className="w-4 h-4 accent-violet-500" />
          Ends on a date
        </label>
        {hasEnd && (
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label="End date" className="w-full rounded-xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none bg-transparent px-2 py-2.5 text-xs min-h-[44px]" />
        )}
        {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
        <button onClick={save} className="w-full py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold min-h-[44px]">{editingId != null ? "Update" : "Add recurring"}</button>
        <button onClick={cancelCreate} className="w-full text-xs text-zinc-500 min-h-[44px]">cancel</button>
      </div>
      )}
    </div>
  );
}

function WipeButton() {
  const [armed, setArmed] = useState(false);
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  function arm() {
    setArmed(true);
    const t = setTimeout(() => setArmed(false), 10_000);
    setTimer(t);
  }

  async function wipe() {
    if (timer) clearTimeout(timer);
    setArmed(false);
    await Promise.all([db.transactions.clear(), db.wallets.clear(), db.categories.clear(), db.budgets.clear(), db.debts.clear(), db.recurring.clear()]);
    try {
      const keys = ["blink:lastWallet", "blink:lastCategory", "blink:dark", "blink:lastBackupAt"];
      keys.forEach((k) => localStorage.removeItem(k));
    } catch { /* non-fatal */ }
    location.reload();
  }

  if (!armed) {
    return (
      <button onClick={arm} className="w-full py-2 text-xs text-rose-600 dark:text-rose-400 min-h-[44px]">
        Delete everything and start over
      </button>
    );
  }
  return (
    <div className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950 border border-rose-200 dark:border-rose-800 space-y-2">
      <p className="text-xs font-bold text-rose-700 dark:text-rose-300">This deletes ALL data permanently. No undo.</p>
      <p className="text-[11px] text-rose-600 dark:text-rose-400">Download a backup first if you haven&apos;t.</p>
      <div className="flex gap-2">
        <button onClick={wipe} className="flex-1 py-2.5 rounded-xl bg-rose-600 text-white text-sm font-bold min-h-[44px]">Yes, delete everything</button>
        <button onClick={() => { if (timer) clearTimeout(timer); setArmed(false); }} className="flex-1 py-2.5 rounded-xl border border-rose-300 dark:border-rose-700 text-sm font-bold min-h-[44px] text-rose-600 dark:text-rose-400">Cancel</button>
      </div>
    </div>
  );
}

/** ISO timestamp of the last successful JSON export (backup-reminder nag). */
const LAST_BACKUP_KEY = "blink:lastBackupAt";

export function SettingsPanel({
  wallets, categories, txCount, dark, setDark,
}: {
  wallets: Wallet[];
  categories: Category[];
  txCount: number;
  dark: boolean;
  setDark: (v: boolean) => void;
}) {
  const [includePhotos, setIncludePhotos] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [backupChecked, setBackupChecked] = useState(false);
  const [audit, setAudit] = useState<AuditIssue[] | null>(null);
  const [auditErr, setAuditErr] = useState<string | null>(null);
  const [csvImportMsg, setCsvImportMsg] = useState<string | null>(null);
  const [csvImportErr, setCsvImportErr] = useState<string | null>(null);
  const [csvImportPending, setCsvImportPending] = useState<{ transactions: Omit<Transaction, "id">[]; errors: string[] } | null>(null);
  const [csvImporting, setCsvImporting] = useState(false);
  const wById = new Map(wallets.map((w) => [w.id, w]));
  const cById = new Map(categories.map((c) => [c.id, c]));

  // Effect (not a render-time read) so the first paint never mismatches
  // hydration when localStorage already holds a timestamp.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLastBackupAt(browserKV()?.getItem(LAST_BACKUP_KEY) ?? null);
    } catch {
      /* private mode — treated as never backed up */
    }
    setBackupChecked(true);
  }, []);

  // undefined = not checked yet (render nothing); null = never backed up.
  const backupDays: number | null | undefined =
    !backupChecked ? undefined : lastBackupAt == null ? null : daysSince(lastBackupAt);

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function doExportJSON() {
    if (!confirm(`Download a JSON backup with EVERYTHING (accounts, ${txCount} transactions${includePhotos ? " WITH photos" : " WITHOUT photos"}, debts, names in notes)?\n\nIt's a plain-text file outside the app: the wipe button won't delete it, and it may sync via Files/AirDrop/backups.`)) return;
    try {
      const json = await exportJSON({ images: includePhotos });
      download(new Blob([json], { type: "application/json" }), `blink-respaldo-${new Date().toISOString().slice(0, 10)}.json`);
      const stamp = new Date().toISOString();
      try {
        browserKV()?.setItem(LAST_BACKUP_KEY, stamp);
      } catch {
        /* quota — the download itself already succeeded */
      }
      setLastBackupAt(stamp);
    } catch {
      setRestoreErr("Couldn't generate the backup. Close and reopen the app, then try again.");
    }
  }

  async function doImportJSON(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setRestoreMsg(null);
    setRestoreErr(null);
    if (!confirm("Are you sure? This replaces all your current data with the backup contents. This can't be undone.")) return;
    try {
      const text = await file.text();
      // A restore wipes everything — including transactions logged after
      // the backup was exported (e.g. from another tab). Warn when the
      // live DB is newer than the backup file.
      try {
        const parsed = parseBackup(text);
        if (parsed.exportedAt) {
          const newest = await db.transactions.orderBy("createdAt").last();
          if (newest && newest.createdAt > parsed.exportedAt) {
            if (!confirm("This backup is older than your newest transactions. Restoring will permanently DELETE anything logged after the backup was exported. Continue?")) return;
          }
        }
      } catch {
        /* parse errors surface below via importJSON */
      }
      const c = await importJSON(text);
      setRestoreMsg(`Backup restored: ${c.wallets} accounts, ${c.categories} categories, ${c.transactions} transactions, ${c.budgets} budgets, ${c.debts} debts, ${c.recurring} recurring.`);
    } catch (err) {
      setRestoreErr(err instanceof Error ? err.message : "Couldn't restore the backup.");
    }
  }

  async function doImportCSV(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCsvImportMsg(null);
    setCsvImportErr(null);
    setCsvImportPending(null);
    try {
      const text = await file.text();
      const parsed = parseTransactionsCSV(text, wallets, categories);
      if (parsed.errors.length > 0 && parsed.transactions.length === 0) {
        setCsvImportErr(`All rows had errors. First few:\n${parsed.errors.slice(0, 5).join("\n")}`);
        return;
      }
      // Show summary and ask for confirmation before inserting — hold the
      // already-parsed rows in state; the file input is cleared above, so
      // confirming must not try to re-read the file (it's gone by then).
      setCsvImportPending({ transactions: parsed.transactions, errors: parsed.errors });
    } catch (err) {
      setCsvImportErr(err instanceof Error ? err.message : "Couldn't parse the CSV file.");
    }
  }

  async function confirmCSVImport() {
    if (!csvImportPending || csvImporting) return;
    const { transactions, errors } = csvImportPending;
    setCsvImportMsg(null);
    setCsvImportErr(null);
    setCsvImportPending(null);
    if (transactions.length === 0) {
      setCsvImportErr("No valid transactions to import.");
      return;
    }
    setCsvImporting(true);
    try {
      // Revalidate against live data: a wallet/category may have been
      // deleted since the file was parsed — the snapshot would otherwise
      // plant orphan rows. Rows are keyed by id, so re-check existence.
      const [liveWallets, liveCats, existing] = await Promise.all([
        db.wallets.toArray(),
        db.categories.toArray(),
        db.transactions.toArray(),
      ]);
      const liveWById = new Map(liveWallets.map((w) => [w.id, w]));
      const liveCIds = new Set(liveCats.map((c) => c.id));
      const fresh: Omit<Transaction, "id">[] = [];
      let stale = 0;
      for (const t of transactions) {
        const w = liveWById.get(t.walletId);
        if (!w || w.currency !== t.currency) { stale++; continue; }
        if (t.categoryId != null && !liveCIds.has(t.categoryId)) { stale++; continue; }
        if (t.type === "transfer") {
          const d = t.toWalletId != null ? liveWById.get(t.toWalletId) : undefined;
          if (!d || d.currency !== w.currency) { stale++; continue; }
        }
        fresh.push(t);
      }
      // Skip exact duplicates: re-importing an export would otherwise
      // double every balance with no warning.
      const rowKey = (t: Omit<Transaction, "id">) =>
        [t.walletId, t.type, t.amount, t.currency, t.date, t.toWalletId ?? "", t.categoryId ?? "", t.note ?? ""].join("|");
      const seen = new Set(existing.map(rowKey));
      const novel = fresh.filter((t) => {
        const k = rowKey(t);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const dupes = fresh.length - novel.length;
      if (novel.length === 0) {
        setCsvImportErr(
          dupes > 0
            ? `All ${fresh.length} row(s) are already in your books — nothing imported.`
            : "No valid transactions to import."
        );
        return;
      }
      await db.transactions.bulkAdd(novel.map((t) => ({ ...t, id: newId() })));
      const skipped = errors.length + stale + dupes;
      const skipDetail = [
        dupes > 0 ? `${dupes} already imported` : "",
        stale > 0 ? `${stale} reference deleted accounts` : "",
        errors.length > 0 ? `${errors.length} had errors` : "",
      ].filter(Boolean).join(", ");
      setCsvImportMsg(`Imported ${novel.length} transaction${novel.length === 1 ? "" : "s"}.${skipped > 0 ? ` (${skipped} row(s) skipped: ${skipDetail})` : ""}`);
    } catch (err) {
      setCsvImportErr(err instanceof Error ? err.message : "Couldn't import the CSV file.");
    } finally {
      setCsvImporting(false);
    }
  }

  async function doExportCSV() {
    try {
      const txs = await db.transactions.orderBy("date").toArray();
      const rows = txs.map((t) => ({
        date: t.date, type: t.type, amount: t.amount, currency: t.currency,
        wallet: wById.get(t.walletId)?.name ?? "", toWallet: t.toWalletId != null ? (wById.get(t.toWalletId)?.name ?? "") : "",
        category: t.categoryId != null ? (cById.get(t.categoryId)?.name ?? "") : "", note: t.note ?? "",
        cashbackEarned: t.cashbackEarned,
      }));
      download(new Blob([transactionsToCSV(rows)], { type: "text/csv" }), `blink-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch {
      setRestoreErr("Couldn't generate the CSV. Close and reopen the app, then try again.");
    }
  }

  async function doAudit() {
    setAuditErr(null);
    try {
      // Same gather pattern as exportJSON in lib/format.ts.
      const [aw, ac, at, ab, ad, ar] = await Promise.all([
        db.wallets.toArray(),
        db.categories.toArray(),
        db.transactions.toArray(),
        db.budgets.toArray(),
        db.debts.toArray(),
        db.recurring.toArray(),
      ]);
      setAudit(auditBooks({ wallets: aw, categories: ac, transactions: at, budgets: ab, debts: ad, recurring: ar }));
    } catch {
      setAuditErr("Couldn't verify. Close and reopen the app, then try again.");
    }
  }

  return (
    <div className="space-y-3">
      {(backupDays === null || (typeof backupDays === "number" && Number.isNaN(backupDays))) && (
        <p className="text-xs text-amber-600 dark:text-amber-400 px-1">💾 You&apos;ve never made a backup — do it before it&apos;s too late.</p>
      )}
      {typeof backupDays === "number" && !Number.isNaN(backupDays) && backupDays > 30 && (
        <p className="text-xs text-amber-600 dark:text-amber-400 px-1">💾 Your last backup was {backupDays} days ago — consider making a new one.</p>
      )}
      <div className="flex items-center justify-between p-3 rounded-2xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none">
        <span className="text-sm font-bold">Dark mode</span>
        <button onClick={() => setDark(!dark)} role="switch" aria-checked={dark} aria-label="Dark mode" className={`w-12 h-7 rounded-full p-1 min-h-[28px] ${dark ? "bg-violet-500" : "bg-zinc-300"}`}>
          <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${dark ? "translate-x-5" : ""}`} />
        </button>
      </div>
      <div className="p-3 rounded-2xl border border-zinc-200/70 dark:border-zinc-800/70 shadow-sm shadow-zinc-900/[0.03] dark:shadow-none text-xs text-zinc-500 space-y-1">
        <p className="font-bold text-zinc-700 dark:text-zinc-200">📱 Install on your iPhone</p>
        <p>1. Open this page in Safari → Share → “Add to Home Screen”.</p>
        <p>2. It opens fullscreen; your transactions and photos live on this phone.</p>
        <p>3. Note: the first load and updates do go over the network (the host sees connection metadata). For maximum privacy, serve it on your local network.</p>
      </div>
      <label className="flex items-center gap-2 text-xs font-semibold px-1">
        <input type="checkbox" checked={includePhotos} onChange={(e) => setIncludePhotos(e.target.checked)} className="w-4 h-4 accent-violet-500" />
        Include receipt photos in the JSON (heavy, and it exposes merchants/amounts)
      </label>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={doExportJSON} className="py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-black text-sm font-bold min-h-[44px]">Download JSON</button>
        <button onClick={doExportCSV} className="py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-bold min-h-[44px]">Download CSV (no photos)</button>
      </div>
      <div className="space-y-1">
        <label className="block py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-bold min-h-[44px] text-center cursor-pointer focus-within:ring-2 ring-violet-500">
          Restore backup
          <input type="file" accept=".json,application/json" aria-label="Choose a JSON backup file to restore" onChange={doImportJSON} className="sr-only" />
        </label>
        <p className="text-[11px] text-zinc-500 px-1">Restore a previously downloaded JSON backup. Replaces all current data.</p>
        {restoreMsg && <p role="status" className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 px-1">{restoreMsg}</p>}
        {restoreErr && <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400 px-1">{restoreErr}</p>}
      </div>
      <div className="space-y-1">
        <label className="block py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-bold min-h-[44px] text-center cursor-pointer focus-within:ring-2 ring-violet-500">
          Import transactions from CSV
          <input type="file" accept=".csv,text/csv" aria-label="Choose a CSV file to import" onChange={doImportCSV} className="sr-only" />
        </label>
        <p className="text-[11px] text-zinc-500 px-1">Import transactions from a CSV export. Must match the format of the &quot;Download CSV&quot; file.</p>
        {csvImportPending && (
          <div className="bg-violet-50 dark:bg-violet-950 p-2 rounded-xl border border-violet-200 dark:border-violet-800 space-y-2">
            <p className="text-xs font-semibold text-violet-700 dark:text-violet-300">
              Ready to import: {csvImportPending.transactions.length} transaction{csvImportPending.transactions.length === 1 ? "" : "s"}
            </p>
            {csvImportPending.errors.length > 0 && (
              <div>
                <p className="text-[11px] text-violet-600 dark:text-violet-400 font-semibold">{csvImportPending.errors.length} row(s) with errors (will be skipped):</p>
                <ul className="text-[11px] text-violet-600 dark:text-violet-400 space-y-0.5 px-2">
                  {csvImportPending.errors.slice(0, 3).map((err, i) => (
                    <li key={i}>• {err}</li>
                  ))}
                  {csvImportPending.errors.length > 3 && <li>• ... and {csvImportPending.errors.length - 3} more</li>}
                </ul>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={confirmCSVImport} disabled={csvImporting} className="flex-1 py-2 rounded-lg bg-violet-600 text-white text-xs font-bold min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed">Import {csvImportPending.transactions.length}</button>
              <button onClick={() => { setCsvImportPending(null); setCsvImportMsg(null); setCsvImportErr(null); }} className="flex-1 py-2 rounded-lg border border-violet-300 dark:border-violet-700 text-xs font-bold min-h-[36px]">cancel</button>
            </div>
          </div>
        )}
        {csvImportMsg && <p role="status" className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 px-1">{csvImportMsg}</p>}
        {csvImportErr && <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400 px-1 whitespace-pre-wrap">{csvImportErr}</p>}
      </div>
      <div className="space-y-1">
        <button onClick={doAudit} className="w-full py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-bold min-h-[44px]">Check books</button>
        <p className="text-[11px] text-zinc-500 px-1">Checks that currencies, accounts, and categories add up. Read-only, changes nothing.</p>
        {auditErr && <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400 px-1">{auditErr}</p>}
        {audit !== null && audit.length === 0 && !auditErr && (
          <p role="status" className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 px-1">✓ All good</p>
        )}
        {audit !== null && audit.length > 0 && (
          <ul className="px-1 space-y-0.5" role="alert">
            {audit.map((i) => (
              <li key={i.message} className={`text-xs font-semibold ${i.severity === "error" ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"}`}>
                {i.severity === "error" ? "✕" : "⚠"} {i.message} ({i.count})
              </li>
            ))}
          </ul>
        )}
      </div>
      <WipeButton />
    </div>
  );
}
