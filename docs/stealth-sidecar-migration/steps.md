# Steps: Stealth Sidecar Migration for HTML Scraping

## Prerequisites
- `scraper-commons` sidecar service running locally on `http://127.0.0.1:8000` or reachable at the configured `STEALTH_SIDECAR_URL` (required for integration testing, but implementation and unit tests work without it).
- `api/package.json` already has `vitest` as devDependency.
- `api/src/lib/http.ts` exists with current `fetchText()` and `fetchBuffer()` implementations.
- `api/src/lib/scraping.ts` exists and exports `FETCH_HEADERS`.

## Implementation steps

### Step 1: Create stealth-sidecar error classes
**What**: Define typed error classes for sidecar communication failures (unreachable vs. sidecar-returned error).
**Files**: `api/src/lib/stealth-sidecar/errors.ts`
**Test**: `npm run test -- errors.test.ts` or `import { SidecarError, SidecarUnreachableError, SidecarResponseError } from './errors'` and verify types compile.
**Depends on**: none
**Parallelizable**: Yes

### Step 2: Create stealth-sidecar HTTP client wrapper & document environment
**What**: Implement thin HTTP wrapper around the `/v1` API routes (createContext, createPage, navigate, getContent, closePage, closeContext) with request timeouts and error envelope parsing. Add `STEALTH_SIDECAR_URL=http://127.0.0.1:8000` to `api/.env.example` documenting the default local-loopback sidecar address.
**Files**: `api/src/lib/stealth-sidecar/client.ts`, `api/.env.example`
**Test**: Code compiles and typechecks cleanly (`npm run typecheck`); full behavioral test coverage lands in the corresponding test-writing step (Step 8).
**Depends on**: Step 1
**Parallelizable**: No

