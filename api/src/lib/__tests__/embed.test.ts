import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBED_SEARCH_TIMEOUT_MS,
  blobToFloat32,
  embedImages,
  embeddingEnabled,
  float32ToBlob,
  parseEmbedResponse,
} from "../embed.js";

describe("EMBED_SEARCH_TIMEOUT_MS", () => {
  it("defaults to a short (3s) budget distinct from the 120s batch timeout", () => {
    expect(EMBED_SEARCH_TIMEOUT_MS).toBe(3000);
  });
});

describe("float32 blob round-trip", () => {
  it("preserves values through encode/decode", () => {
    const vec = [0, 1, -1, 0.5, -0.25, 3.14159, 1e-6, 1e6];
    const out = blobToFloat32(float32ToBlob(vec));
    expect(out).toHaveLength(vec.length);
    for (let i = 0; i < vec.length; i++) {
      expect(out[i]).toBeCloseTo(vec[i]!, 3);
    }
  });

  it("encodes 4 bytes per element", () => {
    expect(float32ToBlob([1, 2, 3]).length).toBe(12);
  });
});

describe("parseEmbedResponse", () => {
  it("returns vectors ordered by index", () => {
    const payload = {
      data: [
        { index: 1, embedding: [4, 5, 6] },
        { index: 0, embedding: [1, 2, 3] },
      ],
    };
    expect(parseEmbedResponse(payload, 2)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("fills missing entries with null", () => {
    const payload = { data: [{ index: 0, embedding: [1, 2, 3] }] };
    expect(parseEmbedResponse(payload, 3)).toEqual([[1, 2, 3], null, null]);
  });

  it("handles an empty / malformed payload", () => {
    expect(parseEmbedResponse({}, 2)).toEqual([null, null]);
  });

  it("falls back to array position when index is absent", () => {
    const payload = { data: [{ embedding: [1] }, { embedding: [2] }] };
    expect(parseEmbedResponse(payload, 2)).toEqual([[1], [2]]);
  });

  describe("frozen-model dimension guard (ADR 0016)", () => {
    it("rejects a vector of the wrong dimension", () => {
      const payload = {
        data: [
          { index: 0, embedding: [1, 2, 3] }, // wrong dim
          { index: 1, embedding: [1, 2, 3, 4] }, // matches
        ],
      };
      expect(parseEmbedResponse(payload, 2, 4)).toEqual([null, [1, 2, 3, 4]]);
    });

    it("accepts any dimension when no guard is set", () => {
      const payload = { data: [{ index: 0, embedding: [1, 2, 3] }] };
      expect(parseEmbedResponse(payload, 1, null)).toEqual([[1, 2, 3]]);
    });
  });

  it("skips entries whose index is out of range", () => {
    const payload = {
      data: [
        { index: -1, embedding: [9] },
        { index: 2, embedding: [9] },
        { index: 0, embedding: [1] },
      ],
    };
    expect(parseEmbedResponse(payload, 2)).toEqual([[1], null]);
  });

  it("skips entries missing an embedding", () => {
    const payload = { data: [{ index: 0 }, { index: 1, embedding: [7] }] };
    expect(parseEmbedResponse(payload, 2)).toEqual([null, [7]]);
  });
});

describe("embeddingEnabled", () => {
  it("is false when EMBED_API_BASE is unset", () => {
    expect(embeddingEnabled()).toBe(false);
  });
});

describe("embedImages", () => {
  const buf = (n: number) => Buffer.from([n]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockEmbeddings(vectors: number[][]) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: vectors.map((embedding, index) => ({ embedding, index })),
      }),
    } as Response);
  }

  it("returns one vector per input image, preserving order", async () => {
    mockEmbeddings([
      [1, 2],
      [3, 4],
    ]);
    expect(await embedImages([buf(1), buf(2)])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("POSTs base64 jpeg data-uris to the /embeddings endpoint", async () => {
    const spy = mockEmbeddings([[0]]);
    await embedImages([buf(65)]);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain("/embeddings");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.input[0]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("fails open with nulls on a non-ok HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 503 } as Response);
    expect(await embedImages([buf(1), buf(2)])).toEqual([null, null]);
  });

  it("fails open with nulls when the request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await embedImages([buf(1)])).toEqual([null]);
  });

  it("makes no request and returns [] for an empty input", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await embedImages([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("embedImages batching", () => {
  const buf = (n: number) => Buffer.from([n]);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("splits inputs into EMBED_BATCH-sized requests", async () => {
    vi.stubEnv("EMBED_BATCH", "2");
    vi.resetModules();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        const n = body.input.length as number;
        return {
          ok: true,
          json: async () => ({
            data: Array.from({ length: n }, (_v, i) => ({ embedding: [i], index: i })),
          }),
        } as Response;
      });
    const { embedImages: freshEmbedImages } = await import("../embed.js");
    const out = await freshEmbedImages([buf(1), buf(2), buf(3), buf(4), buf(5)]);
    expect(out).toHaveLength(5);
    // 5 inputs at batch size 2 → 3 requests.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("embedQueryText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshEmbedQueryText() {
    vi.stubEnv("EMBED_API_BASE", "http://embed.test");
    vi.stubEnv("EMBED_MODEL", "siglip-so400m-patch14-384");
    vi.resetModules();
    return (await import("../embed.js")).embedQueryText;
  }

  it("returns null when embedding is disabled (no EMBED_API_BASE)", async () => {
    vi.resetModules();
    const { embedQueryText } = await import("../embed.js");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await embedQueryText("couch")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns the query vector on a well-formed response", async () => {
    const embedQueryText = await freshEmbedQueryText();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    } as Response);
    expect(await embedQueryText("couch")).toEqual([1, 2, 3]);
  });

  it("discards a wrong-dimension response and returns null (AC8)", async () => {
    vi.stubEnv("EMBED_DIM", "4");
    const embedQueryText = await freshEmbedQueryText();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }), // dim 3 != 4
    } as Response);
    expect(await embedQueryText("couch")).toBeNull();
  });

  it("returns null within the fallback budget when the request times out (AC5 building block)", async () => {
    vi.stubEnv("EMBED_SEARCH_TIMEOUT_MS", "30");
    const embedQueryText = await freshEmbedQueryText();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const start = Date.now();
    const result = await embedQueryText("a query that will time out");
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000); // well within the fallback budget
  });

  it("returns null on a non-ok HTTP response", async () => {
    const embedQueryText = await freshEmbedQueryText();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 } as Response);
    expect(await embedQueryText("couch")).toBeNull();
  });

  it("truncates over-length input to the 200-char cap before sending", async () => {
    const embedQueryText = await freshEmbedQueryText();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1] }] }),
    } as Response);
    const longQuery = "x".repeat(500);
    await embedQueryText(longQuery);
    const [, init] = spy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect((body.input as string).length).toBe(200);
  });

  it("never logs the raw query text on any outcome", async () => {
    const embedQueryText = await freshEmbedQueryText();
    const marker = "SUPER-SECRET-QUERY-MARKER";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 } as Response);
    await embedQueryText(marker);
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(marker);
      }
    }
  });
});
