# Repo Challenge — estate-scraper (2026-07-02)

Eight parallel challenger agents (architecture, correctness, security, DRY, performance, readability, tests, API/DX) reviewed the repo against Google eng-practices, the Google TS style guide, and 2025–26 stack-specific practice. ~50 raw findings, triaged and deduped to the list below. Report only — no source was modified.

## Verdict

The codebase is healthy and clearly improving: the domain model is disciplined (locked vocabulary, ADR-cited schema, clean vision→persist event boundary), persistence ordering is careful, and query layers avoid N+1 throughout. The two concentrations of risk are **auth verification** (unpinned `jwtVerify`, fail-open mode default, spoofable forwarded headers — three independent ways to become another user) and the **scan state file** (non-atomic full-file rewrites racing a 1s poller — torn reads kill the SSE stream and can double-spawn a paid scan). The single highest-leverage fix is hardening `api/src/middleware/auth.ts`: pin issuer/audience/alg, deny on unknown `AUTH_MODE`, and stop trusting identity headers on a directly-reachable port.

## What's genuinely good

- **The vision→scan event boundary.** `vision/index.ts` has zero DB knowledge; `scan/index.ts` owns all persistence, so ADR 0013/0014 corpus rules live in exactly one consumer. Event variants cite the ADRs that motivated them.
- **Schema encodes its one-way doors.** Generator provenance (`embedModel`, `vlmModel`, `promptVersion` per ADR 0016), idempotency via `unique(saleId, imageUrl)`, columns commented with their justifying ADR.
- **Persistence ordering discipline.** Images before findings, coalesce-on-conflict never clobbers captured phash/thumbnails, embed pass sequenced after persistence so a crash can't lose findings.
- **Risk-driven tests where they exist.** `persist.test.ts` is a real integration test written because a unit test couldn't catch the async-transaction bug it guards; `hasFindings.test.ts` covers the parser's genuinely tricky edges; `embed.test.ts` pins the ADR 0016 frozen-model dimension.
- **N+1 avoidance is consistent** — `getFindingsForSales` / `findingsBySale` batch with one `inArray` query plus Map grouping; query count stays flat as sales grow.

## MUST (correctness / security)

1. **[security] `api/src/middleware/auth.ts:32`** — `jwtVerify(token, jwks)` passes no `issuer`, `audience`, or `algorithms`. Authentik commonly shares one signing cert across providers, so a token minted for *any other* OIDC app on the same IdP verifies here and impersonates its `sub` — including `SCAN_OWNER_SUB`. Same class as CVE-2025-62610 (Hono aud-validation) plus unpinned alg. **Fix:** `jwtVerify(token, jwks, { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE, algorithms: ["RS256"] })`; fail startup if either env is unset in jwt mode. (H; CVE-2025-62610, JWT algorithm-pinning guidance)

2. **[security] `api/src/middleware/auth.ts:5,37,53`** — `AUTH_MODE` defaults to `"stub"` and any *unrecognized* value falls through to `DEV_USER_SUB`. A missing `EnvironmentFile` or a typo (`AUTH_MODE=JWT`, trailing space) silently turns production into stub — every LAN client authenticated with full read/write. ADR 0006 sanctions stub for local dev only. **Fix:** in production require an explicit valid mode, `throw` at startup on unknown values, make the final fallthrough deny (`null`), not `DEV_USER_SUB`. (H)

3. **[security] `api/src/middleware/auth.ts:39-47`** — `forwarded` mode trusts `x-authentik-uid` / `x-remote-user` / `x-forwarded-user` with no verification the request came through the proxy, while the app listens directly on LAN `:3000`. Anyone on the LAN: `curl -H 'x-authentik-uid: <SCAN_OWNER_SUB>' http://desktop:3000/api/...` → full impersonation, forward-auth bypassed. **Fix:** bind to loopback so only the proxy reaches the app, and/or require a shared proxy-secret header before trusting identity headers. (H)

