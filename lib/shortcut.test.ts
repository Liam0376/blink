import { describe, expect, it } from "vitest";
import type { Category, Wallet } from "./db";
import { matchCategory, matchWallet, normText } from "./shortcut";

const wallets: Wallet[] = [
  { id: "w1", name: "Efectivo", kind: "cash", color: "#16a34a", currency: "CRC", createdAt: "2026-01-01" },
  { id: "w2", name: "Tarjeta principal", kind: "card", last4: "4821", color: "#2563eb", currency: "CRC", createdAt: "2026-01-01" },
  { id: "w3", name: "Ahorros USD", kind: "bank", color: "#0d9488", currency: "USD", createdAt: "2026-01-01" },
];

const categories: Category[] = [
  { id: "c10", name: "Comida", icon: "🍽️", color: "#f59e0b", kind: "expense" },
  { id: "c11", name: "Súper", icon: "🧺", color: "#f59e0b", kind: "expense", parentId: "c10" },
  { id: "c12", name: "Salario", icon: "💼", color: "#34d399", kind: "income" },
];

describe("matchWallet / matchCategory", () => {
  it("matches name case-insensitively, prefers non-archived", () => {
    expect(matchWallet("efectivo", wallets)?.id).toBe("w1");
    const withArchived: Wallet[] = [...wallets, { id: "w9", name: "Efectivo", kind: "cash", color: "#000", currency: "CRC", archived: true, createdAt: "" }];
    expect(matchWallet("Efectivo", withArchived)?.id).toBe("w1");
  });

  it("matches wallet by last4", () => {
    expect(matchWallet("4821", wallets)?.id).toBe("w2");
  });

  it("returns undefined on no match", () => {
    expect(matchWallet("No existe", wallets)).toBeUndefined();
    expect(matchCategory("No existe", categories, "expense")).toBeUndefined();
  });

  it("scopes category by kind first", () => {
    expect(matchCategory("Salario", categories, "income")?.id).toBe("c12");
  });

  it("matches accent-insensitively (super finds Súper)", () => {
    expect(matchCategory("super", categories, "expense")?.id).toBe("c11");
    expect(matchCategory("SUPER", categories, "expense")?.id).toBe("c11");
    expect(matchCategory("súper", categories, "expense")?.id).toBe("c11");
  });
});

describe("normText", () => {
  it("lowercases, trims, and strips Spanish accents", () => {
    expect(normText("Súper")).toBe("super");
    expect(normText("  JOSÉ ")).toBe("jose");
    expect(normText("niño")).toBe("nino");
    expect(normText("camión")).toBe("camion");
    expect(normText("Efectivo")).toBe("efectivo");
  });

  it("lets an unaccented query match accented text (history search)", () => {
    const hay = normText("Súper Efectivo almuerzo");
    expect(hay.includes(normText("super"))).toBe(true);
    expect(hay.includes(normText("SÚPER"))).toBe(true);
  });
});
