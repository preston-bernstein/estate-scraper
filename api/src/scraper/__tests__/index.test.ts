import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { distanceFromHome } from "../../lib/geo.js";
import { METRO_LISTING_URL } from "../../lib/scraping.js";
import { SidecarUnreachableError } from "../../lib/stealth-sidecar/errors.js";
import { closeSidecarSession } from "../../lib/stealth-sidecar/session.js";
import { scrapeWithinRadius } from "../index.js";

/**
 * `scrapeWithinRadius` (the Scan loop) is now layered on top of the
 * stealth-sidecar migration: `fetchText` delegates to `fetchPageHtml`, which
 * itself talks to the sidecar's `/v1` HTTP routes. `client.test.ts` and
 * `http.test.ts` already cover that chain's own internals (retries, timeouts,
 * connect failures) in isolation — this file's job is the layer ABOVE that:
 * confirm the Scan loop's own behavior (parsing, geocoding, radius filtering,
 * one-bad-listing-doesn't-sink-the-scan, and sidecar-failure propagation)
 * still holds through the real chain. So, like `http.test.ts`, global
 * `fetch` is mocked here to the sidecar's `/v1` response shapes rather than
 * mocking `session.js`/`client.js` directly.
 *
 * `../../lib/geo.js`'s `geocodeAddress` is mocked so this suite never makes a
 * real geocoding call and gets fully deterministic coordinates.
 * `../../lib/http.js`'s `politeDelay` is mocked to resolve instantly — it's
 * pure inter-request rate-limiting, orthogonal to everything under test here,
 * and leaving it real would add several real seconds of wall-clock sleep per
 * test (multiple listings x two `politeDelay()` calls each).
 */

const { geocodeAddressMock } = vi.hoisted(() => ({ geocodeAddressMock: vi.fn() }));
const { politeDelayMock } = vi.hoisted(() => ({
  politeDelayMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/geo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/geo.js")>();
  return { ...actual, geocodeAddress: geocodeAddressMock };
});

vi.mock("../../lib/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/http.js")>();
  return { ...actual, politeDelay: politeDelayMock };
});

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

// Same minimal schema.org-JSON-in-HTML convention as parse.test.ts's `page()` helper.
function detailPage(opts: { title?: string } & Partial<Record<string, string>> = {}): string {
  const { title = "Test Sale", ...fields } = opts;
  const f = {
    startDate: "2026-08-01T14:00:00.000Z",
    endDate: "2026-08-03T20:00:00.000Z",
    addressLine1: "123 Main St",
    addressLocality: "Decatur",
    addressRegion: "GA",
    postalCode: "30033",
    ...fields,
  };
  const json = Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `"${k}":"${v}"`)
    .join(",");
  return `<html><meta property="og:title" content="${title}"/>{${json}}</html>`;
}

function listingPage(hrefs: string[]): string {
  return `<html>${hrefs.map((href) => `<a href="${href}">x</a>`).join("")}</html>`;
}

/**
 * Shared happy-path sidecar wiring (context -> page -> navigate -> content ->
 * close) used by the newer, more targeted mutation-kill tests below. Each of
 * `htmlByUrl`'s entries navigates with a 200 status and serves the given HTML
 * body; every URL not present in the map still gets a "successful" navigate
 * but an `undefined` content body (so callers that need a specific URL to
 * come back `null`-ish should route through the dedicated per-test mock
 * instead of this helper — see the "Failed to load metro listing page" test).
 */
function mockSidecarFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  htmlByUrl: Record<string, string>,
): void {
  let contextCalls = 0;
  let pageCalls = 0;
  const pageIdToUrl = new Map<string, string>();

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
    const navExec = /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/(page-\d+)\/navigate$/.exec(url);
    if (method === "POST" && navExec) {
      const { url: targetUrl } = JSON.parse(init.body as string) as { url: string };
      pageIdToUrl.set(navExec[1]!, targetUrl);
      return jsonResponse(200, { status: 200, url: targetUrl });
    }
    const contentExec = /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/(page-\d+)\/content$/.exec(url);
    if (method === "GET" && contentExec) {
      const targetUrl = pageIdToUrl.get(contentExec[1]!)!;
      return jsonResponse(200, { content: htmlByUrl[targetUrl] });
    }
    if (method === "DELETE") {
      return emptyResponse(204);
    }
    throw new Error(`unexpected fetch call: ${method} ${url}`);
  });
}