### Step 3a: Create lazy shared-context cache with eviction & teardown
**What**: Implement `getOrCreateSharedContext()` with rejected-promise eviction (clear the cache on a failed `createContext`, with an identity-check guard so a newer promise isn't accidentally evicted), plus `closeSidecarSession()` teardown helper which must never throw — catch and log its own close failures.
**Files**: `api/src/lib/stealth-sidecar/session.ts` (initial structure)
**Test**: Code compiles and typechecks cleanly (`npm run typecheck`); full behavioral test coverage lands in the corresponding test-writing step (Step 9).
**Depends on**: Steps 1, 2
**Parallelizable**: No

### Step 3b: Create per-call ephemeral page lifecycle with stale-context detection
**What**: Implement `withEphemeralPage()`-style helper: create page, navigate, get content, close page in finally. Add stale-context/page-ID 404 detection and single retry logic so a stale context ID transparently refreshes on the next call.
**Files**: `api/src/lib/stealth-sidecar/session.ts` (complete with Step 3a)
**Test**: Code compiles and typechecks cleanly (`npm run typecheck`); full behavioral test coverage lands in the corresponding test-writing step (Step 9).
**Depends on**: Steps 1, 2, 3a
**Parallelizable**: No

### Step 4: Rewrite fetchText to use stealth-sidecar client & document headers change
**What**: Replace `fetchText(url: string): Promise<string | null>` implementation in `api/src/lib/http.ts` to call `session.withEphemeralPage()`, remove `FETCH_HEADERS` import from `fetchText`'s path (keep it for `fetchBuffer`), and leave `fetchBuffer()` and `politeDelay()` byte-for-byte unchanged. Also insert one-line comment in `api/src/lib/scraping.ts` noting that `FETCH_HEADERS` no longer applies to `fetchText`'s HTML fetches because a real stealth browser sets its own fingerprint/headers, so future readers understand why `FETCH_HEADERS` is still there (for `fetchBuffer`) but not used by `fetchText`.
**Files**: `api/src/lib/http.ts`, `api/src/lib/scraping.ts`
**Test**: Code compiles and typechecks cleanly (`npm run typecheck`); full behavioral test coverage lands in the corresponding test-writing step (Step 10).
**Depends on**: Steps 1, 2, 3a, 3b
**Parallelizable**: No

### Step 5: Wrap scraper batch with closeSidecarSession()
**What**: Modify `api/src/scraper/index.ts` to wrap the ENTIRE `scrapeWithinRadius()` function body in a single `try { ... } finally { await closeSidecarSession(); }` to guarantee context teardown on both success and error paths (especially on `process.exit(1)` error cases). Do not wrap per-loop-iteration — one wrap around the whole batch.
**Files**: `api/src/scraper/index.ts`
**Test**: Run `npm run scan` against a local sidecar instance (or with mocked fetch), verify script completes successfully, check logs or sidecar-side instrumentation confirm context is closed.
**Depends on**: Steps 3a, 3b, 4
**Parallelizable**: Yes

### Step 6: Wrap import batch with closeSidecarSession()
**What**: Modify `api/src/import/index.ts` to wrap the ENTIRE `main()` function body in a single `try { ... } finally { await closeSidecarSession(); }`, preserving `ensureSaleRecord`'s `fetchText(entry.url)` call signature unchanged. Do not wrap per-loop-iteration — one wrap around the whole batch.
**Files**: `api/src/import/index.ts`
**Test**: Run `npm run import` against a local sidecar instance (or with mocked fetch), verify script completes successfully and context is closed.
**Depends on**: Steps 3a, 3b, 4
**Parallelizable**: Yes

### Step 7: Wire scan CLI entrypoint for clear sidecar error attribution
**What**: Review `api/src/scan/index.ts` (the real CLI entrypoint, `npm run scan` → `tsx src/scan/index.ts`) to confirm/adjust its existing top-level error handling so a thrown `SidecarUnreachableError`/`SidecarResponseError` from `scrapeWithinRadius()` still surfaces as clearly sidecar-attributable (e.g., its `.message` text is identifiable, not flattened into a generic scrape-failure message) by the time it reaches this entrypoint's own catch/exit-code logic.
**Files**: `api/src/scan/index.ts`
**Test**: Run `npm run scan` with no sidecar running (or a test invoking its handler directly) and confirm the surfaced error/log output is clearly attributable to "sidecar unreachable", not a generic failure.
**Depends on**: Steps 1, 5
**Parallelizable**: No

### Step 8: Write client.ts unit tests
**What**: Create `api/src/lib/stealth-sidecar/__tests__/client.test.ts` covering request body/header formation, response envelope parsing, error-type mapping (non-2xx from sidecar → `SidecarResponseError` with `status` + `errorType` fields), and connection-level failures (ECONNREFUSED/timeout → `SidecarUnreachableError`). Include test cases for: navigate `timeout_ms` client-side capping avoids the sidecar's 422 `invalid_timeout` response.
**Files**: `api/src/lib/stealth-sidecar/__tests__/client.test.ts`
**Test**: `npm run test -- client.test.ts` passes; vi.stubGlobal("fetch", ...) mocks used, no external sidecar needed.
**Depends on**: Step 2
**Parallelizable**: No

### Step 9: Write session.ts unit tests
**What**: Create `api/src/lib/stealth-sidecar/__tests__/session.test.ts` covering lazy context creation (called once, cached), per-call page lifecycle (created, content read, closed), stale-context 404 detection and single retry, and `closeSidecarSession()` best-effort cleanup. Include test cases for: (a) `closeSidecarSession()` is a safe no-op when no context was ever created (e.g., a zero-entry import run, or a scrape that fails before any successful `fetchText` call), (b) the rejected-promise cache eviction (a failed `createContext` doesn't permanently poison the shared-context cache — a subsequent call retries fresh), and (c) `closeSidecarSession()` never throws, even when its own close attempt hits a connect failure.
**Files**: `api/src/lib/stealth-sidecar/__tests__/session.test.ts`
**Test**: `npm run test -- session.test.ts` passes; mocked fetch, no external sidecar needed.
**Depends on**: Steps 2, 3a, 3b
**Parallelizable**: No

### Step 10: Write fetchText unit tests
**What**: Create or extend `api/src/lib/__tests__/http.test.ts` with test cases for `fetchText()`'s new behavior: 2xx navigate response returns HTML, non-2xx navigate response returns `null` (logs URL + status), sidecar unreachable raises `SidecarUnreachableError`, stale-context 404 transparently retries once. Include test cases for: (a) the corrected timeout-vs-unreachable distinction: a per-call operation timeout returns `null` (does NOT throw), while a connect-level failure to the sidecar throws `SidecarUnreachableError`.
**Files**: `api/src/lib/__tests__/http.test.ts`
**Test**: `npm run test -- http.test.ts` passes; mocked fetch covers all branches.
**Depends on**: Steps 1, 2, 3a, 3b, 4
**Parallelizable**: No

### Step 11: Write scraper integration tests
**What**: Create `api/src/scraper/__tests__/index.test.ts` (file does not exist today; only `parse.test.ts` exists) with two test suites: (1) `scrapeWithinRadius()` against mocked sidecar producing same `ScrapedSale[]` shape as pre-migration fixture tests, (2) `scrapeWithinRadius()` rejecting (not returning empty/partial array) when mocked sidecar is unreachable.
**Files**: `api/src/scraper/__tests__/index.test.ts`
**Test**: `npm run test -- scraper/index.test.ts` passes; both suites pass with mocked fetch, no external sidecar needed.
**Depends on**: Step 5
**Parallelizable**: No

### Step 12: Write import integration tests
**What**: Create `api/src/import/__tests__/index.test.ts` (file does not exist today) covering (a) `ensureSaleRecord`/`main()` producing correct results against a mocked sidecar, and (b) rejecting/aborting cleanly (not silently completing with partial data) when the mocked sidecar is unreachable.
**Files**: `api/src/import/__tests__/index.test.ts`
**Test**: `npm run test -- import/index.test.ts` passes; both suites pass with mocked fetch, no external sidecar needed.
**Depends on**: Step 6
**Parallelizable**: No

## Rollback plan
All steps are reversible via `git`. Because the implementation writes only new modules (`stealth-sidecar/`) and modifies existing files (`http.ts`, `scraper/index.ts`, `import/index.ts`, `scraping.ts`, `.env.example`) with minimal surgery, rolling back is a single `git reset --hard` or reverting the specific commits if already merged. No data migration or database schema changes are involved.
