import { db } from "./db";
import { CATEGORY_COLORS } from "./palette";
import { newId } from "./sync/ids";

export async function seedIfEmpty(): Promise<void> {
  const [wCount, cCount] = await Promise.all([db.wallets.count(), db.categories.count()]);
  if (wCount > 0 && cCount > 0) return;

  const now = new Date().toISOString();

  if (wCount === 0) {
    await db.wallets.bulkAdd([
      { id: newId(), name: "Cash", kind: "cash", color: CATEGORY_COLORS[2], currency: "MXN", openingBalance: 0, createdAt: now },
      { id: newId(), name: "Main card", kind: "card", last4: "4821", color: CATEGORY_COLORS[0], currency: "MXN", openingBalance: 0, createdAt: now },
    ]);
  }

  if (cCount === 0) {
    const expense: Array<[string, string, string]> = [
      ["Food", "🍽️", CATEGORY_COLORS[6]],
      ["Transport", "🚌", CATEGORY_COLORS[5]],
      ["Shopping", "🛍️", CATEGORY_COLORS[3]],
      ["Bills", "🧾", CATEGORY_COLORS[9]],
      ["Health", "❤️", CATEGORY_COLORS[1]],
      ["Fun", "🎮", CATEGORY_COLORS[8]],
      ["Coffee", "☕", CATEGORY_COLORS[4]],
      ["Other", "•••", CATEGORY_COLORS[7]],
    ];
    const income: Array<[string, string, string]> = [
      ["Salary", "💼", CATEGORY_COLORS[2]],
      ["Extra", "✨", CATEGORY_COLORS[0]],
    ];
    await db.categories.bulkAdd([
      ...expense.map(([name, icon, color]) => ({ id: newId(), name, icon, color, kind: "expense" as const })),
      ...income.map(([name, icon, color]) => ({ id: newId(), name, icon, color, kind: "income" as const })),
    ]);

    // Subcategories: Food > Groceries / Restaurant (inherit parent color for roll-up)
    const comida = await db.categories.where("name").equals("Food").first();
    if (comida?.id) {
      await db.categories.bulkAdd([
        { id: newId(), name: "Groceries", icon: "🧺", color: comida.color, kind: "expense", parentId: comida.id },
        { id: newId(), name: "Restaurant", icon: "🍔", color: comida.color, kind: "expense", parentId: comida.id },
      ]);
    }
  }
}
