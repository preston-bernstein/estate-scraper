import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../client.js";
import { SidecarResponseError, SidecarUnreachableError } from "../errors.js";

/**
 * Mirrors client.ts's own internal constants (not exported) so tests assert
 * against the real values rather than inventing their own. Keep in sync with
 * client.ts if they ever change.
 */
const MAX_NAVIGATE_TIMEOUT_MS = 25_000;

const BASE_URL = "http://192.168.1.50:8000";
const ORIGINAL_SIDECAR_URL = process.env.STEALTH_SIDECAR_URL;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

describe("stealth-sidecar client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.STEALTH_SIDECAR_URL = BASE_URL;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (ORIGINAL_SIDECAR_URL === undefined) {
      delete process.env.STEALTH_SIDECAR_URL;
    } else {
      process.env.STEALTH_SIDECAR_URL = ORIGINAL_SIDECAR_URL;
    }
  });

  describe("getSidecarBaseUrl", () => {
    it("reads STEALTH_SIDECAR_URL from the environment", () => {
      expect(client.getSidecarBaseUrl()).toBe(BASE_URL);
    });

    it("falls back to the local default when unset", () => {
      delete process.env.STEALTH_SIDECAR_URL;
      expect(client.getSidecarBaseUrl()).toBe("http://127.0.0.1:8000");
    });

    it("strips a trailing slash", () => {
      process.env.STEALTH_SIDECAR_URL = `${BASE_URL}/`;
      expect(client.getSidecarBaseUrl()).toBe(BASE_URL);
    });

    it("throws a plain Error (not a SidecarError) when the host is not loopback/private", () => {
      process.env.STEALTH_SIDECAR_URL = "http://example.com:8000";
      expect(() => client.getSidecarBaseUrl()).toThrow(Error);
      try {
        client.getSidecarBaseUrl();
        expect.unreachable("expected getSidecarBaseUrl to throw");
      } catch (err) {
        expect(err).not.toBeInstanceOf(SidecarUnreachableError);
        expect(err).not.toBeInstanceOf(SidecarResponseError);
        expect((err as Error).message).toContain("example.com");
      }
    });
  });

  describe("isLoopbackOrPrivateHost boundaries (via getSidecarBaseUrl)", () => {
    function expectAccepted(host: string) {
      process.env.STEALTH_SIDECAR_URL = `http://${host}:8000`;
      expect(() => client.getSidecarBaseUrl()).not.toThrow();
    }

    function expectRejected(host: string) {
      process.env.STEALTH_SIDECAR_URL = `http://${host}:8000`;
      expect(() => client.getSidecarBaseUrl()).toThrow();
    }

    it("accepts 127.0.0.1 (loopback)", () => {
      expectAccepted("127.0.0.1");
    });

    it("accepts another 127.x.x.x address (127.1.2.3)", () => {
      expectAccepted("127.1.2.3");
    });

    it("accepts 10.0.0.1 (10.0.0.0/8)", () => {
      expectAccepted("10.0.0.1");
    });

    it("rejects 11.0.0.1 (just outside 10.0.0.0/8)", () => {
      expectRejected("11.0.0.1");
    });

    it("accepts 172.16.0.1 (lower bound of 172.16.0.0/12)", () => {
      expectAccepted("172.16.0.1");
    });

    it("accepts 172.31.255.255 (upper bound of 172.16.0.0/12)", () => {
      expectAccepted("172.31.255.255");
    });

    it("rejects 172.15.255.255 (just below the 172.16.0.0/12 range)", () => {
      expectRejected("172.15.255.255");
    });

    it("rejects 172.32.0.1 (just above the 172.16.0.0/12 range)", () => {
      expectRejected("172.32.0.1");
    });

    it("accepts 192.168.0.1 (192.168.0.0/16)", () => {
      expectAccepted("192.168.0.1");
    });

    it("rejects 192.167.0.1 (second octet not 168)", () => {
      expectRejected("192.167.0.1");
    });

    it("rejects 191.168.0.1 (first octet not 192)", () => {
      expectRejected("191.168.0.1");
    });

    it("accepts localhost", () => {
      process.env.STEALTH_SIDECAR_URL = "http://localhost:8000";
      expect(() => client.getSidecarBaseUrl()).not.toThrow();
    });

    it("accepts the IPv6 loopback address (Node's URL always brackets it as [::1])", () => {
      process.env.STEALTH_SIDECAR_URL = "http://[::1]:8000";
      expect(() => client.getSidecarBaseUrl()).not.toThrow();
    });

    it("rejects a clearly public address (8.8.8.8) and names the offending hostname in the error", () => {
      process.env.STEALTH_SIDECAR_URL = "http://8.8.8.8:8000";
      try {
        client.getSidecarBaseUrl();
        expect.unreachable("expected getSidecarBaseUrl to throw");
      } catch (err) {
        expect((err as Error).message).toContain("8.8.8.8");
      }
    });
  });

  describe("createContext", () => {
    it("posts an empty JSON body and returns contextId", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { context_id: "ctx-1" }));

      const result = await client.createContext();

      expect(result).toEqual({ contextId: "ctx-1" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/v1/contexts`);
      expect(init).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(JSON.parse(init.body)).toEqual({});
    });
  });

  describe("createPage", () => {
    it("posts to /v1/contexts/{contextId}/pages and returns pageId", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { page_id: "page-1" }));

      const result = await client.createPage("ctx-1");

      expect(result).toEqual({ pageId: "page-1" });
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/v1/contexts/ctx-1/pages`,
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("URL-encodes the contextId when interpolated into the path", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { page_id: "page-1" }));

      await client.createPage("ctx/with spaces");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/v1/contexts/${encodeURIComponent("ctx/with spaces")}/pages`);
    });
  });

  describe("navigate", () => {
    it("posts { url, timeout_ms } and returns { status, url } from the sidecar body", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { status: 200, url: "https://example.com/final" }));

      const result = await client.navigate("page-1", "https://example.com/item", 5000);

      expect(result).toEqual({ status: 200, url: "https://example.com/final" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/v1/pages/page-1/navigate`);
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
      expect(JSON.parse(init.body)).toEqual({ url: "https://example.com/item", timeout_ms: 5000 });
    });

    it("omits timeout_ms from the body when no timeout is passed", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { status: 200, url: "https://example.com/item" }));

      await client.navigate("page-1", "https://example.com/item");

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ url: "https://example.com/item" });
    });

    it("caps a caller-requested timeout above the sidecar's limit at MAX_NAVIGATE_TIMEOUT_MS (25000), avoiding the sidecar's 422 invalid_timeout", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { status: 200, url: "https://example.com/item" }));

      await client.navigate("page-1", "https://example.com/item", 60_000);

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.timeout_ms).toBe(MAX_NAVIGATE_TIMEOUT_MS);
      expect(body.timeout_ms).not.toBe(60_000);
    });

    it("passes a caller timeout through unchanged when it's already under the cap", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { status: 200, url: "https://example.com/item" }));

      await client.navigate("page-1", "https://example.com/item", 10_000);

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body).timeout_ms).toBe(10_000);
    });

    it("URL-encodes the pageId when interpolated into the path", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { status: 200, url: "https://example.com" }));

      await client.navigate("page/with spaces", "https://example.com");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/v1/pages/${encodeURIComponent("page/with spaces")}/navigate`);
    });
  });

  describe("getContent", () => {
    it("GETs /v1/pages/{pageId}/content and returns the content string", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { content: "<html>ok</html>" }));

      const content = await client.getContent("page-1");

      expect(content).toBe("<html>ok</html>");
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/v1/pages/page-1/content`,
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("closePage / closeContext", () => {
    it("closePage DELETEs /v1/pages/{pageId}", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));

      await expect(client.closePage("page-1")).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/v1/pages/page-1`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("closeContext DELETEs /v1/contexts/{contextId}", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));

      await expect(client.closeContext("ctx-1")).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/v1/contexts/ctx-1`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("closePage treats a 404 as success (already gone), not an error", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, { error: { type: "not_found", message: "page not found" } }),
      );

      await expect(client.closePage("gone-page")).resolves.toBeUndefined();
    });

    it("closeContext treats a 404 as success (already gone), not an error", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, { error: { type: "not_found", message: "context not found" } }),
      );

      await expect(client.closeContext("gone-ctx")).resolves.toBeUndefined();
    });

    it("closePage still throws for a non-404 non-2xx status", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(500, { error: { type: "internal_error", message: "cleanup failed" } }),
      );

      const err = await client.closePage("page-1").catch((e) => e);

      expect(err).toBeInstanceOf(SidecarResponseError);
      expect((err as SidecarResponseError).status).toBe(500);
      expect((err as SidecarResponseError).errorType).toBe("internal_error");
    });
  });

  describe("non-2xx response -> SidecarResponseError", () => {
    it("maps a 422 invalid_timeout envelope to SidecarResponseError with matching status/errorType/message", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(422, { error: { type: "invalid_timeout", message: "timeout_ms too large" } }),
      );

      const err = await client
        .navigate("page-1", "https://example.com/item", 1000)
        .catch((e) => e);

      expect(err).toBeInstanceOf(SidecarResponseError);
      expect((err as SidecarResponseError).status).toBe(422);
      expect((err as SidecarResponseError).errorType).toBe("invalid_timeout");
      expect((err as SidecarResponseError).message).toBe("timeout_ms too large");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("maps a 404 not_found envelope to SidecarResponseError with matching status/errorType/message", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, { error: { type: "not_found", message: "context not found" } }),
      );

      const err = await client.createPage("missing-ctx").catch((e) => e);

      expect(err).toBeInstanceOf(SidecarResponseError);
      expect((err as SidecarResponseError).status).toBe(404);
      expect((err as SidecarResponseError).errorType).toBe("not_found");
      expect((err as SidecarResponseError).message).toBe("context not found");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to a generic status-based message when the error body isn't JSON", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response);

      const err = await client.createContext().catch((e) => e);

      expect(err).toBeInstanceOf(SidecarResponseError);
      expect((err as SidecarResponseError).status).toBe(500);
      expect((err as SidecarResponseError).errorType).toBe("internal_error");
      expect((err as SidecarResponseError).message).toBe(
        "sidecar returned HTTP 500 Internal Server Error",
      );
    });

    it("falls back to a generic status-based message when the error body is empty", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "",
        json: async () => undefined,
      } as unknown as Response);

      const err = await client.createContext().catch((e) => e);

      expect(err).toBeInstanceOf(SidecarResponseError);
      expect((err as SidecarResponseError).status).toBe(503);
      expect((err as SidecarResponseError).errorType).toBe("internal_error");
      expect((err as SidecarResponseError).message).toBe("sidecar returned HTTP 503");
    });

    it("falls back to errorType internal_error when the envelope's error.type field is missing", async () => {
      fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: "custom message only" } }));

      const err = await client.createContext().catch((e) => e);

      expect(err).toBeInstanceOf(SidecarResponseError);
      expect((err as SidecarResponseError).status).toBe(500);
      expect((err as SidecarResponseError).errorType).toBe("internal_error");
      // message IS present on the body, so it should still be taken from there.
      expect((err as SidecarResponseError).message).toBe("custom message only");
    });

    it("falls back to the generic HTTP-status message when the envelope's error.message field is missing", async () => {
      fetchMock.mockResolvedValue(jsonResponse(500, { error: { type: "custom_type" } }));

      const err = await client.createContext().catch((e) => e);

      expect(err).toBeInstanceOf(SidecarResponseError);
      expect((err as SidecarResponseError).status).toBe(500);
      // type IS present on the body, so it should still be taken from there.
      expect((err as SidecarResponseError).errorType).toBe("custom_type");
      expect((err as SidecarResponseError).message).toBe("sidecar returned HTTP 500");
    });
  });

  describe("connect-level failure -> SidecarUnreachableError (no retry)", () => {
    it("createContext throws SidecarUnreachableError on the first fetch rejection, with no retry", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED"));

      const err = await client.createContext().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SidecarUnreachableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("navigate throws SidecarUnreachableError on the first fetch rejection, with no retry", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNRESET"));

      const err = await client
        .navigate("page-1", "https://example.com/item")
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SidecarUnreachableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("client-side abort/timeout -> SidecarUnreachableError (no retry)", () => {
    it("throws SidecarUnreachableError when fetch rejects with an AbortError (our own timeout firing), with no retry", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      fetchMock.mockRejectedValue(abortError);

      const err = await client.getContent("page-1").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SidecarUnreachableError);
      expect((err as SidecarUnreachableError).message).toContain("timed out");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("passes an AbortSignal with a deadline to fetch so a real timeout would fire", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { content: "ok" }));

      await client.getContent("page-1");

      const [, init] = fetchMock.mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("falls back to the generic unreachable message (not the timeout message) when fetch rejects with a plain non-Error value", async () => {
      fetchMock.mockRejectedValue("connection refused");

      const err = await client.getContent("page-1").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SidecarUnreachableError);
      expect((err as SidecarUnreachableError).message).toBe(
        `sidecar unreachable: ${BASE_URL}/v1/pages/page-1/content`,
      );
      expect((err as SidecarUnreachableError).message).not.toContain("timed out");
    });

    it("falls back to the generic unreachable message (not the timeout message) when fetch rejects with an Error whose name is not AbortError", async () => {
      fetchMock.mockRejectedValue(new Error("connection refused"));

      const err = await client.getContent("page-1").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SidecarUnreachableError);
      expect((err as SidecarUnreachableError).message).toBe(
        `sidecar unreachable: ${BASE_URL}/v1/pages/page-1/content`,
      );
      expect((err as SidecarUnreachableError).message).not.toContain("timed out");
    });
  });
});
