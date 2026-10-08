"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X, Camera, ArrowLeftRight, Wallet as WalletIcon } from "lucide-react";
import { db, type Category, type Currency, type TxType, type Wallet } from "@/lib/db";
import { cashbackCreditTransaction, computeCashback } from "@/lib/balances";
import { CUR_SYM, fmtMoney, roundCents, sanitizeAmountInput, toInputDate } from "@/lib/format";
import { browserKV } from "@/lib/shortcut";
import { isDuplicateEntry } from "@/lib/stats";
import { newId } from "@/lib/sync/ids";

// Custom (user-added) currencies reuse the generic USD-scale chips.
const QUICK_AMOUNTS: Record<string, number[]> = {
  USD: [1, 5, 10, 20],
  EUR: [1, 5, 10, 20],
  MXN: [20, 50, 100, 200],
};

function lastUsed(key: string): string {
  try {
    return browserKV()?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function lastCatIfVisible(visible: Category[]): string | undefined {
  const last = lastUsed("blink:lastCategory") || undefined;
  return visible.some((c) => c.id === last) ? last : undefined;
}

export default function QuickAdd({
  wallets,
  categories,
  defaultCurrency = "MXN",
  initialType = "expense",
  initialAmount,
  initialWalletId,
  initialToWalletId,
  initialCategoryId,
  initialNote,
  editingTx,
  initialDate,
  onClose,
  onSaved,
}: {
  wallets: Wallet[];
  categories: Category[];
  defaultCurrency?: Currency;
  initialType?: TxType;
  initialAmount?: string;
  initialWalletId?: string;
  initialToWalletId?: string;
  initialCategoryId?: string;
  initialNote?: string;
  editingTx?: { id: string; image?: string; cashbackEarned?: number };
  initialDate?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const activeWallets = useMemo(() => wallets.filter((w) => !w.archived), [wallets]);
  const [type, setType] = useState<TxType>(initialType);
  const [amount, setAmount] = useState(initialAmount ?? "");
  // Explicit user picks (undefined = no override). Effective ids derive below,
  // so async-loaded wallets/categories need no sync effects.
  const [walletPick, setWalletPick] = useState<string | undefined>(initialWalletId);
  const [toPick, setToPick] = useState<string | undefined>(initialToWalletId);
  const [catPick, setCatPick] = useState<string | undefined>(initialCategoryId);

  const lastWalletId = useMemo(() => {
    const last = lastUsed("blink:lastWallet") || undefined;
    return wallets.some((w) => w.id === last) ? last : undefined;
  }, [wallets]);
  const walletId = walletPick ?? lastWalletId ?? wallets[0]?.id;
  const wallet = activeWallets.find((w) => w.id === walletId) ?? wallets.find((w) => w.id === walletId);
  // Currency is locked to the source wallet: one amount can never post 1:1 across currencies.
  const currency: Currency = wallet?.currency ?? defaultCurrency;
  const [note, setNote] = useState(initialNote ?? "");
  const [date, setDate] = useState(() => toInputDate(initialDate ?? new Date().toISOString()));
  const [image, setImage] = useState<string | undefined>(editingTx?.image);
  const [saving, setSaving] = useState(false);
  // Sync guard alongside `saving` state: React commits state on re-render,
  // so a same-tick double-tap would read stale `saving === false` twice.
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sheet behavior: lock background scroll, focus without scrolling, Escape
  // closes, and Tab cycles inside the sheet (simple focus trap — the page
  // behind is not inert, so without this keyboard focus would leave the modal).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    amountRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
      ).filter(
        (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
    // Mount-only: sheet opens fresh each time (parent remounts via key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Transfer destination stays valid purely by derivation: same currency, distinct wallet.
  const destOptions = useMemo(
    () => activeWallets.filter((w) => w.id !== walletId && w.currency === currency),
    [activeWallets, walletId, currency]
  );
  const toWalletId =
    toPick != null && toPick !== walletId && destOptions.some((w) => w.id === toPick)
      ? toPick
      : destOptions[0]?.id;

  const visibleCats = useMemo(() => {
    if (type === "transfer") return [];
    const kind = type === "income" ? "income" : "expense";
    const last = lastUsed("blink:lastCategory") || undefined;
    const list = categories.filter((c) => c.kind === kind);
    const tops = list.filter((c) => !c.parentId);
    const subs = list.filter((c) => c.parentId);
    const ordered = [...tops, ...subs];
    // Most recent first — the 3-second flow repeats the same categories
    ordered.sort((a, b) => (b.id === last ? 1 : 0) - (a.id === last ? 1 : 0));
    return ordered;
  }, [categories, type]);

  const categoryId =
    catPick ?? lastCatIfVisible(visibleCats) ?? (type === "transfer" ? undefined : visibleCats[0]?.id);

  const destWallet = wallets.find((w) => w.id === toWalletId);
  const amountNum = Number(amount);
  let disabledReason: string | null = null;
  // Finite check: a 300+-digit string parses to Infinity and would corrupt
  // balances (Infinity - x stays Infinity).
  if (!(Number.isFinite(amountNum) && amountNum > 0)) disabledReason = "Enter an amount greater than 0";
  // Rounding happens at intake, so 0.001 would store a 0 and post a row that
  // no balance ever reflects.
  else if (roundCents(amountNum) <= 0) disabledReason = "Amounts under a cent can't be logged";
  else if (walletId == null) disabledReason = "Pick a card or account";
  else if (type === "transfer" && (toWalletId == null || toWalletId === walletId))
    disabledReason = "Pick a different destination account";
  else if (type === "transfer" && destOptions.length === 0)
    disabledReason = `No other account uses ${currency} — transfers stay in the same currency`;
  const canSave = disabledReason == null;

  async function save() {
    if (!canSave || saving || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const d = new Date(date);
      if (isNaN(+d)) throw new Error("Invalid date");
      // Defensive: currency always equals the source wallet's currency
      const w = wallets.find((x) => x.id === walletId);
      if (!w) throw new Error("Invalid card");
      if (type === "transfer") {
        const dw = wallets.find((x) => x.id === toWalletId);
        if (!dw || dw.id === walletId || dw.currency !== w.currency) throw new Error("Invalid destination");
      }
      const roundedAmount = Math.round(amountNum * 100) / 100;
      const cashbackEarned = computeCashback(type, roundedAmount, w);
      const nowIso = new Date().toISOString();
      const fields = {
        type, amount: roundedAmount, currency: w.currency, walletId: walletId!,
        toWalletId: type === "transfer" ? toWalletId : undefined,
        categoryId: type === "transfer" ? undefined : categoryId,
        note: note.trim() || undefined, date: d.toISOString(), image, cashbackEarned,
      };
      await db.transaction("rw", [db.transactions], async () => {
        if (editingTx) {
          // Delete orphaned cashback-credit from the original transaction
          if (editingTx.cashbackEarned && editingTx.cashbackEarned > 0) {
            const oldCredits = await db.transactions
              .where("walletId").equals(walletId!)
              .filter((t) =>
                t.type === "income" &&
                t.note === "Cashback" &&
                // Rows written before sourceTxId existed carry no link, so
                // they can only be matched the old, amount-based way.
                (t.sourceTxId != null
                  ? t.sourceTxId === editingTx.id
                  : t.amount === editingTx.cashbackEarned)
              )
              .toArray();
            for (const oc of oldCredits) {
              if (oc.id != null) await db.transactions.delete(oc.id);
            }
          }
          await db.transactions.update(editingTx.id, fields);
          // Post new cashback-credit if the edited transaction earns any
          const credit = cashbackCreditTransaction(cashbackEarned, w, d.toISOString(), editingTx.id);
          if (credit) await db.transactions.add({ ...credit, id: newId(), createdAt: nowIso });
        } else {
          // Another tab may have just saved this same entry. The check has to
          // run inside the transaction, which IndexedDB serialises across
          // tabs, or both read "nothing there" and both insert.
          const entry = {
            type, amount: roundedAmount, walletId: walletId!,
            toWalletId: fields.toWalletId, categoryId: fields.categoryId,
            date: fields.date, note: fields.note,
          };
          const already = await db.transactions
            .where("walletId").equals(walletId!)
            .filter((t) => isDuplicateEntry(t, entry, new Date()))
            .first();
          if (!already) {
            const txId = newId();
            await db.transactions.add({ ...fields, id: txId, createdAt: nowIso });
            const credit = cashbackCreditTransaction(cashbackEarned, w, d.toISOString(), txId);
            if (credit) await db.transactions.add({ ...credit, id: newId(), createdAt: nowIso });
          }
        }
      });
      try {
        const kv = browserKV();
        kv?.setItem("blink:lastWallet", String(walletId));
        if (categoryId) kv?.setItem("blink:lastCategory", String(categoryId));
      } catch {
        /* non-fatal */
      }
      onSaved();
      onClose();
    } catch {
      setSaveError("Couldn't save (storage full or invalid date?). Check the amount and try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function onPhoto(file: File | undefined) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setSaveError("That photo is too large (max 8 MB). Pick a smaller one.");
      return;
    }
    const finish = (bmp: { width: number; height: number }, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) => {
      const canvas = document.createElement("canvas");
      const max = 1000;
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      draw(ctx, canvas.width, canvas.height);
      // NOTE: canvas re-encode intentionally drops EXIF (GPS, device, orientation).
      // Never switch to storing the raw file/dataURL — it would leak photo metadata.
      const url = canvas.toDataURL("image/jpeg", 0.65);
      if (url.length > 1_400_000) {
        setSaveError("Still too large even compressed. Try a simpler shot.");
        return;
      }
      setSaveError(null);
      setImage(url);
    };
    // Prefer createImageBitmap with EXIF orientation applied (iOS photos)
    if (typeof createImageBitmap === "function") {
      createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions)
        .then((bmp) => {
          finish(bmp, (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h));
          bmp.close?.();
        })
        .catch(() => legacyPhoto(file, finish));
    } else {
      legacyPhoto(file, finish);
    }
  }

  function legacyPhoto(
    file: File,
    finish: (bmp: { width: number; height: number }, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) => void
  ) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => finish(img, (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  const sign = type === "expense" ? "−" : type === "income" ? "+" : "⇄";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label="Log transaction">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div ref={panelRef} className="relative w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl max-h-[92dvh] overflow-y-auto no-scrollbar overscroll-contain pb-safe animate-sheet-in" style={{ background: "var(--card)" }}>
        <div className="sticky top-0 backdrop-blur-xl px-5 pt-4 pb-3 z-10" style={{ background: "var(--card)", borderBottom: "1px solid var(--card-border)" }}>
          <div className="mx-auto w-8 h-1 rounded-full mb-3" style={{ background: "var(--muted)", opacity: 0.3 }} aria-hidden />
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-lg">{editingTx ? "Edit transaction" : "Log transaction"}</h2>
            <button onClick={onClose} className="p-2.5 -m-1 min-w-[44px] min-h-[44px] flex items-center justify-center" style={{ color: "var(--muted)" }} aria-label="Close">
              <X size={20} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1 mt-3 p-1 rounded-xl" style={{ background: "var(--surface)" }}>
            {(["expense", "income", "transfer"] as TxType[]).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                aria-pressed={type === t}
                className={`py-2.5 rounded-lg text-sm font-semibold min-h-[44px] transition-all ${
                  type === t
                    ? "text-white shadow-sm"
                    : ""
                }`}
                style={type === t
                  ? { background: t === "expense" ? "#e11d48" : t === "income" ? "var(--accent)" : "#0284c7" }
                  : { color: "var(--muted)" }
                }
              >
                {t === "expense" ? "Expense" : t === "income" ? "Income" : "Transfer"}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 py-5 space-y-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-3xl font-bold" style={{ color: type === "expense" ? "#e11d48" : type === "income" ? "var(--accent)" : "#0284c7" }} aria-hidden>
                {sign}
              </span>
              <input
                ref={amountRef}
                value={amount}
                onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && save()}
                inputMode="decimal"
                type="text"
                placeholder="0"
                aria-label="Amount"
                className="flex-1 text-5xl font-extrabold tracking-tight bg-transparent outline-none focus-visible:ring-2 rounded-lg" style={{ caretColor: "var(--accent)" }}
              />
              <span className="rounded-xl px-3 py-2 text-sm font-semibold whitespace-nowrap" style={{ background: "var(--surface)" }} aria-label={`Currency ${currency}, from ${wallet?.name ?? "the account"}`}>
                {CUR_SYM[currency] ?? "$"} {currency}
              </span>
            </div>
            <p className="text-xs mt-1 h-4 font-semibold text-zinc-500" aria-live="polite">
              {amountNum > 0 ? `${sign} ${fmtMoney(amountNum, currency)}${wallet ? ` · ${wallet.name}` : ""}` : " "}
            </p>
          </div>

          <div className="flex gap-2 flex-wrap">
            {(QUICK_AMOUNTS[currency] ?? QUICK_AMOUNTS.USD).map((q) => (
              <button
                key={q}
                onClick={() => setAmount((prev) => String((Number(prev) || 0) + q))}
                className="px-4 py-2.5 rounded-full text-xs font-semibold min-h-[44px] press" style={{ background: "var(--surface)" }}
              >
                +{q.toLocaleString()}
              </button>
            ))}
          </div>

          <div>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1" style={{ color: "var(--muted)" }}>
              <WalletIcon size={13} /> {type === "transfer" ? "FROM CARD / ACCOUNT" : "CARD OR ACCOUNT USED"}
            </p>
            <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
              {activeWallets.map((w) => (
                <button
                  key={w.id}
                  onClick={() => setWalletPick(w.id)}
                  aria-pressed={walletId === w.id}
                  className="shrink-0 px-3 py-2.5 rounded-xl text-left min-h-[44px]"
                  style={walletId === w.id
                    ? { border: "2px solid var(--accent)", background: "var(--accent-light)" }
                    : { border: "1px solid var(--card-border)" }
                  }
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: w.color }} />
                    {w.name}
                    {w.last4 ? <span className="font-mono" style={{ color: "var(--muted)" }}>•{w.last4}</span> : null}
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--muted)" }}>{w.currency}</span>
                </button>
              ))}
            </div>
            {type === "transfer" && (
              <div className="mt-2">
                <p className="text-xs font-semibold mb-2 flex items-center gap-1" style={{ color: "var(--muted)" }}>
                  <ArrowLeftRight size={13} /> TO (same currency: {currency})
                </p>
                {destOptions.length === 0 ? (
                  <p className="text-xs text-amber-600">No other account uses {currency}. Add one under Cards to transfer.</p>
                ) : (
                  <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                    {destOptions.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => setToPick(w.id)}
                      aria-pressed={toWalletId === w.id}
                      className="shrink-0 px-3 py-2.5 rounded-xl text-sm font-semibold min-h-[44px]"
                      style={toWalletId === w.id
                        ? { border: "2px solid #0284c7", background: "rgba(2,132,199,0.08)" }
                        : { border: "1px solid var(--card-border)" }
                      }
                      >
                        {w.name}
                      </button>
                    ))}
                  </div>
                )}
                {destWallet && <p className="sr-only">Destination: {destWallet.name}</p>}
              </div>
            )}
          </div>

          {type !== "transfer" && (
            <div>
              <p className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>CATEGORY</p>
              <div className="grid grid-cols-4 gap-2">
                {visibleCats.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setCatPick(c.id)}
                    aria-pressed={categoryId === c.id}
                    className="flex flex-col items-center gap-1 p-2.5 rounded-xl text-xs font-semibold min-h-[44px]"
                    style={categoryId === c.id
                      ? { border: "2px solid var(--accent)", background: "var(--accent-light)" }
                      : { border: "1px solid var(--card-border)" }
                    }
                  >
                    <span className="text-xl" aria-hidden>{c.icon}</span>
                    <span className={`truncate w-full text-center ${c.parentId ? "pl-2 text-left" : ""}`}>
                      {c.parentId ? `↳ ${c.name}` : c.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2">
            <label className="sr-only" htmlFor="qa-note">Note</label>
            <input
              id="qa-note"
              value={note}
              maxLength={140}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional): e.g. lunch, taxi"
              className="w-full rounded-xl bg-transparent px-3 py-2.5 text-sm outline-none focus-visible:ring-2 min-h-[44px]"
              style={{ border: "1px solid var(--card-border)", background: "var(--surface)" }}
            />
            <div className="flex gap-2">
              <label className="sr-only" htmlFor="qa-date">Date</label>
              <input
                id="qa-date"
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="flex-1 rounded-xl bg-transparent px-3 py-2.5 text-sm outline-none min-h-[44px]"
                style={{ border: "1px solid var(--card-border)", background: "var(--surface)" }}
              />
              <label className="flex items-center gap-1 px-3 rounded-xl text-sm cursor-pointer min-h-[44px] focus-within:ring-2" style={{ border: "1px solid var(--card-border)", background: "var(--surface)" }}>
                <Camera size={16} aria-hidden />
                {image ? "✓" : "Photo"}
                <input type="file" accept="image/*" aria-label="Add receipt photo" className="sr-only" onChange={(e) => onPhoto(e.target.files?.[0])} />
              </label>
            </div>
          </div>

          <button
            onClick={save}
            disabled={!canSave || saving}
            className="w-full py-4 rounded-2xl text-white font-bold text-lg disabled:opacity-40 active:scale-[0.99] focus-visible:ring-2 ring-offset-2 press" style={{ background: "var(--accent)" }}
          >
            {saving ? "Saving…" : editingTx ? "Update" : `Save ${type === "expense" ? "expense" : type === "income" ? "income" : "transfer"}`}
          </button>
          {disabledReason && !saving && <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">{disabledReason}</p>}
          {saveError && <p role="alert" className="text-center text-xs text-rose-600 dark:text-rose-400 font-semibold">{saveError}</p>}
          <p className="text-center text-[11px] pb-2" style={{ color: "var(--muted)" }}>Your transactions stay only on this phone</p>
        </div>
      </div>
    </div>
  );
}
