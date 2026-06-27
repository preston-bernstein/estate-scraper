# Dashboard UX Refresh, Client Search, Multi-Day Scan, and Notify Architecture

## Goal

Give a solo user logging in Thursday–Saturday mornings an immediately useful view — ranked finds front and center, a search bar to drill down fast, and a clean Google-ish aesthetic — while fixing scan cadence and laying the groundwork for future email/SMS alerts.

## Scope

**In scope:**
- Text search bar on the Discover page: client-side, 150ms debounce, filters title + city + topFindings descriptions; query reflected in URL (`?q=`)
- Scan schedule: one LaunchAgent entry, Thursday at 2:00 AM local; `caffeinate -s` wrapper to prevent sleep-skip
- SQLite write performance: wrap per-sale inserts in a transaction (one transaction per sale, not one for the entire scan run)
- `notifications` table added to schema; no delivery implementation yet
- Design alignment with Google's discovery philosophy: search bar prominence, chip affordance borders, active chip solid filled, dynamic category counts
- Existing missing FK indexes added: `findings.saleId`, `planItems.saleId`, `hunts.ownerSub`

**Out of scope:**
- Email or SMS delivery implementation
- Authentik OIDC setup (existing blocker, tracked separately)
- New pages or routes (no `/settings` route this sprint)
- BrowsePage changes
- Server-side SQLite FTS5 full-text search
- Any change to the ChatPanel or LLM integration (already shipped)
- Notification settings UI (open question, deferred — see below)

**Known limitations:**
- Text search covers only the `topFindings` (up to 6 per sale) returned by `GET /api/discover`, not all Findings in the database. A Finding that ranks 7th or lower is invisible to search. FTS5 is the resolution path when this becomes a real problem.

## Domain terms

Existing terms (Sale, Finding, Hunt, Scan, Radius, Home, Plan, Standout) are unchanged per CONTEXT.md.

## Design decisions

**1. Search is client-side only**
The `GET /api/discover` response contains all ranked sales and their topFindings descriptions. Filtering 50–200 sales in memory is instant. The known limitation (top-6 Findings per sale only) is acceptable at this scale; FTS5 is the stated fallback path. Rejected: FTS5 from day one — scope expansion not justified by current data volume.

**2. Search query is reflected in the URL**
`useSearchParams` (`?q=turntable`) — two lines of React Router, makes the view shareable and refresh-safe. Rejected: component state only — loses query on refresh and makes the feature un-shareable. This is the defining Google behavior the spec is trying to capture.

**3. Search input has a 150ms debounce**
`useRef` + `useEffect` debounce prevents per-keystroke filtering overhead as data volume grows. Fires `onChange` immediately on clear. Rejected: no debounce — technically fine today, requires a non-trivial state refactor when data grows or Findings-per-sale increases.

**4. Text filter and category chip use AND semantics; CategoryStrip counts update dynamically**
When both a query and a category are active, a sale must satisfy both. The CategoryStrip receives counts computed from the text-filtered set, not the full set — "Furniture (12)" is accurate for the current query, not the full week. This is the most user-visible filtering behavior and must be a named decision, not an implicit one. Rejected: OR semantics — unintuitive when combined with category chips.

**5. `searchQuery` state lives in a parent wrapper above `DiscoverContent`**
`DiscoverContent` uses React 19's `use(cached(...))` which throws a Promise and suspends. State inside a suspending component does not render until the data resolves — the search bar would be invisible during load. The search input must be rendered by a parent component outside the `<Suspense>` boundary, with `searchQuery` and `setSearchQuery` threaded down as props. The `DiscoverPage` export becomes a two-component file: outer wrapper (state, URL sync, search bar, Suspense) + inner `DiscoverContent` (data fetch, filtering, rendering).

**6. Standout scroll is NOT filtered by search query**
The Standout scroll is the page's "wow" moment — the spec's own primary goal. Filtering it means niche queries (searching "taxidermy") produce a blank strip above the filtered results, inverting the information hierarchy. Standouts always show the global top picks for the week regardless of query. Rejected (previous decision 4): filtering Standouts for "consistency" — the cost of an empty hero strip outweighs the philosophical benefit.

**7. Inactive category chips have a border**
`border border-zinc-200 dark:border-zinc-700` on inactive chips signals interactivity; plain text with no affordance reads as a label, not a button. This matches Google's actual Material Design chip spec (outlined variant), not just the aesthetic memory of it. Active chip remains solid filled (`bg-zinc-900 text-zinc-50`).

**8. Scan runs once per week, Thursday at 2:00 AM local, with caffeinate**
One scan per week. Thursday 2AM local time produces fresh data for Thursday morning check-in; same dataset serves Friday and Saturday browsing. `caffeinate -s` in `run-scan.sh` prevents macOS sleep from causing a silent miss. Scan writes to shared `sales` and `findings` tables — no user context is involved. All users see the same underlying data; personalization happens at browse time via Hunts. LaunchAgent fires in active user session only — powered-off machine misses the run; accepted for a homelab tool. Rejected: three weekly runs (Wed/Thu/Fri) — "we are only running once" per user clarification; one scan is sufficient since estate sale listings stabilize by Wednesday night.

**9. Transaction granularity: one transaction per sale, not per scan run**
Wrapping the entire scan (scraping + vision + inserts) in a single transaction would hold a SQLite write lock open for ~30 minutes of GPU inference time. `better-sqlite3` (the underlying driver) only accepts a synchronous callback in `db.transaction()`; passing an async callback returns a Promise, which commits immediately without awaiting the inner work — the transaction is silently a no-op. Per-sale transactions are safe, atomic, and compatible with the sync driver: for each scraped sale, wrap `upsertSale` + all of that sale's `insertFinding` calls in one synchronous-compatible unit. A scan failure mid-run preserves all previously committed sales.

