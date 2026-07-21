/**
 * Session-management helpers layered on top of the low-level stealth-sidecar
 * HTTP client (./client.ts). Estate-scraper runs exactly one caller-batch per
 * process invocation (one Scan run or one import run), so this holds a
 * single module-level shared context slot rather than a profile-keyed map —
 * there is no per-account/per-profile concept to key on, and a fresh
 * context-per-call would throw away the whole point of a persistent context
 * (cookies/fingerprint continuity across a batch's requests).
 *
 * (Task 3b adds the page-lifecycle/stale-retry logic on top of this same
 * file — this file intentionally only covers context acquisition + teardown.)
 */
import { closeContext, closePage, createContext, createPage, getContent, navigate } from "./client.js";
import { SidecarResponseError } from "./errors.js";

/**
 * Cache of the in-flight-or-resolved shared contextId promise (NOT the
 * resolved string). Caching the promise itself — and doing so synchronously,
 * before awaiting `createContext()` — is what closes the check-then-act
 * race: two concurrent callers before the first `createContext()` resolves
 * both see the cache hit and await the same promise, rather than both firing
 * their own `createContext()` call.
 */
let cachedContextPromise: Promise<string> | undefined;

/**
 * Returns the shared sidecar contextId, creating it on first use and reusing
 * it on every subsequent call for the life of this process (or until
 * `closeSidecarSession()` tears it down).
 *
 * Concurrency-safe: see the `cachedContextPromise` doc comment above for why
 * the slot holds a promise, not a resolved id.
 */
export async function getOrCreateSharedContext(): Promise<string> {
  if (cachedContextPromise) return cachedContextPromise;

  const contextIdPromise = createContext().then((ctx) => ctx.contextId);
  cachedContextPromise = contextIdPromise;
  // If context creation fails (e.g. the sidecar is mid-restart), don't leave
  // the rejected promise cached forever — evict it so the next call gets a
  // fresh createContext() attempt against a possibly-now-healthy sidecar,
  // instead of replaying the same rejection for the rest of the process's
  // life. Guarded by an identity check in case a newer promise has already
  // replaced this one by the time this rejection handler runs.
  contextIdPromise.catch(() => {
    if (cachedContextPromise === contextIdPromise) {
      cachedContextPromise = undefined;
    }
  });
  return contextIdPromise;
}

/**
 * Explicit teardown for the shared context, if one was ever created. Safe
 * no-op when nothing is cached. This function must NEVER throw: it is called
 * from a `finally` block elsewhere, and a `finally`-block exception in JS
 * replaces whatever exception was already propagating — so if the real
 * error was e.g. `SidecarUnreachableError` (sidecar genuinely down), a close
 * failure here must never clobber that clear signal with a confusing
 * "failed to close" message instead. Any failure — including a failure to
 * even resolve the cached promise (e.g. context creation itself had failed
 * and was, for whatever reason, never evicted) — is caught and logged here.
 */
export async function closeSidecarSession(): Promise<void> {
  const promise = cachedContextPromise;
  if (!promise) return;

  try {
    const contextId = await promise;
    await closeContext(contextId);
  } catch (err) {
    console.error("closeSidecarSession: failed to close shared sidecar context", err);
  } finally {
    cachedContextPromise = undefined;
  }
}

/**
 * Combined budget for a single navigate()+getContent() attempt (see
 * `navigateAndGetContent` below). Raised from the original 20s: real-world
 * measurement against estatesales.net through the VPN-isolated sidecar
 * showed navigate() alone taking ~15s (even after fixing the sidecar's
 * navigate to use wait_until="domcontentloaded" instead of the slower
 * default "load" — see scraper-commons commit db74a7b), leaving no room
 * for the getContent() round trip on top. 45s gives real headroom above
 * the observed cost of a single page fetch.
 */
const COMBINED_OPERATION_TIMEOUT_MS = 45_000;

