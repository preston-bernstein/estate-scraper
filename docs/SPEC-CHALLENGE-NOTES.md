# Spec Challenge Notes

## Agents run
- Integration Verifier (haiku) — 5 issues found, 5 accepted (all expected future-state contradictions; confirmed all files exist)
- Scope Auditor (haiku) — 14 issues found, 8 accepted
- Design Devil's Advocate (sonnet) — 10 issues found, 8 accepted
- Implementation Realist (sonnet) — 10 issues found, 9 accepted
- Data Model Critic (sonnet) — 12 issues found, 9 accepted

## Changes made to spec

- **Scan schedule corrected to single run, Thursday 2AM** — user confirmed "running once"; original spec had three weekly runs. One scan per week, Thursday 2AM local, data serves Thu/Fri/Sat. ADR 0008 updated accordingly.
- **Transaction granularity changed from per-scan to per-sale** — a 30-min open write lock on `better-sqlite3` (synchronous driver) is a silent no-op when given an async callback, and a failure mid-scan loses all accumulated data. Per-sale transactions are atomic, survivable, and compatible with the sync driver. `scan/index.ts` added to integration points since function signatures change.
- **`searchQuery` state architecture specified** — React 19 `use()` in `DiscoverContent` suspends; state inside a suspended component doesn't render during load. Spec now requires search input to live in a parent wrapper outside the `<Suspense>` boundary, with `searchQuery` threaded as a prop. `DiscoverPage` becomes a two-component file.
- **Search query reflected in URL (`?q=`)** — two lines of React Router, makes the view shareable and refresh-safe. The defining Google behavior the aesthetic was trying to capture.
- **Standout scroll stays global (not filtered by search)** — filtering the hero strip produces a blank "wow moment" for niche queries. Standouts always show global top picks; only the sale card list filters.
- **`notifications.address` renamed to `destination`** — `sales.address` is a street address; reusing `address` for an email/phone in the same schema file creates semantic confusion for every future reader.
- **`notifications.channel` changed from Drizzle enum to plain text** — SQLite requires a full table rebuild to add a CHECK constraint value; "push"/"webhook" are non-exotic future channels. Enum enforced at app layer.
- **Existing FK indexes added in same migration** — `findings.saleId`, `planItems.saleId`, `hunts.ownerSub` had no indexes. These hit on every post-scan read and every browse request.
- **Inactive chips get a border** — plain text with no affordance reads as a label, not a button. `border border-zinc-200 dark:border-zinc-700` matches Google Material chip spec.
- **`caffeinate -s` wrapper added to run-scan.sh** — LaunchAgent silently skips if machine sleeps; caffeinate prevents it.

## Critiques rejected

- **FTS5 from day one** — scope expansion not justified; topFindings search coverage acknowledged as known limitation.
- **LaunchDaemon instead of LaunchAgent** — root-level install complexity not worth it; caffeinate handles the sleep problem adequately for a homelab tool.
- **Don't add notifications table until auth works** — ALTER TABLE risk when ownerSub format diverges is lower than migration risk against live accumulated data.
- **ownerSub FK to userSettings** — hunts and planItems both skip this; consistent existing pattern.
- **Per-character channel/address cross-validation** — enforced at delivery-implementation time; not needed for an inert schema table.
- **Integration Verifier contradictions** — all five were expected future-state changes correctly described; not spec errors.

## Open questions requiring human input

1. **Notification settings UI location** — `/settings` (new route) vs inside `/hunts`. Recommendation: `/settings`. Decide before building delivery implementation.
