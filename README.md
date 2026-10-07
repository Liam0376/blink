# Blink ⚡

A personal expense tracker that logs an expense in about three seconds. No
accounts, no paywall, no analytics. Everything you enter stays in your
browser.

**[Try it →](https://blinkdemo.vercel.app)**

## Privacy model

- Wallets, transactions, debts and settings live in **IndexedDB and
  localStorage on your device**. Nothing is sent anywhere.
- Receipt photos are re-encoded before storage (EXIF and GPS stripped), and
  never leave the device.
- Fonts are self-hosted at build time, so the page never calls Google Fonts.
  A content security policy ships in `next.config.ts`.
- **Caveats worth knowing:** the first load and each update come over the
  network, so the host sees connection metadata. JSON and CSV exports are
  plaintext files outside the app, and the in-app wipe does not touch them.

## Install it like an app

1. Open the link in Safari (or Chrome)
2. Share → **Add to Home Screen**
3. It opens fullscreen and works offline

One quirk on iOS: a web app added to the Home Screen gets its own storage
container, separate from the Safari tab. Data entered in one is invisible to
the other, so pick one and stay with it.

## What's in it

- Quick-add for expense, income and transfer, remembering your last card and
  category
- Cards and accounts with last-4, per-wallet balances, transfers
- Categories and subcategories, with spend rolling up to the parent
- Stats: bars by week/month/year, donut by category, any 3-letter currency
- Budgets, weekly to yearly, total or per category
- Debts owed and owing, recurring entries with optional end dates
- Notes and receipt photos, stored locally
- History grouped by day, with search and filter
- JSON backup and restore, CSV import and export, an integrity check, and wipe

## Run it locally

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # unit tests: formatting, balances, budgets, stats, audit
npm run build   # production build + PWA routes
```

## Bookkeeping rules

These are enforced in code, not just convention:

- A movement's currency is locked to its wallet's currency, and transfers only
  run between same-currency accounts. One amount can never post 1:1 across two
  currencies. A wallet's currency freezes once set.
- Wallets and categories in use cannot be deleted, only archived, so history
  and budgets never silently restate.
- Balances are the opening balance plus the ledger. Subcategory spend rolls up
  to parent budgets and charts.
- CSV export neutralizes spreadsheet formulas (`=`, `+`, `-`, `@` get a `'`
  prefix) and includes the transfer destination leg.

## Stack

Next.js 16 App Router, Tailwind v4, Dexie for IndexedDB, lucide-react for
icons. No backend, no analytics.

## Layout

- `app/page.tsx` — app shell, tabs, and the money math wiring
- `app/layout.tsx`, `app/manifest.ts`, `app/icon.tsx` — PWA installability
- `lib/db.ts` — Dexie schema
- `lib/seed.ts` — first-run defaults
- `lib/balances.ts`, `lib/stats.ts`, `lib/format.ts`, `lib/audit.ts` — pure
  logic, unit-tested
- `components/QuickAdd.tsx` — the entry sheet
- `components/Managers.tsx` — wallets, categories, budgets, debts, recurring,
  settings
- `components/Charts.tsx` — hand-rolled bars and donut, no chart library
