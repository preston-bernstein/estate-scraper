import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * `api/src/import/index.ts` is a legacy-findings import CLI script: it has NO
 * exports (not `main`, not `ensureSaleRecord`) and runs `main()` as a
 * module-level side effect the moment it's imported, ending in:
 *
 *   main().catch((error) => { console.error(error); process.exit(1); });
 *
 * So the only way to exercise `ensureSaleRecord`/`main()`'s behavior is
 * indirectly, through that side effect: mock every boundary module it talks
 * to (fs, the DB persistence layer, geo, the sidecar-backed http fetch, and
 * sale-detail parsing), dynamically `import("../index.js")` fresh per test
 * (via `vi.resetModules()` + `vi.doMock()`, same non-hoisted-mock technique
 * used to isolate module-level state elsewhere in this repo), then assert on
 * what the mocks observed — DB calls made, `closeSidecarSession` being
 * invoked, and `process.exit`/`console.error` on the failure path.
 */

type LegacySale = {
  sale_id: string;
  title: string;
  url: string;
  findings: Array<{ image_url: string; findings: string }>;
};

const ORIGINAL_ARGV = process.argv;

function detailFor(entry: LegacySale) {
  return {
    saleId: entry.sale_id,
    title: `Detail: ${entry.title}`,
    url: entry.url,
    startDate: "2026-08-01",
    endDate: "2026-08-02",
    address: "123 Main St",
    city: "Testville",
    state: "GA",
    zip: "30000",
    imageUrls: entry.findings.map((f) => f.image_url),
  };
}

