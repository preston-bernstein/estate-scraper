import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBuffer, fetchText, politeDelay } from "../http.js";
import { FETCH_HEADERS } from "../scraping.js";
import { SidecarUnreachableError } from "../stealth-sidecar/errors.js";
import { closeSidecarSession } from "../stealth-sidecar/session.js";

/**
 * `fetchText` is now a one-line delegation to `fetchPageHtml` (see
 * `../stealth-sidecar/session.ts`), which itself calls the real
 * `../stealth-sidecar/client.ts` functions. Those tests already cover
 * `fetchPageHtml`'s internals against a mocked `client.js`, and client.test.ts
 * already covers each `client.ts` function against a mocked global `fetch`.
 * This file's job is different: confirm `fetchText`'s OWN observable
 * contract end-to-end through the real chain, so global `fetch` is mocked
 * here (not `session.js`/`client.js`) and responses are shaped like the
 * sidecar's real `/v1` routes.
 */

const BASE_URL = "http://127.0.0.1:8000";
const ORIGINAL_SIDECAR_URL = process.env.STEALTH_SIDECAR_URL;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => undefined,
  } as unknown as Response;
}

describe("fetchText", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.STEALTH_SIDECAR_URL = BASE_URL;

    // Permissive default so closeSidecarSession's drain below (a best-effort
    // closeContext call against whatever a PREVIOUS test left cached in
    // session.ts's module-level singleton) always succeeds, regardless of
    // that previous test's own routing.
    fetchMock = vi.fn(async () => emptyResponse(204));
    vi.stubGlobal("fetch", fetchMock);
    await closeSidecarSession();

    // Drop the drain call(s) from the mock's history and clear its
    // implementation so each test starts with a clean slate and installs
    // its own routing.
    fetchMock.mockReset();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    consoleErrorSpy.mockRestore();
    if (ORIGINAL_SIDECAR_URL === undefined) {
      delete process.env.STEALTH_SIDECAR_URL;
    } else {
      process.env.STEALTH_SIDECAR_URL = ORIGINAL_SIDECAR_URL;
    }
  });

  it("resolves to the HTML string on a 2xx navigate response", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";

      if (method === "POST" && url === `${BASE_URL}/v1/contexts`) {
        return jsonResponse(200, { context_id: "ctx-1" });
      }
      if (method === "POST" && url === `${BASE_URL}/v1/contexts/ctx-1/pages`) {
        return jsonResponse(200, { page_id: "page-1" });
      }
      if (method === "POST" && url === `${BASE_URL}/v1/pages/page-1/navigate`) {
        return jsonResponse(200, { status: 200, url: "https://example.com/final" });
      }
      if (method === "GET" && url === `${BASE_URL}/v1/pages/page-1/content`) {
        return jsonResponse(200, { content: "<html>ok</html>" });
      }
      if (method === "DELETE") {
        return emptyResponse(204);
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    const html = await fetchText("https://example.com/item");

    expect(html).toBe("<html>ok</html>");
    // A single fetchText call closes the page it opened, but does NOT tear
    // down the shared context — that's only done by closeSidecarSession().
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/v1/pages/page-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      `${BASE_URL}/v1/contexts/ctx-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("resolves to null (logging the url and status) when the target site responds with a non-2xx status", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";

      if (method === "POST" && url === `${BASE_URL}/v1/contexts`) {
        return jsonResponse(200, { context_id: "ctx-1" });
      }
      if (method === "POST" && url === `${BASE_URL}/v1/contexts/ctx-1/pages`) {
        return jsonResponse(200, { page_id: "page-1" });
      }
      if (method === "POST" && url === `${BASE_URL}/v1/pages/page-1/navigate`) {
        return jsonResponse(200, { status: 404, url: "https://example.com/gone" });
      }
      if (method === "GET" && url === `${BASE_URL}/v1/pages/page-1/content`) {
        return jsonResponse(200, { content: "<html>not found</html>" });
      }
      if (method === "DELETE") {
        return emptyResponse(204);
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    const html = await fetchText("https://example.com/gone");

    expect(html).toBeNull();
    const logged = consoleErrorSpy.mock.calls.some(
      (call) =>
        typeof call[0] === "string" && call[0].includes("404") && call[0].includes("https://example.com/gone"),
    );
    expect(logged).toBe(true);
  });

  it("throws SidecarUnreachableError (does not resolve to null) when the sidecar is unreachable at connect time", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method === "POST" && url === `${BASE_URL}/v1/contexts`) {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    await expect(fetchText("https://example.com/item")).rejects.toThrow(SidecarUnreachableError);
  });

  it("resolves to null (does NOT throw) when the combined navigate+content operation times out, distinct from an unreachable sidecar", async () => {
    vi.useFakeTimers();

    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";

      if (method === "POST" && url === `${BASE_URL}/v1/contexts`) {
        return jsonResponse(200, { context_id: "ctx-1" });
      }
      if (method === "POST" && url === `${BASE_URL}/v1/contexts/ctx-1/pages`) {
        return jsonResponse(200, { page_id: "page-1" });
      }
      if (method === "POST" && url === `${BASE_URL}/v1/pages/page-1/navigate`) {
        // Simulates a hung target page: the underlying fetch call never
        // settles, so the 20s combined operation timeout must win the race
        // rather than the caller waiting forever or throwing.
        return new Promise<Response>(() => {});
      }
      if (method === "DELETE") {
        return emptyResponse(204);
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    const resultPromise = fetchText("https://example.com/slow");
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/v1/pages/page-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("retries once on a stale-context 404 not_found, resolving to the HTML from the successful retry against a fresh context+page", async () => {
    let contextCalls = 0;
    let pageCalls = 0;
    let navigateCalls = 0;

    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";

      if (method === "POST" && url === `${BASE_URL}/v1/contexts`) {
        contextCalls += 1;
        return jsonResponse(200, { context_id: `ctx-${contextCalls}` });
      }
      if (method === "POST" && /^http:\/\/127\.0\.0\.1:8000\/v1\/contexts\/ctx-\d+\/pages$/.test(url)) {
        pageCalls += 1;
        return jsonResponse(200, { page_id: `page-${pageCalls}` });
      }
      if (method === "POST" && /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/page-\d+\/navigate$/.test(url)) {
        navigateCalls += 1;
        if (navigateCalls === 1) {
          // The shared context/page was reaped server-side — the sidecar
          // reports this as a 404 not_found envelope.
          return jsonResponse(404, { error: { type: "not_found", message: "context not found" } });
        }
        return jsonResponse(200, { status: 200, url: "https://example.com/final" });
      }
      if (method === "GET" && /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/page-\d+\/content$/.test(url)) {
        return jsonResponse(200, { content: "<html>ok</html>" });
      }
      if (method === "DELETE") {
        return emptyResponse(204);
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    const html = await fetchText("https://example.com/item");

    expect(html).toBe("<html>ok</html>");
    // The retry creates a fresh context AND a fresh page, then navigates
    // again from scratch — the first (stale) attempt's page is still closed
    // best-effort, and only one retry is ever attempted.
    expect(contextCalls).toBe(2);
    expect(pageCalls).toBe(2);
    expect(navigateCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/v1/pages/page-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/v1/pages/page-2`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("fetchBuffer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a Buffer for a 2xx response", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBuffer("https://example.com/image.jpg");

    expect(result).toBeInstanceOf(Buffer);
    expect(Array.from(result as Buffer)).toEqual([1, 2, 3]);
    // Pins the exact fetch call shape (url + headers/signal init) so an
    // ObjectLiteral mutant reducing the init object to `{}` fails here.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/image.jpg",
      expect.objectContaining({ headers: FETCH_HEADERS }),
    );
  });

  it("returns null for a non-2xx response", async () => {
    // arrayBuffer is deliberately wired to real (distinguishable) bytes: if
    // the `if (!response.ok) return null` guard were ever removed or forced
    // false, this response would fall through to `Buffer.from(...)` and
    // resolve to an actual Buffer instead of null, so the assertion below
    // would catch it instead of the mutant coincidentally still returning
    // null via an unrelated thrown-error/catch path.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
      } as unknown as Response),
    );

    const result = await fetchBuffer("https://example.com/image.jpg");

    expect(result).toBeNull();
  });

  it("returns null when fetch itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await fetchBuffer("https://example.com/image.jpg");

    expect(result).toBeNull();
  });
});

