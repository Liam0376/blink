import type {
  Budget,
  Category,
  Debt,
  Recurring,
  Transaction,
  Wallet,
} from "../db";

/** Generate a v4 UUID record id. */
export const newId = (): string => crypto.randomUUID();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True only for well-formed v4 UUID strings (ids are string | number | undefined). */
export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface BooksShape {
  wallets: Wallet[];
  categories: Category[];
  transactions: Transaction[];
  budgets: Budget[];
  debts: Debt[];
  recurring: Recurring[];
}

/** [table, fk field, target table] — which field on which table points at which table. */
const FK_FIELDS: Array<[keyof BooksShape, string, keyof BooksShape]> = [
  ["categories", "parentId", "categories"],
  ["transactions", "walletId", "wallets"],
  ["transactions", "toWalletId", "wallets"],
  ["transactions", "categoryId", "categories"],
  ["budgets", "categoryId", "categories"],
  ["recurring", "walletId", "wallets"],
  ["recurring", "categoryId", "categories"],
];

/** Legacy snapshots use numeric ids; the re-key path must still accept them. */
export type LegacyBooks = Record<keyof BooksShape, Array<Record<string, unknown>>>;

type RemappedBooks<T> = T extends BooksShape ? T : BooksShape;

/**
 * Re-key a whole books snapshot: every row whose id is not already a UUID gets
 * a fresh one, and every foreign key is rewritten to follow. Keys of `map`
 * are `${table}:${oldId}` because an old integer id is only unique within its
 * own table. Pure — returns a new books object, input untouched. Idempotent:
 * rows and FKs that are already UUIDs pass through unchanged, and a missing
 * map entry (orphan FK) is left as-is rather than inventing a target.
 */
export function remapIds<T extends BooksShape | LegacyBooks>(
  books: T,
): { books: RemappedBooks<T>; map: Map<string, string> } {
  // Rows carry string ids after remap. The input stays tolerant of legacy
  // numeric rows because re-keying those is this function's job.
  const source = books as LegacyBooks;
  const out: LegacyBooks = { ...source };
  const map = new Map<string, string>();

  for (const table of Object.keys(source) as Array<keyof BooksShape>) {
    out[table] = source[table].map((row) =>
      isUuid(row.id) || row.id === undefined
        ? { ...row }
        : replaceId(table, row, map),
    );
  }

  for (const [table, field, target] of FK_FIELDS) {
    out[table] = out[table].map((row) => remapField(row, field, target, map));
  }

  return { books: out as unknown as RemappedBooks<T>, map };
}

function replaceId(table: string, row: Record<string, unknown>, map: Map<string, string>) {
  const uuid = newId();
  map.set(`${table}:${String(row.id)}`, uuid);
  return { ...row, id: uuid };
}

/**
 * Rewrite one FK field via the map. A miss (an orphan, or a value that was
 * never re-keyed) leaves the field alone. The lookup is by value, not by
 * type: rows may carry string ids that are not UUIDs yet, and those are
 * re-keyed exactly like integer ones.
 */
function remapField(
  row: Record<string, unknown>,
  field: string,
  target: string,
  map: Map<string, string>,
) {
  const old = row[field];
  if (old === undefined || old === null) return row;
  const mapped = map.get(`${target}:${old}`);
  if (mapped === undefined) return row;
  return { ...row, [field]: mapped };
}
