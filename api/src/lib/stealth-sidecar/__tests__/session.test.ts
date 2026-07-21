import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", () => ({
  createContext: vi.fn(),
  createPage: vi.fn(),
  navigate: vi.fn(),
  getContent: vi.fn(),
  closePage: vi.fn(),
  closeContext: vi.fn(),
}));

import { closeContext, closePage, createContext, createPage, getContent, navigate } from "../client.js";
import { SidecarResponseError, SidecarUnreachableError } from "../errors.js";
import { closeSidecarSession, fetchPageHtml, getOrCreateSharedContext } from "../session.js";

describe("stealth-sidecar session", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Drain any shared context a previous test left in session.ts's
    // module-level cache BEFORE resetting the mocks — otherwise this drain's
    // own closeContext call would count against the next test's fresh
    // mock-call-count assertions.
    vi.mocked(closeContext).mockResolvedValue(undefined);
    await closeSidecarSession();

    vi.mocked(createContext).mockReset();
    vi.mocked(createPage).mockReset();
    vi.mocked(navigate).mockReset();
    vi.mocked(getContent).mockReset();
    vi.mocked(closePage).mockReset().mockResolvedValue(undefined);
    vi.mocked(closeContext).mockReset().mockResolvedValue(undefined);

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleErrorSpy.mockRestore();
  });

  describe("getOrCreateSharedContext", () => {
    it("creates the shared context on first call", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });

      const contextId = await getOrCreateSharedContext();

      expect(contextId).toBe("ctx-1");
      expect(createContext).toHaveBeenCalledTimes(1);
    });

    it("reuses the cached context on a second call", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });

      const first = await getOrCreateSharedContext();
      const second = await getOrCreateSharedContext();

      expect(first).toBe("ctx-1");
      expect(second).toBe("ctx-1");
      expect(createContext).toHaveBeenCalledTimes(1);
    });

    it("dedupes two concurrent calls into a single createContext call", async () => {
      let resolveCreate!: (value: { contextId: string }) => void;
      vi.mocked(createContext).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      );

      const call1 = getOrCreateSharedContext();
      const call2 = getOrCreateSharedContext();

      // Both calls fired before createContext's single in-flight promise
      // resolved — this is exactly the check-then-act race the cached
      // promise (not just the resolved id) is designed to close.
      resolveCreate({ contextId: "ctx-race" });

      const [result1, result2] = await Promise.all([call1, call2]);

      expect(result1).toBe("ctx-race");
      expect(result2).toBe("ctx-race");
      expect(createContext).toHaveBeenCalledTimes(1);
    });

    it("evicts a failed createContext attempt so the next call retries fresh instead of replaying the same rejection forever", async () => {
      vi.mocked(createContext)
        .mockRejectedValueOnce(new Error("sidecar mid-restart"))
        .mockResolvedValueOnce({ contextId: "ctx-recovered" });

      await expect(getOrCreateSharedContext()).rejects.toThrow("sidecar mid-restart");

      // Without eviction, this second call would replay the same cached
      // rejection forever instead of trying createContext again.
      const recovered = await getOrCreateSharedContext();

      expect(recovered).toBe("ctx-recovered");
      expect(createContext).toHaveBeenCalledTimes(2);
    });

    it("does not let a stale rejection re-clear the cache once a newer context has been recovered into it (identity-guard regression)", async () => {
      // This targets the identity check inside the rejected-promise eviction
      // handler: `if (cachedContextPromise === contextIdPromise) { ... }`.
      // A mutant that forces this to always-true is only observably
      // different from the guarded original if, by the time the *first*
      // promise's rejection handler runs, the cache has already moved on to
      // a *different* promise. We can't force genuine concurrent-promise
      // overlap through the public API (the synchronous cache check-then-set
      // in getOrCreateSharedContext and the fact that closeSidecarSession
      // must await the very promise it would clear both close that window),
      // so this test instead pins down the strongest black-box invariant:
      // after the first rejection evicts and a second call recovers into a
      // brand-new cached promise, that recovered promise must still be
      // exactly what's live in the cache — a THIRD call must be a pure cache
      // hit (no extra createContext call), and closeSidecarSession must
      // close precisely the recovered id, not something stale or emptied out
      // from under it.
      vi.mocked(createContext)
        .mockRejectedValueOnce(new Error("sidecar mid-restart"))
        .mockResolvedValueOnce({ contextId: "ctx-recovered" });

      await expect(getOrCreateSharedContext()).rejects.toThrow("sidecar mid-restart");
      const recovered = await getOrCreateSharedContext();
      expect(recovered).toBe("ctx-recovered");

      // A further call must be a cache hit against the recovered promise —
      // no spurious extra eviction/recreation happened as a side effect of
      // the first (already-settled) promise's rejection handling.
      const stillCached = await getOrCreateSharedContext();
      expect(stillCached).toBe("ctx-recovered");
      expect(createContext).toHaveBeenCalledTimes(2);

      await closeSidecarSession();
      expect(closeContext).toHaveBeenCalledWith("ctx-recovered");
      expect(closeContext).toHaveBeenCalledTimes(1);
    });
  });

  describe("closeSidecarSession", () => {
    it("is a safe no-op when no context was ever created", async () => {
      await expect(closeSidecarSession()).resolves.toBeUndefined();

      expect(closeContext).not.toHaveBeenCalled();
    });

    it("closes the cached context and clears the cache", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      await getOrCreateSharedContext();

      await closeSidecarSession();

      expect(closeContext).toHaveBeenCalledWith("ctx-1");
      expect(closeContext).toHaveBeenCalledTimes(1);

      // Cache was cleared — the next call creates a fresh context.
      vi.mocked(createContext).mockResolvedValueOnce({ contextId: "ctx-2" });
      const reopened = await getOrCreateSharedContext();
      expect(reopened).toBe("ctx-2");
      expect(createContext).toHaveBeenCalledTimes(2);
    });

    it("never throws, even when its own close attempt hits a connect failure", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      await getOrCreateSharedContext();

      vi.mocked(closeContext).mockRejectedValue(new SidecarUnreachableError("sidecar unreachable"));

      await expect(closeSidecarSession()).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalled();

      // The cache is still cleared even though the close attempt failed —
      // the next call retries fresh rather than replaying anything stale.
      vi.mocked(createContext).mockResolvedValueOnce({ contextId: "ctx-2" });
      const reopened = await getOrCreateSharedContext();
      expect(reopened).toBe("ctx-2");
    });

    it("logs the exact 'failed to close' message (not just some call) when the close attempt fails", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      await getOrCreateSharedContext();

      const closeErr = new SidecarUnreachableError("sidecar unreachable");
      vi.mocked(closeContext).mockRejectedValue(closeErr);

      await closeSidecarSession();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "closeSidecarSession: failed to close shared sidecar context",
        closeErr,
      );
    });
  });

  describe("fetchPageHtml", () => {
    it("creates a page, navigates, reads content, closes the page, and returns the html", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      vi.mocked(navigate).mockResolvedValue({ status: 200, url: "https://example.com/final" });
      vi.mocked(getContent).mockResolvedValue("<html>ok</html>");

      const html = await fetchPageHtml("https://example.com/item");

      expect(html).toBe("<html>ok</html>");
      expect(createPage).toHaveBeenCalledWith("ctx-1");
      expect(navigate).toHaveBeenCalledWith("page-1", "https://example.com/item");
      expect(getContent).toHaveBeenCalledWith("page-1");
      expect(closePage).toHaveBeenCalledWith("page-1");
    });

    it("returns null when the target site responds with a non-2xx status", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      vi.mocked(navigate).mockResolvedValue({ status: 404, url: "https://example.com/gone" });
      vi.mocked(getContent).mockResolvedValue("<html>not found</html>");

      const html = await fetchPageHtml("https://example.com/gone");

      expect(html).toBeNull();
      expect(closePage).toHaveBeenCalledWith("page-1");
    });

    it("returns null for status 199 (below the 2xx range, proves the `< 200` boundary matters)", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      vi.mocked(navigate).mockResolvedValue({ status: 199, url: "https://example.com/informational" });
      vi.mocked(getContent).mockResolvedValue("<html>informational</html>");

      const html = await fetchPageHtml("https://example.com/informational");

      expect(html).toBeNull();
    });

    it("returns null for status 300 exactly (proves `>= 300`, not `> 300`, is the correct upper bound)", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      vi.mocked(navigate).mockResolvedValue({ status: 300, url: "https://example.com/multiple-choices" });
      vi.mocked(getContent).mockResolvedValue("<html>multiple choices</html>");

      const html = await fetchPageHtml("https://example.com/multiple-choices");

      expect(html).toBeNull();
    });

    it("returns the html for status 299 (proves the upper boundary is exclusive at 300, not 301)", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      vi.mocked(navigate).mockResolvedValue({ status: 299, url: "https://example.com/almost-redirect" });
      vi.mocked(getContent).mockResolvedValue("<html>still 2xx</html>");

      const html = await fetchPageHtml("https://example.com/almost-redirect");

      expect(html).toBe("<html>still 2xx</html>");
    });

    it("returns null when the combined operation timeout wins the race", async () => {
      vi.useFakeTimers();
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      // navigate() never resolves — simulates a hung target page.
      vi.mocked(navigate).mockImplementation(() => new Promise(() => {}));
      vi.mocked(getContent).mockImplementation(() => new Promise(() => {}));

      const resultPromise = fetchPageHtml("https://example.com/slow");
      await vi.advanceTimersByTimeAsync(45_000);
      const result = await resultPromise;

      expect(result).toBeNull();
      expect(closePage).toHaveBeenCalledWith("page-1");
    });

    it("retries once on a stale-context 404 not_found and succeeds on the retry", async () => {
      vi.mocked(createContext)
        .mockResolvedValueOnce({ contextId: "ctx-stale" })
        .mockResolvedValueOnce({ contextId: "ctx-fresh" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      vi.mocked(navigate)
        .mockRejectedValueOnce(new SidecarResponseError(404, "not_found", "context not found"))
        .mockResolvedValueOnce({ status: 200, url: "https://example.com/final" });
      vi.mocked(getContent).mockResolvedValue("<html>ok</html>");

      const html = await fetchPageHtml("https://example.com/item");

      expect(html).toBe("<html>ok</html>");
      expect(createContext).toHaveBeenCalledTimes(2);
      expect(createPage).toHaveBeenCalledTimes(2);
      expect(navigate).toHaveBeenCalledTimes(2);
      expect(closePage).toHaveBeenCalledTimes(2);
    });

    it("propagates a second not_found on the retry as a real throw (only one retry)", async () => {
      vi.mocked(createContext)
        .mockResolvedValueOnce({ contextId: "ctx-stale" })
        .mockResolvedValueOnce({ contextId: "ctx-still-stale" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      vi.mocked(navigate).mockRejectedValue(
        new SidecarResponseError(404, "not_found", "context not found"),
      );

      await expect(fetchPageHtml("https://example.com/item")).rejects.toThrow(SidecarResponseError);

      expect(createContext).toHaveBeenCalledTimes(2);
      expect(navigate).toHaveBeenCalledTimes(2);
    });

    it("propagates a SidecarUnreachableError uncaught, without retrying", async () => {
      vi.mocked(createContext).mockRejectedValue(new SidecarUnreachableError("sidecar unreachable"));

      await expect(fetchPageHtml("https://example.com/item")).rejects.toThrow(SidecarUnreachableError);

      expect(createContext).toHaveBeenCalledTimes(1);
      expect(createPage).not.toHaveBeenCalled();
    });

    it("propagates a SidecarResponseError with a non-not_found errorType uncaught, without retrying", async () => {
      vi.mocked(createContext).mockResolvedValue({ contextId: "ctx-1" });
      vi.mocked(createPage).mockResolvedValue({ pageId: "page-1" });
      vi.mocked(navigate).mockRejectedValue(
        new SidecarResponseError(503, "capacity_exceeded", "no capacity"),
      );

      await expect(fetchPageHtml("https://example.com/item")).rejects.toThrow(SidecarResponseError);

      expect(createContext).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledTimes(1);
      // Page is still closed best-effort even on an uncaught error.
      expect(closePage).toHaveBeenCalledWith("page-1");
    });
  });
});