describe("politeDelay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves only after an elapsed delay somewhere between minMs and maxMs", async () => {
    vi.useFakeTimers();

    let resolved = false;
    politeDelay(100, 200).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(true);
  });

  it("resolves after exactly minMs when Math.random() returns 0", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    // delay = minMs + 0 * (maxMs - minMs) = minMs, for either the correct
    // formula or the `(maxMs - minMs)` -> `(maxMs + minMs)` mutant (both are
    // zeroed out by the 0 multiplier here) — this pins the random()=0
    // boundary; the random()=1 case below is what actually separates the
    // correct formula from both surviving ArithmeticOperator mutants.
    let resolved = false;
    politeDelay(100, 200).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);

    randomSpy.mockRestore();
  });

  it("resolves after exactly maxMs when Math.random() returns 1", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);

    // delay = minMs + 1 * (maxMs - minMs) = maxMs = 200 for the correct
    // formula. The `(maxMs - minMs)` -> `(maxMs + minMs)` mutant would give
    // 100 + (200 + 100) = 400, and the `*` -> `/` mutant would give
    // 100 + 1 / (200 - 100) = 100.01 — both diverge from 200, so advancing
    // to exactly 200ms (and not before) kills both.
    let resolved = false;
    politeDelay(100, 200).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(199);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);

    randomSpy.mockRestore();
  });
});