/**
 * Distinct sentinel returned by `navigateAndGetContent` when the combined
 * timeout wins the race — never thrown, so it can't be confused with a real
 * error at the call site.
 */
const OPERATION_TIMEOUT = Symbol("operation-timeout");

/**
 * Runs `navigate()` then `getContent()` against `pageId`, racing the whole
 * chain against a fixed-budget timer rather than passing a deadline down
 * into each call individually.
 *
 * This is a race, not a passed-down deadline: `work` and the timer both
 * start immediately, and whichever settles first wins via `Promise.race`.
 *
 * - A genuine fast connect-level failure (ECONNREFUSED etc.) makes `work`
 *   reject almost immediately, long before the timer fires — the race
 *   settles with that rejection right away, and it propagates as a throw
 *   (fail-fast, correct: the sidecar itself is unreachable).
 * - A slow/hung target page means `work` is still pending when the
 *   `COMBINED_OPERATION_TIMEOUT_MS` timer fires — the race resolves to
 *   `OPERATION_TIMEOUT` first, and whatever `work` eventually does (resolve
 *   or reject) is discarded. `work.catch(() => {})` exists purely so that
 *   later, discarded rejection doesn't surface as an unhandled-rejection
 *   warning.
 */
async function navigateAndGetContent(
  pageId: string,
  url: string,
): Promise<{ status: number; html: string } | typeof OPERATION_TIMEOUT> {
  const work = (async () => {
    const nav = await navigate(pageId, url);
    const html = await getContent(pageId);
    return { status: nav.status, html };
  })();
  // Prevent an unhandled-rejection warning if the timeout sentinel wins the
  // race and `work` later rejects on its own (its outcome is discarded either way).
  work.catch(() => {});
  const timeout = new Promise<typeof OPERATION_TIMEOUT>((resolve) => {
    setTimeout(() => resolve(OPERATION_TIMEOUT), COMBINED_OPERATION_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]);
}

/**
 * Fetches a URL's rendered HTML via the shared sidecar context, under a
 * single combined navigate+getContent timeout budget.
 *
 * Returns `null` (rather than throwing) for the two "sidecar itself is fine,
 * but this particular fetch didn't pan out" cases:
 *   - the combined operation timed out (target page slow/hung), or
 *   - the target site responded with a non-2xx status.
 *
 * A stale shared context/page (`SidecarResponseError` with
 * `errorType === "not_found"` — the shared context was reaped or the
 * sidecar restarted) is detected and retried exactly once: the stale cached
 * context is evicted, a fresh one is created, and the whole
 * create-page-then-fetch sequence is retried from scratch. Any other error
 * (a `SidecarUnreachableError`, or a `SidecarResponseError` with a different
 * `errorType` such as `capacity_exceeded`/`internal_error`) is not caught
 * here and propagates uncaught — the fail-fast path.
 */
export async function fetchPageHtml(url: string): Promise<string | null> {
  const contextId = await getOrCreateSharedContext();

  const attempt = async (ctxId: string): Promise<string | null> => {
    const { pageId } = await createPage(ctxId);
    try {
      const result = await navigateAndGetContent(pageId, url);
      if (result === OPERATION_TIMEOUT) {
        console.error(`fetchPageHtml: operation timeout fetching ${url}`);
        return null;
      }
      if (result.status < 200 || result.status >= 300) {
        console.error(`fetchPageHtml: non-2xx status ${result.status} fetching ${url}`);
        return null;
      }
      return result.html;
    } finally {
      try {
        await closePage(pageId);
      } catch (err) {
        console.error(`fetchPageHtml: failed to close page for ${url}`, err);
      }
    }
  };

  try {
    return await attempt(contextId);
  } catch (err) {
    if (err instanceof SidecarResponseError && err.errorType === "not_found") {
      // Stale shared context/page — evict the cached context and retry once
      // against a freshly created one.
      cachedContextPromise = undefined;
      const freshContextId = await getOrCreateSharedContext();
      return attempt(freshContextId);
    }
    throw err;
  }
}
