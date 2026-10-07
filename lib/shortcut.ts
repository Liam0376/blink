import type { Category, Wallet } from "./db";

export function browserKV(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Search/match folding for Spanish text: lowercase + trim + strip accents,
 * so "super" matches "Súper" (`toLowerCase()` alone won't strip accents).
 * Used by the history search in app/page.tsx and wallet/category matching
 * below (in turn used by CSV import in lib/format.ts).
 */
export function normText(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function matchWallet(q: string | null | undefined, wallets: Wallet[]): Wallet | undefined {
  if (!q || wallets.length === 0) return undefined;
  const n = normText(q);
  const digits = q.replace(/\D/g, "");
  const pool = [...wallets.filter((w) => !w.archived), ...wallets.filter((w) => w.archived)];
  return (
    pool.find((w) => normText(w.name) === n) ??
    (digits ? pool.find((w) => (w.last4 ?? "") !== "" && (w.last4 === digits || w.last4 === digits.slice(-4))) : undefined)
  );
}

export function matchCategory(
  q: string | null | undefined,
  categories: Category[],
  kind: "expense" | "income"
): Category | undefined {
  if (!q) return undefined;
  const n = normText(q);
  return (
    categories.find((c) => c.kind === kind && normText(c.name) === n) ??
    categories.find((c) => normText(c.name) === n)
  );
}