4. **[deps] `api/package.json:23`** — `drizzle-orm@0.43.1` carries GHSA-gpj5-g38j-94v9 (SQL injection via improperly escaped identifiers; `npm audit`: 1 high). Current call sites use parameterized `eq(...)`, but the advisory stands. **Fix:** bump to `^0.45.2`, run tests. (H; npm audit)

5. **[correctness/race] `api/src/scan/state.ts:42` + `api/src/lib/scan-runner.ts:10` + `api/src/routes/sales.ts:157,180`** — `writeFileSync` of the state file is not atomic while the API polls it every 1s. A torn read makes `JSON.parse` throw; `readScanState` swallows it and returns `running:false` — the SSE stream terminates mid-scan, `/status` flickers idle, and `startScan` hitting the same window **spawns a second concurrent paid scan**. Separately, `startScan`'s check-then-spawn has a startup window (child writes `running:true` only after boot + migrations) where a double-click double-spawns. **Fix:** write to `.tmp` then `renameSync` (atomic on POSIX); keep last-good state on parse failure; take a lock/pid file synchronously in `startScan` before spawning. (H)

6. **[correctness/perf] `api/src/scan/state.ts:64` (`pushEvent`)** — every event (~2/image → 10–25k/scan) synchronously rewrites the entire pretty-printed JSON file. Total bytes written are O(n²) — on the order of 100+ GB per scan — each write blocking the pipeline and widening the torn-read window in #5. The SSE route re-reads and re-parses the whole file every second. **Fix:** append events as NDJSON (cheap, effectively atomic per line) with the reader tracking a byte offset; keep only the small status object in the JSON state file. Don't push `analyzed_image`/`progress` into state at all — they're persisted to SQLite anyway. (H)

7. **[tests/security] `api/src/middleware/auth.ts:36-65`** — zero tests on the auth gate for every route: header precedence in `forwarded` mode, jwt-failure collapse via `.catch(() => null)`, 401 on no credentials, stub short-circuit. Untested auth compounds findings 1–3: a fix there has nothing to catch a regression. **Fix:** unit-test `resolveUserSub` per mode + one middleware-level 401 test. (H)

8. **[tests] `api/src/vision/index.ts:625-834`** — the tier/budget gate — the actual money-spending logic (`HIGH_SCORE_THRESHOLD`, `SWITCH_SCORE_THRESHOLD`, oracle min/max window, `EARLY_STOP`/`TAIL_PROBE` transitions) — has zero direct tests; only the pure `hasFindings` helper is covered. A threshold regression silently changes vision spend/quality. **Fix:** extract the phase decision as a pure function (scores → FULL | TAIL_PROBE | EARLY_STOP | oracle-fire) and unit-test the boundary values. (H)

## SHOULD (health / maintainability)