**10. `notifications` table added now; channel stored as plain text**
Adding the table before delivery avoids a migration against live data later. The `channel` column is plain `text`, not a Drizzle enum — SQLite requires a full table rebuild to add a CHECK constraint value, and "push" / "webhook" are non-exotic future channels. The enum is enforced at the application layer. The `ownerSub` format may diverge from the final Authentik identity claim; accepted risk since the table will have zero rows when auth ships and can be migrated cheaply then. Rejected: don't add the table until auth is working — the ownerSub migration risk is lower than the data-accumulation migration risk.

**11. Google design → three concrete UI changes**
(a) Search bar: `rounded-full`, full-width, `ring-2 ring-blue-500` on focus, × clear button (appears only when query is non-empty). No submit button — filter applies via debounced `onChange`. Placeholder: "Search sales, items, cities…"
(b) Category chip strip: active chip solid filled (`bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900`). Inactive chips gain `border border-zinc-200 dark:border-zinc-700` for interactivity affordance. Counts inside the label in a dimmed span, computed from the text-filtered set.
(c) Scan status remains a compact subtitle in the sticky header (already implemented); no changes needed.

## Data model changes

**Add to `api/src/db/schema.ts`:**
```ts
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerSub: text("owner_sub").notNull(),
  channel: text("channel").notNull(),             // "email" | "sms" — enforced at app layer, not DB
  destination: text("destination").notNull(),     // email address or E.164 phone number
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => ({
  uniqOwnerChannelDest: unique().on(t.ownerSub, t.channel, t.destination),
  idxOwnerActive: index("idx_notifications_owner_active").on(t.ownerSub, t.active),
}));
```

**Add indexes to existing tables in `api/src/db/schema.ts`:**
```ts
// findings table — add index on saleId (FK, used in every post-scan read)
export const findings = sqliteTable("findings", { /* existing columns */ }, (t) => ({
  idxSaleId: index("idx_findings_sale_id").on(t.saleId),
}));

// planItems table — add index on saleId (FK)
export const planItems = sqliteTable("plan_items", { /* existing columns */ }, (t) => ({
  idxSaleId: index("idx_plan_items_sale_id").on(t.saleId),
}));

// hunts table — add index on ownerSub (queried every scan run)
export const hunts = sqliteTable("hunts", { /* existing columns */ }, (t) => ({
  idxOwnerSub: index("idx_hunts_owner_sub").on(t.ownerSub),
}));
```

Run `drizzle-kit generate` then `drizzle-kit migrate` (or `runMigrations()` at API start picks it up automatically via the existing runner).

## Interface contract

`GET /api/discover` — unchanged. Client-side search operates on the existing `{ rankedSales, standouts }` response shape.

`RankedSale.topFindings[].description` is the text field searched per sale's Findings. `Standout.description` is the field on each Standout item (search does NOT filter Standouts).

Future (out of scope now):
- `GET /api/notifications` → `{ notifications: Notification[] }`
- `POST /api/notifications` → create/update a channel
- `DELETE /api/notifications/:id` → remove a channel

## Integration points

Implement in this order (schema + migration must exist before any TS import of `notifications`):

| Order | File | Change |
|---|---|---|
| 1 | `api/src/db/schema.ts` | Add `notifications` table + indexes on `findings`, `planItems`, `hunts` (see Data model changes) |
| 2 | `api/src/scan/persist.ts` | Change `upsertSale` and `insertFinding` signatures to accept an optional `tx` param; implement per-sale transaction helper (see note below) |
| 3 | `api/src/scan/index.ts` | Update callers of `upsertSale` / `insertFinding` to use per-sale transaction |
| 4 | `scripts/run-scan.sh` | Wrap invocation with `caffeinate -s` |
| 5 | `scripts/com.estate-scraper.scan.plist` | Update single `StartCalendarInterval` dict to `{Weekday: 4, Hour: 2, Minute: 0}` (Thursday 2AM local) |
| 6 | `ui/src/pages/DiscoverPage.tsx` | Restructure: outer `DiscoverPage` holds `searchQuery` state + URL sync + search bar + `<Suspense>`; inner `DiscoverContent` receives `searchQuery` as prop and handles filtering + rendering. Counts passed to `CategoryStrip` must be computed from the text-filtered set, not the full set. |
| 7 | `ui/src/components/CategoryStrip.tsx` | Active chip: `bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50` → `bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900`. Inactive chips: add `border border-zinc-200 dark:border-zinc-700`. |
| 8 | `CONTEXT.md` | Verify Standout term is present (already added) |

**Per-sale transaction pattern for `persist.ts`:**
`better-sqlite3` requires a synchronous callback. Drizzle wraps it, so `db.transaction()` at the Drizzle level is async-compatible — but the inserts within must complete before the callback returns. Because `insertFinding` is currently called inside `for await (const event of processSalesStream(...))`, the per-sale batch must be buffered: collect all findings for a sale after `sale_done` event fires, then write sale + findings in one synchronous-compatible transaction block. Alternatively, change `scan/index.ts` to buffer findings per sale in memory and flush them after the generator signals `sale_done`.

## Open questions

1. **Notification settings UI location** — When email/SMS delivery lands, should notification management live at `/settings` (new route) or inside `/hunts` (settings-adjacent)? Recommendation: `/settings`. Decide before building delivery.
