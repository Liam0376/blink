<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Finance-app (Blink)

Local-only expense tracker. Next.js 16 App Router + Tailwind v4 + Dexie (IndexedDB) + lucide-react. No backend, no accounts, no analytics. `private: true` — not meant to ship.

## Commands

- `npm run dev` — http://localhost:3000 (`npm install` first)
- `npm test` — `vitest run`; only matches `lib/**/*.test.ts` (node env). Single test: `npx vitest run lib/<name>.test.ts`
- `npm run lint` — eslint (next core-web-vitals + typescript)
- `npm run build` — production check + PWA routes
- No typecheck script — use `npx tsc --noEmit`
- No CI, no `opencode.json`, no pre-commit.

## Architecture

- `app/page.tsx` — app shell, tabs, all money-memo chain (`balanceByWallet` / `grownBalanceByWallet` / `cashbackByWallet`).
- `lib/db.ts` — Dexie schema (`blink`): wallets, categories, transactions, budgets, debts, recurring. `lib/seed.ts` first-run defaults.
- `lib/balances.ts`, `lib/format.ts`, `lib/stats.ts`, `lib/audit.ts`, `lib/shortcut.ts` — pure logic, unit-tested. Tests must call the REAL functions (see `lib/balance.test.ts` header), never a reimplementation.
- `components/QuickAdd.tsx` (entry sheet), `components/Managers.tsx` (wallets/categories/budgets/debts/recurring/settings), `components/Charts.tsx` (hand-rolled bars + donut, no chart lib).
- Path alias `@/*` → repo root.

## Gotchas that cause real bugs

- **Paginated vs full transactions** (`app/page.tsx`): `transactions` is capped at `historyLimit` (120) for list rendering. All money math (balances, stats, budgets) must read `allTransactions` (`db.transactions.toArray()`). Using the paginated query silently undercounts.
- **Bookkeeping invariants (enforced, see README + `lib/db.ts`):** tx currency locked to its wallet's currency; transfers same-currency only, raw amount, no FX (`netWorthFromBalances` groups by currency, never converts); wallet currency freezes once set; wallets/categories in use can't be deleted — archive instead; balance = `openingBalance` + ledger with `roundCents` per operation.
- **ROI is display-only projection:** never persisted as transactions. `growBalance` steps whole UTC days only; rate changes are prospective via `roiRateSince` anchor (`computeGrownBalances` uses max(last activity, `roiRateSince`)). `roiAnnualPct` only on `kind !== "card"`.
- **Cashback frozen at creation:** `computeCashback` (expense + `kind === "card"` + positive pct only) snapshots to `Transaction.cashbackEarned` once; never recompute from current rate. CSV-imported rows have no `cashbackEarned` by design. `cashbackOpening` is a display baseline like `openingBalance`.
- **Recurring:** auto-logged on app open via `advanceRecurringPastNow` with a ref guard against double-fire across renders. Monthly uses `anchorDay` (Jan 31 → Feb 28 → Mar 31, no drift). `endDate` optional = forever.
- **Currency:** free-form string, validated as `/^[A-Z]{3}$/` at intake — never a closed union. `CURRENCIES` (MXN/USD/EUR) are suggestions only; customs sort after. `fmtMoney` falls back to `"<n> <CODE>"` for unknown codes instead of crashing.
- **Amounts:** `sanitizeAmountInput` maps `,` → `.` (es-CR decimal); garbage parses to NaN and must fail closed. CSV export prefixes `= + - @` with `'` (formula injection) and includes the transfer destination leg.
- **Dexie migrations:** plain (unindexed) props need no version bump — v1/v2 share the same stores list deliberately. Only add a version when indexes change.
- **Theme must never be rendered into markup** (`app/page.tsx` theme toggle): Node has no `localStorage`, so the lazy initializer falls through to `catch` and SSR always renders light. Any dark-mode load then disagrees with the server HTML, and React 19 throws a hydration mismatch that re-renders the whole tree client-side, on every load. Let CSS read the `.dark` class the pre-paint script already set. `Managers.tsx`'s Settings switch still renders `dark`, but only mounts after tapping More and expanding the section, so it can't reach hydration — convert it too if that ever changes.

## Platform / ops quirks

- **iOS storage isolation:** home-screen web app and Safari tab on the same origin get separate IndexedDB containers, so the two never see each other's data. Don't build a feature that assumes they share storage.
- **iOS cold-open IndexedDB race:** `seedIfEmpty` retries with backoff (0/300/800ms) in `app/page.tsx`; keep the retry, log real errors to devtools.
- **PWA:** `public/sw.js` (skipWaiting + clients.claim) + `RegisterSW.tsx` prompts reload but never auto-reloads — QuickAdd may hold unsaved form/photo state.
- **iOS 27 top blur:** home-screen web apps get a system blur over the status bar plus ~20px below it. No CSS, meta tag or JS flag turns it off, and `navigator.standalone` reports false there. `--status-bar-blur-gap` in `app/globals.css` pads `.pt-safe` clear of it, applied unconditionally. Don't re-gate it behind a standalone check.
- **CSP** (`next.config.ts`): `unsafe-inline` scripts required (Next boot + pre-paint theme script in `app/layout.tsx`); `unsafe-eval` is dev-only. `allowedDevOrigins` has a hardcoded LAN IP — adjust for DHCP, don't commit per-device IPs permanently.
- Fonts self-hosted at build; receipt photos stored as local dataURLs (re-encoded, EXIF stripped). `graphify-out*/` and `.next-root-owned-orphan-*/` are gitignored — Tailwind scanner must keep skipping them.
- `.env*` gitignored (Vercel-CLI created); nothing required for local dev.
