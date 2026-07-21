import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * `api/src/scan/index.ts` is a CLI script with no exports; `main()` runs as a
 * module-level side effect ending in:
 *
 *   main().catch((error) => { console.error(error); process.exit(1); });
 *
 * This file does NOT attempt to cover the whole vision-pipeline flow (that
 * predates this migration and is out of scope). It verifies exactly one
 * piece of new logic: the catch block in main() prefixes `SidecarError`
 * failures with "sidecar error: " before they reach `writer.finish()` /
 * `console.error()`, so operators can tell a sidecar-origin scan failure
 * apart from a generic one.
 *
 * `scrapeWithinRadius` is the first awaited call inside main()'s try block
 * (right after `writer.setPhase("scraping", ...)`), so rejecting it there
 * short-circuits straight to the catch block — none of the later
 * vision-pipeline mocks need real behavior beyond existing.
 */

const ORIGINAL_ARGV = process.argv;

describe("scan/index.ts main() (via module side effect)", () => {
  let consoleErrorSpy: MockInstance;
  let consoleLogSpy: MockInstance;
  let finishMock: ReturnType<typeof vi.fn>;
  let pushEventMock: ReturnType<typeof vi.fn>;
  let setPhaseMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.argv = ["node", "index.js"];

    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.doMock("../../db/index.js", () => ({ runMigrations: vi.fn() }));

    vi.doMock("../persist.js", () => ({
      getScanRadiusMiles: vi.fn(async () => 25),
      getProcessedImageUrls: vi.fn(async () => new Set<string>()),
      insertFindingsBatch: vi.fn(async () => undefined),
      markBoilerplateImages: vi.fn(async () => undefined),
      updateSaleAnalysis: vi.fn(async () => undefined),
      updateSaleOracle: vi.fn(async () => undefined),
      upsertAnalyzedImages: vi.fn(async () => undefined),
      upsertSale: vi.fn(async () => undefined),
    }));

    vi.doMock("../../vision/oracle.js", () => ({ callOracle: vi.fn(async () => null) }));
    vi.doMock("../../vision/index.js", () => ({
      checkModelAvailable: vi.fn(async () => true),
      processSalesStream: vi.fn(async function* () {}),
    }));
    vi.doMock("../embed-pass.js", () => ({
      embedPendingImages: vi.fn(async () => ({ skipped: true, embedded: 0, failed: 0 })),
    }));

    finishMock = vi.fn();
    pushEventMock = vi.fn();
    setPhaseMock = vi.fn();
    vi.doMock("../state.js", () => ({
      ScanStateWriter: vi.fn().mockImplementation(() => ({
        setPhase: setPhaseMock,
        pushEvent: pushEventMock,
        finish: finishMock,
      })),
    }));
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    vi.restoreAllMocks();
    vi.doUnmock("../../db/index.js");
    vi.doUnmock("../persist.js");
    vi.doUnmock("../../vision/oracle.js");
    vi.doUnmock("../../vision/index.js");
    vi.doUnmock("../embed-pass.js");
    vi.doUnmock("../state.js");
    vi.doUnmock("../../scraper/index.js");
  });

  it('prefixes a SidecarError-origin scrape failure with "sidecar error: " before it reaches writer.finish() / console.error()', async () => {
    // Loaded dynamically (rather than statically at file-top) AFTER
    // vi.resetModules() so it resolves to the SAME module-cache instance
    // that scan/index.ts's own `import { SidecarError } from
    // "../lib/stealth-sidecar/errors.js"` will resolve to below — otherwise
    // `error instanceof SidecarError` inside index.ts would compare against
    // a different (stale) class object and always fail.
    const { SidecarUnreachableError } = await import("../../lib/stealth-sidecar/errors.js");
    const sidecarError = new SidecarUnreachableError("sidecar unreachable: https://example.com");
    vi.doMock("../../scraper/index.js", () => ({
      scrapeWithinRadius: vi.fn(async () => {
        throw sidecarError;
      }),
    }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(finishMock).toHaveBeenCalled();
    });

    const [message, failed] = finishMock.mock.calls[0]!;
    expect(message).toContain("sidecar error:");
    expect(message).toContain("sidecar unreachable: https://example.com");
    expect(failed).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("sidecar error:"));
  });

  it("does NOT add the sidecar prefix for a plain generic Error from the scrape failure", async () => {
    vi.doMock("../../scraper/index.js", () => ({
      scrapeWithinRadius: vi.fn(async () => {
        throw new Error("some other scrape failure");
      }),
    }));

    await import("../index.js");

    await vi.waitFor(() => {
      expect(finishMock).toHaveBeenCalled();
    });

    const [message, failed] = finishMock.mock.calls[0]!;
    expect(message).toBe("some other scrape failure");
    expect(message).not.toContain("sidecar error:");
    expect(failed).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith("some other scrape failure");
  });
});