describe("scrapeWithinRadius", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.STEALTH_SIDECAR_URL = BASE_URL;

    // Permissive default so closeSidecarSession's drain below (a best-effort
    // closeContext call against whatever a PREVIOUS test left cached in
    // session.ts's module-level singleton) always succeeds.
    fetchMock = vi.fn(async () => emptyResponse(204));
    vi.stubGlobal("fetch", fetchMock);
    await closeSidecarSession();
    fetchMock.mockReset();

    geocodeAddressMock.mockReset();
    politeDelayMock.mockClear();

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

  it("resolves to the parsed, geocoded, in-radius sales from a mocked sidecar", async () => {
    const listingHrefs = ["/GA/Decatur/30033/11111", "/GA/Decatur/30033/22222"];
    const htmlByUrl: Record<string, string> = {
      [METRO_LISTING_URL]: listingPage(listingHrefs),
      "https://www.estatesales.net/GA/Decatur/30033/11111": detailPage({
        title: "First Sale",
      }),
      "https://www.estatesales.net/GA/Decatur/30033/22222": detailPage({
        title: "Second Sale",
      }),
    };

    // Close to the test HOME_LAT/HOME_LON (33.0, -84.0 — see setup-env.ts):
    // well within any reasonable radius, so both listings pass the filter.
    geocodeAddressMock.mockResolvedValue({ lat: 33.01, lon: -84.01 });

    let contextCalls = 0;
    let pageCalls = 0;
    const pageIdToUrl = new Map<string, string>();

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
      const navExec = /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/(page-\d+)\/navigate$/.exec(url);
      if (method === "POST" && navExec) {
        const { url: targetUrl } = JSON.parse(init.body as string) as { url: string };
        pageIdToUrl.set(navExec[1]!, targetUrl);
        return jsonResponse(200, { status: 200, url: targetUrl });
      }
      const contentExec = /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/(page-\d+)\/content$/.exec(url);
      if (method === "GET" && contentExec) {
        const targetUrl = pageIdToUrl.get(contentExec[1]!)!;
        return jsonResponse(200, { content: htmlByUrl[targetUrl] });
      }
      if (method === "DELETE") {
        return emptyResponse(204);
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    const result = await scrapeWithinRadius({ radiusMiles: 50 });

    expect(result).toHaveLength(2);
    expect(result.map((sale) => sale.saleId).sort()).toEqual(["11111", "22222"]);
    expect(result.find((sale) => sale.saleId === "11111")).toMatchObject({
      title: "First Sale",
      address: "123 Main St",
      city: "Decatur",
      state: "GA",
      zip: "30033",
      lat: 33.01,
      lon: -84.01,
    });
    for (const sale of result) {
      expect(typeof sale.distanceMiles).toBe("number");
      expect(sale.distanceMiles).toBeLessThan(50);
    }

    // The shared context is torn down at the end of the run (finally block).
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/v1/contexts/ctx-1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("rejects (does not resolve to an empty/partial array) when the sidecar is unreachable at connect level", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method === "POST" && url === `${BASE_URL}/v1/contexts`) {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      if (method === "DELETE") {
        return emptyResponse(204);
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    await expect(scrapeWithinRadius({ radiusMiles: 50 })).rejects.toThrow(
      SidecarUnreachableError,
    );

    // Never got far enough to parse a listing or geocode anything.
    expect(geocodeAddressMock).not.toHaveBeenCalled();
  });

  it("skips a listing whose detail fetch hangs (logged null), and still returns the other listings", async () => {
    vi.useFakeTimers();

    const listingHrefs = ["/GA/Decatur/30033/11111", "/GA/Decatur/30033/22222"];
    const HANGING_URL = "https://www.estatesales.net/GA/Decatur/30033/11111";
    const OK_URL = "https://www.estatesales.net/GA/Decatur/30033/22222";
    const htmlByUrl: Record<string, string> = {
      [METRO_LISTING_URL]: listingPage(listingHrefs),
      [OK_URL]: detailPage({ title: "Second Sale" }),
    };

    geocodeAddressMock.mockResolvedValue({ lat: 33.01, lon: -84.01 });

    let contextCalls = 0;
    let pageCalls = 0;
    const pageIdToUrl = new Map<string, string>();

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
      const navExec = /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/(page-\d+)\/navigate$/.exec(url);
      if (method === "POST" && navExec) {
        const { url: targetUrl } = JSON.parse(init.body as string) as { url: string };
        if (targetUrl === HANGING_URL) {
          // Simulates a hung target page: this fetch call never settles, so
          // the 20s combined navigate+content timeout must win the race for
          // this ONE listing while the rest of the loop carries on.
          return new Promise<Response>(() => {});
        }
        pageIdToUrl.set(navExec[1]!, targetUrl);
        return jsonResponse(200, { status: 200, url: targetUrl });
      }
      const contentExec = /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/(page-\d+)\/content$/.exec(url);
      if (method === "GET" && contentExec) {
        const targetUrl = pageIdToUrl.get(contentExec[1]!)!;
        return jsonResponse(200, { content: htmlByUrl[targetUrl] });
      }
      if (method === "DELETE") {
        return emptyResponse(204);
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    const resultPromise = scrapeWithinRadius({ radiusMiles: 50 });
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await resultPromise;

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ saleId: "22222", title: "Second Sale" });

    const loggedTimeout = consoleErrorSpy.mock.calls.some(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("timeout") &&
        call[0].includes(HANGING_URL),
    );
    expect(loggedTimeout).toBe(true);
  });

  it("rejects with 'Failed to load metro listing page.' when the metro listing page fetch resolves to null", async () => {
    // fetchPageHtml (session.ts) maps a non-2xx navigate status to `null`
    // rather than throwing, so a 404 on the metro listing URL itself is the
    // way to simulate "listingHtml is null/empty" through the mocked sidecar.
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method === "POST" && url === `${BASE_URL}/v1/contexts`) {
        return jsonResponse(200, { context_id: "ctx-1" });
      }
      if (method === "POST" && /^http:\/\/127\.0\.0\.1:8000\/v1\/contexts\/ctx-\d+\/pages$/.test(url)) {
        return jsonResponse(200, { page_id: "page-1" });
      }
      if (method === "POST" && /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/page-\d+\/navigate$/.test(url)) {
        return jsonResponse(200, { status: 404, url: METRO_LISTING_URL });
      }
      if (method === "GET" && /^http:\/\/127\.0\.0\.1:8000\/v1\/pages\/page-\d+\/content$/.test(url)) {
        // Status is already 404 by the time fetchPageHtml checks it; the
        // content body itself is irrelevant to that check.
        return jsonResponse(200, { content: "" });
      }
      if (method === "DELETE") {
        return emptyResponse(204);
      }
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    });

    await expect(scrapeWithinRadius({ radiusMiles: 50 })).rejects.toThrow(
      "Failed to load metro listing page.",
    );

    // Never got far enough to parse a listing or geocode anything.
    expect(geocodeAddressMock).not.toHaveBeenCalled();
  });

  it("scrapes zero sales when maxSales is explicitly 0 (distinct from the default-all case when maxSales is omitted)", async () => {
    const listingHrefs = ["/GA/Decatur/30033/11111", "/GA/Decatur/30033/22222"];
    mockSidecarFetch(fetchMock, {
      [METRO_LISTING_URL]: listingPage(listingHrefs),
      "https://www.estatesales.net/GA/Decatur/30033/11111": detailPage(),
      "https://www.estatesales.net/GA/Decatur/30033/22222": detailPage(),
    });

    const result = await scrapeWithinRadius({ radiusMiles: 50, maxSales: 0 });

    expect(result).toEqual([]);
    // limit === 0 must stop the loop from ever fetching a detail page.
    expect(geocodeAddressMock).not.toHaveBeenCalled();
  });

  it("only scrapes maxSales listings even when more are available on the metro page", async () => {
    const listingHrefs = [
      "/GA/Decatur/30033/11111",
      "/GA/Decatur/30033/22222",
      "/GA/Decatur/30033/33333",
    ];
    mockSidecarFetch(fetchMock, {
      [METRO_LISTING_URL]: listingPage(listingHrefs),
      "https://www.estatesales.net/GA/Decatur/30033/11111": detailPage({ title: "First" }),
      "https://www.estatesales.net/GA/Decatur/30033/22222": detailPage({ title: "Second" }),
      "https://www.estatesales.net/GA/Decatur/30033/33333": detailPage({ title: "Third" }),
    });
    geocodeAddressMock.mockResolvedValue({ lat: 33.01, lon: -84.01 });

    const result = await scrapeWithinRadius({ radiusMiles: 50, maxSales: 1 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ saleId: "11111", title: "First" });
    // Proves the loop never even reached listings 2 or 3.
    expect(geocodeAddressMock).toHaveBeenCalledTimes(1);
  });

  it("skips a listing when geocodeAddress resolves to null, but still returns the other listings", async () => {
    const listingHrefs = ["/GA/Decatur/30033/11111", "/GA/Decatur/30033/22222"];
    mockSidecarFetch(fetchMock, {
      [METRO_LISTING_URL]: listingPage(listingHrefs),
      "https://www.estatesales.net/GA/Decatur/30033/11111": detailPage({ title: "Ungeocodable" }),
      "https://www.estatesales.net/GA/Decatur/30033/22222": detailPage({ title: "Geocodable" }),
    });
    geocodeAddressMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ lat: 33.01, lon: -84.01 });

    const result = await scrapeWithinRadius({ radiusMiles: 50 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ saleId: "22222", title: "Geocodable" });
    expect(geocodeAddressMock).toHaveBeenCalledTimes(2);
  });

  it("calls geocodeAddress with the listing's actual parsed address fields", async () => {
    const listingHrefs = ["/GA/Decatur/30033/11111"];
    mockSidecarFetch(fetchMock, {
      [METRO_LISTING_URL]: listingPage(listingHrefs),
      "https://www.estatesales.net/GA/Decatur/30033/11111": detailPage({
        addressLine1: "456 Oak Ave",
        addressLocality: "Atlanta",
        addressRegion: "GA",
        postalCode: "30301",
      }),
    });
    geocodeAddressMock.mockResolvedValue({ lat: 33.01, lon: -84.01 });

    await scrapeWithinRadius({ radiusMiles: 50 });

    expect(geocodeAddressMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "456 Oak Ave",
        city: "Atlanta",
        state: "GA",
        zip: "30301",
      }),
    );
  });

  it("skips a listing when parseSaleDetail returns null (missing required fields), but still returns the other listings", async () => {
    const listingHrefs = ["/GA/Decatur/30033/11111", "/GA/Decatur/30033/22222"];
    mockSidecarFetch(fetchMock, {
      [METRO_LISTING_URL]: listingPage(listingHrefs),
      // Dropping startDate (and its default) makes parseSaleDetail's
      // required-fields check fail and return null for this one listing.
      "https://www.estatesales.net/GA/Decatur/30033/11111": detailPage({
        title: "Unparseable",
        startDate: undefined,
      }),
      "https://www.estatesales.net/GA/Decatur/30033/22222": detailPage({ title: "Parseable" }),
    });
    geocodeAddressMock.mockResolvedValue({ lat: 33.01, lon: -84.01 });

    const result = await scrapeWithinRadius({ radiusMiles: 50 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ saleId: "22222", title: "Parseable" });
    // geocodeAddress must only have been reached for the parseable listing.
    expect(geocodeAddressMock).toHaveBeenCalledTimes(1);

    const loggedParseSkip = consoleErrorSpy.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("Could not parse detail page"),
    );
    expect(loggedParseSkip).toBe(true);
  });

  it("includes a sale exactly at the radius boundary and excludes one clearly outside it", async () => {
    const listingHrefs = ["/GA/Decatur/30033/11111", "/GA/Decatur/30033/22222"];
    const AT_EDGE_COORDS = { lat: 33.5, lon: -84.5 };
    const OUTSIDE_COORDS = { lat: 45.0, lon: -70.0 };
    // Computed via the same (unmocked) distanceFromHome the production code
    // calls, so distanceMiles === radiusMiles exactly for the first listing.
    const radiusMiles = distanceFromHome(AT_EDGE_COORDS.lat, AT_EDGE_COORDS.lon);

    mockSidecarFetch(fetchMock, {
      [METRO_LISTING_URL]: listingPage(listingHrefs),
      "https://www.estatesales.net/GA/Decatur/30033/11111": detailPage({ title: "At Edge" }),
      "https://www.estatesales.net/GA/Decatur/30033/22222": detailPage({ title: "Outside" }),
    });
    geocodeAddressMock
      .mockResolvedValueOnce(AT_EDGE_COORDS)
      .mockResolvedValueOnce(OUTSIDE_COORDS);

    const result = await scrapeWithinRadius({ radiusMiles });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ saleId: "11111", title: "At Edge" });
    expect(result[0]!.distanceMiles).toBe(radiusMiles);
  });
});