describe("import/index.ts main() (via module side effect)", () => {
  let exitSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let consoleLogSpy: MockInstance;

  beforeEach(() => {
    vi.resetModules();
    // No --file/--seed-hunts args unless a test sets its own — otherwise
    // whatever argv vitest itself was invoked with would leak into main()'s
    // own process.argv.slice(2) parsing.
    process.argv = ["node", "index.js"];

    // process.exit(1) would actually kill the test runner process if left
    // real. Recording-only (no throw) keeps the `.catch` handler's own
    // control flow intact — it's the last statement in that handler, so
    // nothing further executes after it either way.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.doUnmock("../../db/index.js");
    vi.doUnmock("../../scan/persist.js");
    vi.doUnmock("../../lib/geo.js");
    vi.doUnmock("../../lib/http.js");
    vi.doUnmock("../../lib/stealth-sidecar/session.js");
    vi.doUnmock("../../scraper/parse.js");
  });

  it("happy path: imports each sale and its findings via the mocked sidecar, then closes the session", async () => {
    const entries: LegacySale[] = [
      {
        sale_id: "sale-1",
        title: "Sale One",
        url: "https://example.com/sale-1",
        findings: [{ image_url: "https://img.example.com/1.jpg", findings: "a Stickley chair" }],
      },
      {
        sale_id: "sale-2",
        title: "Sale Two",
        url: "https://example.com/sale-2",
        findings: [
          { image_url: "https://img.example.com/2.jpg", findings: "a silver candlestick" },
          // Already processed on a prior run — must be skipped, not re-inserted.
          { image_url: "https://img.example.com/already-seen.jpg", findings: "junk" },
        ],
      },
    ];

    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => JSON.stringify(entries)),
    }));

    const runMigrations = vi.fn();
    vi.doMock("../../db/index.js", () => ({ runMigrations, db: {} }));

    const getProcessedImageUrls = vi.fn(async () => new Set(["https://img.example.com/already-seen.jpg"]));
    const upsertSale = vi.fn(async () => undefined);
    const insertFinding = vi.fn(async () => undefined);
    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls,
      upsertSale,
      insertFinding,
    }));

    const distanceFromHome = vi.fn(() => 12.5);
    const geocodeAddress = vi.fn(async () => ({ lat: 33.1, lon: -84.1 }));
    vi.doMock("../../lib/geo.js", () => ({ distanceFromHome, geocodeAddress }));

    const fetchText = vi.fn(async (url: string) => `<html>${url}</html>`);
    vi.doMock("../../lib/http.js", () => ({ fetchText }));

    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));

    const parseSaleDetail = vi.fn((_html: string, url: string) => {
      const entry = entries.find((e) => e.url === url)!;
      return detailFor(entry);
    });
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    // Ran migrations and pulled the skip-set before processing anything.
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(getProcessedImageUrls).toHaveBeenCalledTimes(1);

    // Fetched + parsed + geocoded each of the two sales.
    expect(fetchText).toHaveBeenCalledWith("https://example.com/sale-1");
    expect(fetchText).toHaveBeenCalledWith("https://example.com/sale-2");
    expect(parseSaleDetail).toHaveBeenCalledTimes(2);
    expect(geocodeAddress).toHaveBeenCalledTimes(2);
    // geocodeAddress must be called with the actual parsed-detail fields, not
    // an empty/stubbed object — kills the ObjectLiteral mutant that reduces
    // the call site to `geocodeAddress({})`.
    expect(geocodeAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "123 Main St",
        city: "Testville",
        state: "GA",
        zip: "30000",
      }),
    );

    // upsertSale called once per sale with the merged detail+geocode shape.
    expect(upsertSale).toHaveBeenCalledTimes(2);
    expect(upsertSale).toHaveBeenCalledWith(
      expect.objectContaining({
        saleId: "sale-1",
        title: "Sale One", // entry.title wins over detail.title when truthy
        lat: 33.1,
        lon: -84.1,
        distanceMiles: 12.5,
      }),
      expect.any(String),
    );

    // Only the two NOT-already-processed findings get inserted; the
    // already-seen image_url is skipped rather than re-inserted.
    expect(insertFinding).toHaveBeenCalledTimes(2);
    expect(insertFinding).toHaveBeenCalledWith(
      "sale-1",
      "https://img.example.com/1.jpg",
      "a Stickley chair",
      expect.any(String),
    );
    expect(insertFinding).toHaveBeenCalledWith(
      "sale-2",
      "https://img.example.com/2.jpg",
      "a silver candlestick",
      expect.any(String),
    );
    expect(insertFinding).not.toHaveBeenCalledWith(
      "sale-2",
      "https://img.example.com/already-seen.jpg",
      expect.anything(),
      expect.anything(),
    );

    // No error path was taken.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // Progress log lines use 1-based indexing over the exact entry count —
    // kills the ArithmeticOperator (+1 -> -1) and StringLiteral (message ->
    // "") mutants on the `[${index + 1}/${entries.length}] ${entry.sale_id}`
    // log line.
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("[1/2] sale-1"),
      ),
    ).toBe(true);
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("[2/2] sale-2"),
      ),
    ).toBe(true);

    // Full summary line, including the (1 skipped) count — kills the
    // AssignmentOperator (+= -> -=) mutant on `findingsSkipped += 1`, which
    // would otherwise report "(-1 skipped)" here.
    expect(
      consoleLogSpy.mock.calls.some(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("Import complete: 2 sales, 2 findings (1 skipped)."),
      ),
    ).toBe(true);
  });

  it("aborts cleanly (no partial writes for later entries) when the sidecar is unreachable for an entry", async () => {
    const entries: LegacySale[] = [
      {
        sale_id: "sale-bad",
        title: "Sale Bad",
        url: "https://example.com/sale-bad",
        findings: [{ image_url: "https://img.example.com/bad.jpg", findings: "whatever" }],
      },
      {
        sale_id: "sale-good",
        title: "Sale Good",
        url: "https://example.com/sale-good",
        findings: [{ image_url: "https://img.example.com/good.jpg", findings: "whatever else" }],
      },
    ];

    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => JSON.stringify(entries)),
    }));

    const runMigrations = vi.fn();
    vi.doMock("../../db/index.js", () => ({ runMigrations, db: {} }));

    const getProcessedImageUrls = vi.fn(async () => new Set<string>());
    const upsertSale = vi.fn(async () => undefined);
    const insertFinding = vi.fn(async () => undefined);
    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls,
      upsertSale,
      insertFinding,
    }));

    const distanceFromHome = vi.fn(() => 1);
    const geocodeAddress = vi.fn(async () => ({ lat: 1, lon: 1 }));
    vi.doMock("../../lib/geo.js", () => ({ distanceFromHome, geocodeAddress }));

    // Simulates the sidecar being unreachable at connect time — fetchText
    // (a thin wrapper over the sidecar-backed fetchPageHtml) rejects rather
    // than resolving to null, exactly like SidecarUnreachableError does in
    // ../lib/http.ts's own contract.
    const fetchText = vi.fn(async (url: string) => {
      if (url === "https://example.com/sale-bad") {
        throw new Error("sidecar unreachable: ECONNREFUSED");
      }
      return `<html>${url}</html>`;
    });
    vi.doMock("../../lib/http.js", () => ({ fetchText }));

    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));

    const parseSaleDetail = vi.fn((_html: string, url: string) => {
      const entry = entries.find((e) => e.url === url)!;
      return detailFor(entry);
    });
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    // The run aborted on the first entry's failure rather than continuing on
    // to the second (good) entry with partial data.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(Error));
    expect(fetchText).toHaveBeenCalledWith("https://example.com/sale-bad");
    expect(fetchText).not.toHaveBeenCalledWith("https://example.com/sale-good");
    expect(parseSaleDetail).not.toHaveBeenCalled();
    expect(upsertSale).not.toHaveBeenCalled();
    expect(insertFinding).not.toHaveBeenCalled();

    // The sidecar session is still torn down on the failure path — the
    // `finally` block in main() runs regardless of how the try block exits.
    expect(closeSidecarSession).toHaveBeenCalledTimes(1);
  });

  it("skips only the one entry whose fetchText resolves to null (site returned nothing), other entries still process", async () => {
    const entries: LegacySale[] = [
      {
        sale_id: "sale-nohtml",
        title: "Sale No Html",
        url: "https://example.com/sale-nohtml",
        findings: [{ image_url: "https://img.example.com/nohtml.jpg", findings: "whatever" }],
      },
      {
        sale_id: "sale-good",
        title: "Sale Good",
        url: "https://example.com/sale-good",
        findings: [{ image_url: "https://img.example.com/good.jpg", findings: "whatever else" }],
      },
    ];

    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => JSON.stringify(entries)),
    }));
    vi.doMock("../../db/index.js", () => ({ runMigrations: vi.fn(), db: {} }));

    const getProcessedImageUrls = vi.fn(async () => new Set<string>());
    const upsertSale = vi.fn(async () => undefined);
    const insertFinding = vi.fn(async () => undefined);
    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls,
      upsertSale,
      insertFinding,
    }));

    const distanceFromHome = vi.fn(() => 1);
    const geocodeAddress = vi.fn(async () => ({ lat: 1, lon: 1 }));
    vi.doMock("../../lib/geo.js", () => ({ distanceFromHome, geocodeAddress }));

    // Returns null (not a rejection) for the first sale's URL — the "site
    // returned nothing useful" branch, distinct from a thrown/network error.
    const fetchText = vi.fn(async (url: string) => {
      if (url === "https://example.com/sale-nohtml") return null;
      return `<html>${url}</html>`;
    });
    vi.doMock("../../lib/http.js", () => ({ fetchText }));

    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));

    const parseSaleDetail = vi.fn((_html: string, url: string) => {
      const entry = entries.find((e) => e.url === url)!;
      return detailFor(entry);
    });
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    // The null-html entry is skipped with the exact skip message...
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "  [skip] Could not fetch https://example.com/sale-nohtml",
    );
    // ...never reaches parse/geocode/persist for that entry...
    expect(parseSaleDetail).not.toHaveBeenCalledWith(
      expect.anything(),
      "https://example.com/sale-nohtml",
    );
    expect(upsertSale).not.toHaveBeenCalledWith(
      expect.objectContaining({ saleId: "sale-nohtml" }),
      expect.anything(),
    );

    // ...while the other entry still processes normally.
    expect(fetchText).toHaveBeenCalledWith("https://example.com/sale-good");
    expect(upsertSale).toHaveBeenCalledTimes(1);
    expect(upsertSale).toHaveBeenCalledWith(
      expect.objectContaining({ saleId: "sale-good" }),
      expect.any(String),
    );
    expect(insertFinding).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Import complete: 1 sales, 1 findings (0 skipped)."),
      ),
    ).toBe(true);
  });

  it("skips only the one entry whose parseSaleDetail resolves to null (unparseable html), other entries still process", async () => {
    const entries: LegacySale[] = [
      {
        sale_id: "sale-unparseable",
        title: "Sale Unparseable",
        url: "https://example.com/sale-unparseable",
        findings: [{ image_url: "https://img.example.com/up.jpg", findings: "whatever" }],
      },
      {
        sale_id: "sale-good",
        title: "Sale Good",
        url: "https://example.com/sale-good",
        findings: [{ image_url: "https://img.example.com/good.jpg", findings: "whatever else" }],
      },
    ];

    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => JSON.stringify(entries)),
    }));
    vi.doMock("../../db/index.js", () => ({ runMigrations: vi.fn(), db: {} }));

    const getProcessedImageUrls = vi.fn(async () => new Set<string>());
    const upsertSale = vi.fn(async () => undefined);
    const insertFinding = vi.fn(async () => undefined);
    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls,
      upsertSale,
      insertFinding,
    }));

    const distanceFromHome = vi.fn(() => 1);
    const geocodeAddress = vi.fn(async () => ({ lat: 1, lon: 1 }));
    vi.doMock("../../lib/geo.js", () => ({ distanceFromHome, geocodeAddress }));

    const fetchText = vi.fn(async (url: string) => `<html>${url}</html>`);
    vi.doMock("../../lib/http.js", () => ({ fetchText }));

    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));

    const parseSaleDetail = vi.fn((_html: string, url: string) => {
      if (url === "https://example.com/sale-unparseable") return null;
      const entry = entries.find((e) => e.url === url)!;
      return detailFor(entry);
    });
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "  [skip] Could not parse https://example.com/sale-unparseable",
    );
    expect(geocodeAddress).not.toHaveBeenCalledTimes(2);
    expect(upsertSale).not.toHaveBeenCalledWith(
      expect.objectContaining({ saleId: "sale-unparseable" }),
      expect.anything(),
    );

    expect(upsertSale).toHaveBeenCalledTimes(1);
    expect(upsertSale).toHaveBeenCalledWith(
      expect.objectContaining({ saleId: "sale-good" }),
      expect.any(String),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Import complete: 1 sales, 1 findings (0 skipped)."),
      ),
    ).toBe(true);
  });

  it("skips only the one entry whose geocodeAddress resolves to null (unresolvable address), other entries still process", async () => {
    const badEntry: LegacySale = {
      sale_id: "sale-nogeo",
      title: "Sale No Geo",
      url: "https://example.com/sale-nogeo",
      findings: [{ image_url: "https://img.example.com/nogeo.jpg", findings: "whatever" }],
    };
    const goodEntry: LegacySale = {
      sale_id: "sale-good",
      title: "Sale Good",
      url: "https://example.com/sale-good",
      findings: [{ image_url: "https://img.example.com/good.jpg", findings: "whatever else" }],
    };
    const entries: LegacySale[] = [badEntry, goodEntry];

    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => JSON.stringify(entries)),
    }));
    vi.doMock("../../db/index.js", () => ({ runMigrations: vi.fn(), db: {} }));

    const getProcessedImageUrls = vi.fn(async () => new Set<string>());
    const upsertSale = vi.fn(async () => undefined);
    const insertFinding = vi.fn(async () => undefined);
    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls,
      upsertSale,
      insertFinding,
    }));

    const distanceFromHome = vi.fn(() => 1);
    // Unresolvable street address for the bad entry; valid coords otherwise.
    const geocodeAddress = vi.fn(async (args: { address: string }) => {
      if (args.address === "999 Nowhere Rd") return null;
      return { lat: 1, lon: 1 };
    });
    vi.doMock("../../lib/geo.js", () => ({ distanceFromHome, geocodeAddress }));

    const fetchText = vi.fn(async (url: string) => `<html>${url}</html>`);
    vi.doMock("../../lib/http.js", () => ({ fetchText }));

    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));

    const parseSaleDetail = vi.fn((_html: string, url: string) => {
      if (url === badEntry.url) {
        return { ...detailFor(badEntry), address: "999 Nowhere Rd" };
      }
      return detailFor(goodEntry);
    });
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "  [skip] Geocode failed for 999 Nowhere Rd",
    );
    expect(upsertSale).not.toHaveBeenCalledWith(
      expect.objectContaining({ saleId: "sale-nogeo" }),
      expect.anything(),
    );

    expect(upsertSale).toHaveBeenCalledTimes(1);
    expect(upsertSale).toHaveBeenCalledWith(
      expect.objectContaining({ saleId: "sale-good" }),
      expect.any(String),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Import complete: 1 sales, 1 findings (0 skipped)."),
      ),
    ).toBe(true);
  });

  it("reads from the default ../findings.json path when no --file arg is given", async () => {
    const readFileSync = vi.fn(() => "[]");
    vi.doMock("node:fs", () => ({ readFileSync }));
    vi.doMock("../../db/index.js", () => ({ runMigrations: vi.fn(), db: {} }));

    const getProcessedImageUrls = vi.fn(async () => new Set<string>());
    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls,
      upsertSale: vi.fn(async () => undefined),
      insertFinding: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/geo.js", () => ({
      distanceFromHome: vi.fn(() => 1),
      geocodeAddress: vi.fn(async () => ({ lat: 1, lon: 1 })),
    }));
    vi.doMock("../../lib/http.js", () => ({ fetchText: vi.fn(async () => "<html></html>") }));
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({
      closeSidecarSession: vi.fn(async () => undefined),
    }));
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail: vi.fn() }));

    // No --file arg — process.argv is left at the beforeEach default of
    // ["node", "index.js"].
    await import("../index.js");

    await vi.waitFor(() => {
      expect(readFileSync).toHaveBeenCalled();
    });

    // Kills the StringLiteral mutant on the default `"../findings.json"`
    // literal — the resolved path must end with the real default filename.
    expect(readFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/findings\.json$/),
      "utf8",
    );
  });

  it("--seed-hunts flag (parsed from a correctly `.slice(2)`-offset argv) runs seedDefaultHunts and inserts the default Hunts", async () => {
    // Extra leading elements ahead of the real flags, exactly like the real
    // process.argv shape (["node", "/path/to/index.js", ...userArgs]) — this
    // proves args = process.argv.slice(2) is load-bearing: if the `.slice(2)`
    // were removed, "node" and the script path would be walked as if they
    // were flags/values too. Also exercises the loop with a known args.length
    // (1, after the correct offset) to confirm the loop body actually runs.
    process.argv = ["node", "index.js", "--seed-hunts"];

    vi.doMock("node:fs", () => ({ readFileSync: vi.fn(() => "[]") }));

    const insertValues = vi.fn(async () => undefined);
    const insertMock = vi.fn(() => ({ values: insertValues }));
    const selectWhere = vi.fn(async () => []); // no existing hunts for dev-user
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const selectMock = vi.fn(() => ({ from: selectFrom }));
    const runMigrations = vi.fn();
    vi.doMock("../../db/index.js", () => ({
      runMigrations,
      db: { select: selectMock, insert: insertMock },
    }));

    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls: vi.fn(async () => new Set<string>()),
      upsertSale: vi.fn(async () => undefined),
      insertFinding: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/geo.js", () => ({
      distanceFromHome: vi.fn(() => 1),
      geocodeAddress: vi.fn(async () => ({ lat: 1, lon: 1 })),
    }));
    vi.doMock("../../lib/http.js", () => ({ fetchText: vi.fn(async () => "<html></html>") }));
    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail: vi.fn() }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    // The flag was recognized (loop ran, `--seed-hunts` matched) and
    // seedDefaultHunts's real effects happened: existing Hunts looked up,
    // then all 3 defaults inserted for dev-user.
    expect(selectWhere).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(3);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSub: "dev-user", name: "furniture" }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSub: "dev-user", name: "silver" }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSub: "dev-user", name: "art" }),
    );
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Seeded default Hunts for dev-user."),
      ),
    ).toBe(true);
  });

  it("without --seed-hunts, seedDefaultHunts's effects never run", async () => {
    // Default argv from beforeEach: ["node", "index.js"] — no --seed-hunts.
    vi.doMock("node:fs", () => ({ readFileSync: vi.fn(() => "[]") }));

    const insertValues = vi.fn(async () => undefined);
    const insertMock = vi.fn(() => ({ values: insertValues }));
    const selectWhere = vi.fn(async () => []);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const selectMock = vi.fn(() => ({ from: selectFrom }));
    vi.doMock("../../db/index.js", () => ({
      runMigrations: vi.fn(),
      db: { select: selectMock, insert: insertMock },
    }));

    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls: vi.fn(async () => new Set<string>()),
      upsertSale: vi.fn(async () => undefined),
      insertFinding: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/geo.js", () => ({
      distanceFromHome: vi.fn(() => 1),
      geocodeAddress: vi.fn(async () => ({ lat: 1, lon: 1 })),
    }));
    vi.doMock("../../lib/http.js", () => ({ fetchText: vi.fn(async () => "<html></html>") }));
    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail: vi.fn() }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    expect(selectMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Seeded default Hunts"),
      ),
    ).toBe(false);
  });

  it("a trailing --file with no following value fails fast (documents current behavior) rather than silently misparsing", async () => {
    // args = ["--file"] after the correct slice(2) offset — args[++index] is
    // out of bounds, so `resolve(cwd, undefined!)` throws synchronously.
    // This documents (and locks in) the current real behavior rather than
    // asserting a "should" that isn't implemented.
    process.argv = ["node", "index.js", "--file"];

    vi.doMock("node:fs", () => ({ readFileSync: vi.fn(() => "[]") }));
    vi.doMock("../../db/index.js", () => ({ runMigrations: vi.fn(), db: {} }));
    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls: vi.fn(async () => new Set<string>()),
      upsertSale: vi.fn(async () => undefined),
      insertFinding: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/geo.js", () => ({
      distanceFromHome: vi.fn(() => 1),
      geocodeAddress: vi.fn(async () => ({ lat: 1, lon: 1 })),
    }));
    vi.doMock("../../lib/http.js", () => ({ fetchText: vi.fn(async () => "<html></html>") }));
    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail: vi.fn() }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("must be of type string"),
      }),
    );
    // The sidecar session is still closed via the `finally` block even
    // though the crash happened before the try block's main work.
    expect(closeSidecarSession).toHaveBeenCalledTimes(1);
  });

  it("process.argv.slice(2) strips the node/script-path placeholders, so a flag-shaped value sitting in one of those two positions is never parsed as a real flag", async () => {
    // Deliberately put "--seed-hunts" where the interpreter path would
    // normally sit (argv[0]) and a throwaway value where the script path
    // would sit (argv[1]) — exactly the two positions `.slice(2)` exists to
    // discard. If `.slice(2)` were removed (MethodExpression mutant, args
    // becoming the full process.argv), the loop would walk right over these
    // two "placeholder" slots and treat "--seed-hunts" as a real flag,
    // flipping seedHunts to true. Under the correct code they're sliced away
    // before the loop ever sees them, so seedHunts must stay false and
    // seedDefaultHunts's DB effects must never fire. The trailing
    // `--file /tmp/real.json` (the genuine user args) still resolves
    // correctly either way, which is exactly why asserting on filePath alone
    // wouldn't discriminate the mutant — the seedHunts side effect is the
    // only observable difference.
    process.argv = ["--seed-hunts", "placeholder", "--file", "/tmp/real.json"];

    const readFileSync = vi.fn(() => "[]");
    vi.doMock("node:fs", () => ({ readFileSync }));

    const selectWhere = vi.fn(async () => []);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const selectMock = vi.fn(() => ({ from: selectFrom }));
    const insertValues = vi.fn(async () => undefined);
    const insertMock = vi.fn(() => ({ values: insertValues }));
    vi.doMock("../../db/index.js", () => ({
      runMigrations: vi.fn(),
      db: { select: selectMock, insert: insertMock },
    }));

    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls: vi.fn(async () => new Set<string>()),
      upsertSale: vi.fn(async () => undefined),
      insertFinding: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/geo.js", () => ({
      distanceFromHome: vi.fn(() => 1),
      geocodeAddress: vi.fn(async () => ({ lat: 1, lon: 1 })),
    }));
    vi.doMock("../../lib/http.js", () => ({ fetchText: vi.fn(async () => "<html></html>") }));
    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail: vi.fn() }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    // The real --file value still resolved correctly...
    expect(readFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\/tmp\/real\.json$/),
      "utf8",
    );
    // ...but the placeholder "--seed-hunts" sitting in the sliced-off
    // position must NOT have been treated as a real flag.
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("--file consumes the NEXT array element via args[++index] (not the previous one)", async () => {
    // A multi-arg argv where "--file" is followed by a real value at a
    // distinct, later index. The UpdateOperator mutant (++index -> --index)
    // would instead read args[-1] (undefined, since JS arrays don't support
    // negative indices), which makes `resolve(cwd(), undefined!)` throw
    // synchronously — surfacing as process.exit(1) and readFileSync never
    // being called at all. Under the correct `++index`, readFileSync must be
    // called with the path that follows "--file", and the run must succeed
    // (no exit(1)).
    process.argv = ["node", "index.js", "--file", "/custom/path.json"];

    const readFileSync = vi.fn(() => "[]");
    vi.doMock("node:fs", () => ({ readFileSync }));
    vi.doMock("../../db/index.js", () => ({ runMigrations: vi.fn(), db: {} }));
    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls: vi.fn(async () => new Set<string>()),
      upsertSale: vi.fn(async () => undefined),
      insertFinding: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/geo.js", () => ({
      distanceFromHome: vi.fn(() => 1),
      geocodeAddress: vi.fn(async () => ({ lat: 1, lon: 1 })),
    }));
    vi.doMock("../../lib/http.js", () => ({ fetchText: vi.fn(async () => "<html></html>") }));
    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail: vi.fn() }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    expect(readFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\/custom\/path\.json$/),
      "utf8",
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("an unrecognized flag does not toggle seed-hunts (kills the always-true ConditionalExpression mutant on `arg === \"--seed-hunts\"`)", async () => {
    // A real, non-matching arg is required so the loop body actually
    // executes the `else if (arg === "--seed-hunts")` check — an empty/short
    // argv never reaches this branch at all, so it can't discriminate a
    // forced-true condition from the real equality check.
    process.argv = ["node", "index.js", "--verbose"];

    vi.doMock("node:fs", () => ({ readFileSync: vi.fn(() => "[]") }));

    const insertValues = vi.fn(async () => undefined);
    const insertMock = vi.fn(() => ({ values: insertValues }));
    const selectWhere = vi.fn(async () => []);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const selectMock = vi.fn(() => ({ from: selectFrom }));
    vi.doMock("../../db/index.js", () => ({
      runMigrations: vi.fn(),
      db: { select: selectMock, insert: insertMock },
    }));

    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls: vi.fn(async () => new Set<string>()),
      upsertSale: vi.fn(async () => undefined),
      insertFinding: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/geo.js", () => ({
      distanceFromHome: vi.fn(() => 1),
      geocodeAddress: vi.fn(async () => ({ lat: 1, lon: 1 })),
    }));
    vi.doMock("../../lib/http.js", () => ({ fetchText: vi.fn(async () => "<html></html>") }));
    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail: vi.fn() }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    expect(selectMock).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Seeded default Hunts"),
      ),
    ).toBe(false);
  });

  it("seedDefaultHunts skips a default whose name already exists for the dev user, but still inserts the others", async () => {
    process.argv = ["node", "index.js", "--seed-hunts"];

    vi.doMock("node:fs", () => ({ readFileSync: vi.fn(() => "[]") }));

    const insertValues = vi.fn(async () => undefined);
    const insertMock = vi.fn(() => ({ values: insertValues }));
    // "furniture" already exists for dev-user — the skip-if-existing branch
    // (`if (existingNames.has(hunt.name)) continue;`) must skip only this one.
    const selectWhere = vi.fn(async () => [
      { name: "furniture", ownerSub: "dev-user", keywords: [], createdAt: "2026-01-01" },
    ]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const selectMock = vi.fn(() => ({ from: selectFrom }));
    vi.doMock("../../db/index.js", () => ({
      runMigrations: vi.fn(),
      db: { select: selectMock, insert: insertMock },
    }));

    vi.doMock("../../scan/persist.js", () => ({
      getProcessedImageUrls: vi.fn(async () => new Set<string>()),
      upsertSale: vi.fn(async () => undefined),
      insertFinding: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/geo.js", () => ({
      distanceFromHome: vi.fn(() => 1),
      geocodeAddress: vi.fn(async () => ({ lat: 1, lon: 1 })),
    }));
    vi.doMock("../../lib/http.js", () => ({ fetchText: vi.fn(async () => "<html></html>") }));
    const closeSidecarSession = vi.fn(async () => undefined);
    vi.doMock("../../lib/stealth-sidecar/session.js", () => ({ closeSidecarSession }));
    vi.doMock("../../scraper/parse.js", () => ({ parseSaleDetail: vi.fn() }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(closeSidecarSession).toHaveBeenCalledTimes(1);
    });

    // Only silver + art get inserted; furniture is skipped because it
    // already exists for dev-user.
    expect(insertValues).toHaveBeenCalledTimes(2);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSub: "dev-user", name: "silver" }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSub: "dev-user", name: "art" }),
    );
    expect(insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "furniture" }),
    );
  });
});
