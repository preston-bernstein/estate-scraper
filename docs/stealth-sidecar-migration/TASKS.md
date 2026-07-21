# Tasks: Stealth Sidecar Migration for HTML Scraping

Generated from: docs/stealth-sidecar-migration/ on 2026-07-21

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Create stealth-sidecar error classes
**Status**: [x] done
**Files**: api/src/lib/stealth-sidecar/errors.ts
**Test**: import { SidecarError, SidecarUnreachableError, SidecarResponseError } from './errors' and verify types compile.
**Depends on**: none
**Parallelizable**: Yes
**Notes**:

### Task 2: Create stealth-sidecar HTTP client wrapper & document environment
**Status**: [x] done
**Files**: api/src/lib/stealth-sidecar/client.ts, api/.env.example
**Test**: Code compiles and typechecks cleanly (npm run typecheck); full behavioral test coverage lands in Step 8.
**Depends on**: Task 1
**Parallelizable**: No
**Notes**:

### Task 3a: Create lazy shared-context cache with eviction & teardown
**Status**: [x] done
**Files**: api/src/lib/stealth-sidecar/session.ts (initial structure)
**Test**: Code compiles and typechecks cleanly (npm run typecheck); full behavioral test coverage lands in Step 9.
**Depends on**: Task 1, Task 2
**Parallelizable**: No
**Notes**:

### Task 3b: Create per-call ephemeral page lifecycle with stale-context detection
**Status**: [x] done
**Files**: api/src/lib/stealth-sidecar/session.ts (complete with Task 3a)
**Test**: Code compiles and typechecks cleanly (npm run typecheck); full behavioral test coverage lands in Step 9.
**Depends on**: Task 1, Task 2, Task 3a
**Parallelizable**: No
**Notes**:

### Task 4: Rewrite fetchText to use stealth-sidecar client & document headers change
**Status**: [x] done
**Files**: api/src/lib/http.ts, api/src/lib/scraping.ts
**Test**: Code compiles and typechecks cleanly (npm run typecheck); full behavioral test coverage lands in Step 10.
**Depends on**: Task 1, Task 2, Task 3a, Task 3b
**Parallelizable**: No
**Notes**:

### Task 5: Wrap scraper batch with closeSidecarSession()
**Status**: [x] done
**Files**: api/src/scraper/index.ts
**Test**: Run npm run scan against a local sidecar instance (or with mocked fetch), verify script completes successfully, check logs confirm context is closed.
**Depends on**: Task 3a, Task 3b, Task 4
**Parallelizable**: Yes
**Notes**:

### Task 6: Wrap import batch with closeSidecarSession()
**Status**: [x] done
**Files**: api/src/import/index.ts
**Test**: Run npm run import against a local sidecar instance (or with mocked fetch), verify script completes successfully and context is closed.
**Depends on**: Task 3a, Task 3b, Task 4
**Parallelizable**: Yes
**Notes**:

### Task 7: Wire scan CLI entrypoint for clear sidecar error attribution
**Status**: [x] done
**Files**: api/src/scan/index.ts
**Test**: Run npm run scan with no sidecar running (or a test invoking its handler directly) and confirm the surfaced error/log output is clearly attributable to "sidecar unreachable", not a generic failure.
**Depends on**: Task 1, Task 5
**Parallelizable**: No
**Notes**:

### Task 8: Write client.ts unit tests
**Status**: [x] done
**Files**: api/src/lib/stealth-sidecar/__tests__/client.test.ts
**Test**: npm run test -- client.test.ts passes; vi.stubGlobal("fetch", ...) mocks used, no external sidecar needed.
**Depends on**: Task 2
**Parallelizable**: No
**Notes**:

### Task 9: Write session.ts unit tests
**Status**: [x] done
**Files**: api/src/lib/stealth-sidecar/__tests__/session.test.ts
**Test**: npm run test -- session.test.ts passes; mocked fetch, no external sidecar needed.
**Depends on**: Task 2, Task 3a, Task 3b
**Parallelizable**: No
**Notes**:

### Task 10: Write fetchText unit tests
**Status**: [x] done
**Files**: api/src/lib/__tests__/http.test.ts
**Test**: npm run test -- http.test.ts passes; mocked fetch covers all branches.
**Depends on**: Task 1, Task 2, Task 3a, Task 3b, Task 4
**Parallelizable**: No
**Notes**:

### Task 11: Write scraper integration tests
**Status**: [x] done
**Files**: api/src/scraper/__tests__/index.test.ts
**Test**: npm run test -- scraper/index.test.ts passes; both suites pass with mocked fetch, no external sidecar needed.
**Depends on**: Task 5
**Parallelizable**: No
**Notes**:

### Task 12: Write import integration tests
**Status**: [x] done
**Files**: api/src/import/__tests__/index.test.ts
**Test**: npm run test -- import/index.test.ts passes; both suites pass with mocked fetch, no external sidecar needed.
**Depends on**: Task 6
**Parallelizable**: No
**Notes**:

## Blocked / open
None. All 12 tasks complete. Integration Validator + `tsc --noEmit` + full vitest suite (19 files, 256 tests) all clean. One fix applied post-implementation: `import/__tests__/index.test.ts` had a vitest `MockInstance` generic-typing mismatch caught by `tsc` (not by vitest's own looser runtime transpilation) — fixed by typing the spy variables as unparameterized `MockInstance` instead of `ReturnType<typeof vi.spyOn>`.