### Scan pipeline correctness
- **[correctness] `api/src/vision/index.ts:521-536` + `api/src/scan/persist.ts:60`** — pHash-dropped near-duplicates are never persisted, so they're absent from the next incremental scan's skip-set; with their partner no longer in the batch they pass dedup and get a **second paid vision pass**, persisting a near-identical finding under a different URL and inflating that sale's discover score. Multi-night incremental scans are the stated design, so this recurs. **Fix:** persist dropped dupes as `images` rows (null visionResponse, `duplicate_of` flag) so they enter the skip-set. (H)
- **[correctness] `api/src/vision/oracle.ts:81-87`** — `JSON.parse` on the raw completion fails on ```json fences (common even at temp 0.1) → oracle verdict silently dropped for exactly the uncertain-zone sales it exists for. `Number(parsed.score ?? 0)` unclamped: malformed score → NaN → NULL in SQLite, `oracle_score` diverging from `oracle_verdict`. **Fix:** strip fences / extract first `{...}`; validate `Number.isFinite(score) && score >= 1 && score <= 5` else null. (M-H)
- **[correctness] `api/src/lib/items.ts:191-217` (`extractItems`)** — `hasFindings`/`scoreResponse` filter junk lines (`: NONE`, `: 0`) but `extractItems` doesn't: a mixed response mints a `finding_items` row for "TOYS: NONE" (category `games_toys`, desirability `med`), polluting the locked corpus facets (ADR 0014/0018). **Fix:** apply the same junk-line filter in `extractItems` — and extract the duplicated predicate as `isJunkLine()` (it's copy-pasted between `hasFindings` and `scoreResponse` already, `vision/index.ts:141-147` vs `181-184`). (M-H)
- **[correctness] `api/src/vision/index.ts:510-514,206`** — `positionPct` (ADR 0014 corpus feature) is computed *after* skip-filtering, so on incremental re-scans new photos appended to a 50-photo listing get positions 0.0–1.0 instead of ~0.83–1.0 — systematically wrong position features for the multi-night incremental corpus. **Fix:** compute position against the full `sale.imageUrls` before skip-filtering. (M-H)
- **[correctness/resource] `api/src/vision/index.ts:519-541`** — all full-resolution image buffers of a sale are held in memory for its entire lifetime; a 300–800-photo listing at 2–5 MB each is 1–4 GB RSS — OOM risk on the desktop. **Fix:** after pHash, keep only the 1024px q85 re-encode (~100–300 KB) already produced in `processImage`. (M)

### Architecture & structure
- **[design] `api/src/services/discover.ts:7-70`** — a second, ad-hoc classification system (4-tag regexes, `BRAND` list) lives in the read path while `finding_items` (ADR 0018's closed 15-category vocab) is **write-only** — nothing reads it. Two sources of truth for "what is this item" will drift; the regexes already double-count ("Atari" matches both `ELECTRONICS` and `BRAND`, stacking +3 and +4). **Fix:** migrate `tagFinding`/`scoreFinding` inputs to join `finding_items`, or write an ADR stating why Discover deliberately stays regex-based. Note CONTEXT.md pins Standout at `scoreFinding() ≥ 4` — refactor of inputs, not the contract. (M)
- **[complexity] `api/src/vision/index.ts:493-839` (`processSalesStream`)** — a ~345-line generator interleaving sampling policy, execution, and event emission across 7+ branch paths sharing hand-threaded mutable state; two blocks are verbatim duplicates ("process remaining" at 640-652 vs 752-763; the early-stop epilogue at 663-684 vs 703-726). **Fix:** extract named phase functions per the file's own section dividers, with an explicit accumulator; the pure phase-decision extraction also unlocks MUST #8's tests. (H)
- **[cohesion] `api/src/services/sales.ts` (464 lines) + `api/src/routes/sales.ts`** — one service file mixes six domains (browsing, findings search, thumbnails, settings, Plan CRUD, Outcomes); settings logic lives in `services/sales.ts` while settings routes live in `routes/hunts.ts`. **Fix:** split along the locked domain language (`services/plan.ts`, `services/outcomes.ts`, `services/settings.ts`; `routes/scan.ts` etc.). Cheap now, painful later. (H)
- **[layering] `api/src/routes/hunts.ts:10-96`** — hunts routes hit `db`/`schema` directly while every other route goes route → service → db; and the hunt-ownership check (`existing.ownerSub !== ownerSub → 404`) is duplicated verbatim in `PUT /:id` and `DELETE /:id` — an authz gate where unmirrored edits reintroduce an IDOR-shaped bug. **Fix:** `services/hunts.ts` with a `getOwnedHunt(id, ownerSub)` helper used by both routes. (H)

### Duplication
- **[DRY] `api/src/services/sales.ts:105-171`** — `listUpcomingSales`/`listPastSales`/`listAllSales` triplicate the same load→filter-by-hunt→summarize body, differing only in `where`/`orderBy` and whether hunt-filtering applies. **Fix:** one `summarizeSales(where, orderBy, { filterByHunts })` helper; `buildSaleSummary` is already the right anchor. (M)
- **[DRY] `api/src/services/discover.ts`** — the finding-mapping object is built inline 3× (106-113, 152-163, 231-238) and the tag-tally loop is copy-pasted between `getDiscoverData` and `searchSales` with existing drift risk (tag `"collectible"` vs tally key `collectibles`). **Fix:** `toDiscoverFinding()` + `tallyFindings()` helpers. (H)
- **[DRY] `ui/src/lib/api.ts:129-217`** — `streamScan` and `streamChat` both hand-roll the fetch→reader→decoder→line-buffer→parse loop; a partial-line fix in one won't reach the other. **Fix:** shared `readEventStream(response, { onEvent })`. (M)
- **[DRY] `ui/src/pages/` (Browse, History, Hunts, SaleDetail)** — four pages repeat the identical loading/error/useCallback/useEffect fetch skeleton. **Fix:** a `useAsyncData(fetcher)` hook returning `{ data, loading, error, reload }`. (H)

### API surface & DX
- **[DX] `README.md` Quick Start vs `api/.env.example`** — the example ships `AUTH_MODE=jwt` with `OIDC_ISSUER` unset; following the Quick Start verbatim, every `/api/*` call 401s with a bare `{"error":"Unauthorized"}` and nothing points at `AUTH_MODE=stub`. A fresh clone can't get running. **Fix:** Quick Start step "set `AUTH_MODE=stub` for local dev"; optionally a non-prod 401 hint. (H)
- **[docs drift] `api/.env.example:12`** — comments `OLLAMA_HOST` "default: http://localhost:11434" but the code default is `11436` (README agrees with the code). The doc a dev reads while debugging contradicts both. **Fix:** correct to `11436`. Also: house rule is broker-only, never raw `:11434` — the example comment is doubly wrong. (H)
- **[types] `ui/src/types.ts:135-145`** — `ScanEvent`'s catch-all member `{ type: string; ... }` overlaps every union member and defeats discriminated narrowing, forcing `as` casts in every `useScanStream` branch — functionally `any` at the boundary. **Fix:** drop the catch-all (or a separate explicitly-handled `UnknownScanEvent`). (H)
- **[types] api/ui hand-duplicated payload types** — `DiscoverFinding`/`RankedSale`/`Standout`/`FindingWithSale` copied verbatim between `api/src/services/*` and `ui/src/types.ts`, with drift already present (`listPlanItems` returns `sortOrder`; the UI's claimed `getPlan()` type omits it). **Fix:** import from the api package or a small shared types module. (M)
- **[validation] `api/src/routes/chat.ts:12-15`** — `message` unvalidated (type/presence/length) and `history` entries spread unchecked into the model payload; failures surface as opaque mid-stream SSE errors instead of the 400 shape every other route uses. **Fix:** validate up front, match the existing `400 {error}` convention. (H)
- **[security] `api/src/index.ts:20`** — `cors()` with no origin allowlist → `Access-Control-Allow-Origin: *` on every route. No cookie leak (Bearer auth), but any website's JS can call the LAN API. **Fix:** `cors({ origin: [<ui origin>] })`. (M)
- **[UI race] `ui/src/hooks/useScanStream.ts:40-120` + `ui/src/lib/api.ts:175`** — `streamScan` calls `onDone()` even when the read loop exits via abort; on reconnect the old stream's `onDone` fires after the new connection sets `connected:true`, clobbering it — banner shows "disconnected" while events stream. **Fix:** guard every callback with `if (ac.signal.aborted) return`. (H)

### Performance (scan throughput)
- **[perf] `api/src/vision/index.ts:236-282,416,424-427` + `api/src/lib/thumbnails.ts:34-37`** — each image is JPEG-decoded by sharp four independent times (dHash, quality gate, thumbnail, vision resize). 4× redundant CPU across thousands of images/week. **Fix:** decode once, `.clone()` per derived output. (M; VLM latency still dominates wall-clock — this buys throughput headroom)
- **[perf] `api/src/lib/thumbnails.ts:38`** — `mkdir recursive` runs per image write against a NAS mount; after the first image of a sale it's a pure redundant network round trip. **Fix:** cache created dirs in a per-run `Set`. (M)

### Test coverage (beyond the two MUSTs)
- **[tests] `api/src/services/sales.ts` + `discover.ts`** — ranking/hunt-gating business logic has no unit tests (only incidental e2e string assertions). The hunt gate silently drops whole sales; `scoreFinding`'s double-count edge is unexercised. **Fix:** temp-SQLite tests in the `persist.test.ts` pattern. (M)
- **[tests] `api/src/lib/hunts.ts`** — pure, trivially-testable functions that gate all sale visibility via substring `includes()` — no test file. Case-insensitivity, multi-keyword OR, zero-hunts short-circuit, substring false positives all unexercised. (M)
- **[tests] `api/src/routes/*`** — zero route-level tests; Hono's `app.request()` makes 404/400/shape tests nearly free. (M)

## NIT (style / preference)

- `api/src/services/sales.ts:175` — `listAllItems` returns Finding rows, not Items; comment says "flagged item"/"all images grid". Three locked vocab terms tangled in one name. Rename `listAllFindings`. (H)
- `ui/src/lib/cache.ts:4` — a rejected promise stays cached for the session; navigate-away-and-back re-throws until ErrorBoundary retry nukes all keys. Fix: `.catch(e => { store.delete(key); throw e; })`. (H)
- `api/src/scan/index.ts:35-39` — `--radius`/`--max-sales` with bad values yield `NaN`; `NaN ?? default` doesn't fall back → radius filter silently disabled / `slice(0, NaN)` scans nothing. Validate with `Number.isFinite`. (H)
- `api/src/vision/index.ts:808-811` — `topImageUrls` sends the first 6 findings in *listing order* to the oracle, not the top-scored 6; the sale may be judged on its weakest findings. Sort by `scoreResponse` desc first. (H)
- `api/src/lib/items.ts:148` — the `'50s` era fallback regex's leading `\b` can never match after a space; dead pattern. (H)
- `api/src/lib/items.ts:136-141` — bare `includes()`: keyword "ring" matches "box spring" → `jewelry_watches` outranks `beds`. Pad or word-bound short keywords. (M)
- `api/src/lib/date.ts:1` — `todayIsoDate()` is UTC; US evenings drop a sale from Discover during the evening of its final local day. (M)
- `package.json` — no `engines` field; local Node 24 vs CI's Node 22 breaks the native better-sqlite3 build and the persist integration suite fails locally (84 pass otherwise). Add `"engines": {"node": "22.x"}`. (M)
- `docs/adr/0003` says "no manual trigger" but `POST /api/scan/start` exists — add a superseding note so ADRs stay trustworthy. (H)
- `api/src/lib/scan-runner.ts` — `lib/` imports from `scan/` (package cycle) and spawns `../scan/index.js` with no `error` handler (`ENOENT` would crash the API; path only exists in `dist/`). Move into `scan/`, attach `child.on("error")`. (M)
- `api/src/index.ts` — no `app.onError`; uncaught throws return Hono's plain-text 500, breaking the `{error}` JSON contract. (M)
- `SCAN_OWNER_SUB` read at module load in two places (`index.ts:28`, `routes/sales.ts:137`) — single call-time accessor. (M)
- `DATABASE_URL` env holds a path, not a URL; importing `db/index.ts` side-effects `mkdirSync` + DB open. Rename `DATABASE_PATH`; note the eager open. (M)
- `api/src/services/sales.ts:415` — `getSaleImages` joins on `(saleId, imageUrl)` instead of the ADR 0014 `imageId` FK; the dedup-collapse Map exists only to compensate. Switch after backfill completes. (M)
- `api/src/lib/items.ts` — `desirability` and `idConfidence` share one `ItemConfidence` type though the file's own comment insists they differ; split the aliases. (M)
- Four unjustified `as {...}` casts on external fetch responses in `vision/index.ts` (308, 341, 378-380, 479) — add one-line justification comments per Google TS style. (M)
- UI copy hardcodes vendor/model names — "Gemini found something" (`SaleDetailPage.tsx:55`), `qwen3:30b` badge (`ChatPanel.tsx:111`) — while the backend is configurable. Say "the vision model" or surface the configured name. (M)
- `ChatPanel.tsx:49-79` — three unnamed inline stream callbacks each mapping messages by id; name them. (M)
- Comments in `vision/index.ts:90,192,413` say "photo" where CONTEXT.md locks "Image". (H)
- `tag: "collectible"` vs `tally.collectibles` — one concept, two spellings, duplicated into `ui/src/types.ts`. (M)
- Dead tautology `f.tag === category || (category === "collectible" && f.tag === "collectible")` copy-pasted in `DiscoverPage.tsx:59-61` and `RankedSaleCard.tsx:35`. Drop the second clause. (M)
- Inconsistent id-param rigor: `thumbsRoutes` checks `Number.isInteger(id) && id > 0`, hunts routes accept `NaN` (degrades to 404 safely). Shared `parseIdParam` helper. (M)
- `vision/index.ts` — local `has` shadowing exported `hasFindings` as an event field; and `response` vs `visionResponse` naming the same value in one file. (L)

## Standards this was measured against

- **Google eng-practices — "What to look for in a code review"** (https://google.github.io/eng-practices/review/reviewer/looking-for.html) — design, functionality/edge cases, complexity, tests-validate-behavior, naming, comments-explain-why, style, consistency; severity/tone model (MUST/SHOULD/NIT, code health over perfection).
- **Google TypeScript Style Guide** (https://google.github.io/styleguide/tsguide.html) — no `any`, named exports, justified assertions, only throw Error, catch as unknown, `field?:` over `|undefined`.
- **Hono JWT advisories, 2025** — CVE-2025-62610 / GHSA-m732-5p4w-x69g (aud not validated by default; pin alg explicitly, never derive from token header) — https://github.com/honojs/hono/security/advisories/GHSA-m732-5p4w-x69g, https://vulert.com/vuln-db/CVE-2025-62610.
- **SQLite/Drizzle 2026 practice** — loose type affinity → validate at the app layer; drizzle-kit strict mode; avoid select-whole-table-filter-in-JS — https://dev.tldrlss.com/en/article/2026/05/sqlite-pitfall-intro/, https://orm.drizzle.team/docs/quick-sqlite/better-sqlite3, https://makerkit.dev/blog/tutorials/drizzle-vs-prisma.
- **better-sqlite3** — synchronous driver: long request-path work blocks the event loop; transactions are the batch fast path — https://dev.to/lovestaco/understanding-better-sqlite3-the-fastest-sqlite-library-for-nodejs-4n8.
- **React 19 practice, 2025** — effect-based fetching needs abort/ignore-flags (race conditions); no useEffect for derived state — https://itnext.io/6-common-react-anti-patterns-that-are-hurting-your-code-quality-904b9c32e933, https://dev.to/gavincettolo/stop-using-useeffect-like-this-5-patterns-that-are-silently-breaking-your-react-app-5e5f.

## Rejected / out of scope

- `lucide-react` caret range pinning — icon lib, low supply-chain value for a private app.
- `main().catch(...)` CLI trailer duplicated ×4 — extraction is a wash at 3 lines each (the DRY agent itself said so).
- `DEV_USER_SUB` logged at startup — harmless in stub context.
- `getProcessedImageUrls` whole-table read — matches a named anti-pattern but is sub-second, once weekly, off the request path; revisit at 10× corpus.
- Scan-trigger rate limiting as its own finding — merged into MUST #5's lock-file fix.
- Micro-perf in request handlers — SQLite + 1–3 LAN users; nothing there hurts.
- Playwright e2e depth — the existing smoke coverage is proportionate to a single-household UI.
