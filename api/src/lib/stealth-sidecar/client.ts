/**
 * Low-level HTTP wrapper around the stealth-sidecar (scraper-commons)
 * browser-automation service. Each exported function is a thin mapping onto
 * one sidecar route — no scraper-specific logic lives here; callers own
 * their own logging (raw HTML / full URLs with query params must never be
 * logged, but that's a caller concern — this module does no logging at
 * all).
 *
 * Base URL resolution: `STEALTH_SIDECAR_URL` env var, defaulting to
 * `http://127.0.0.1:8000` (the sidecar's local default). The sidecar is
 * assumed reachable only on localhost or a private network — see
 * `isLoopbackOrPrivateHost` below.
 *
 * No retry: a single connect-level failure or client-side timeout throws
 * `SidecarUnreachableError` immediately. Estate-scraper's sidecar runs one
 * in-flight worker slot locally; blindly retrying a request that may have
 * already partially executed (started a navigation, etc.) risks
 * double-navigating or leaking a context, so callers are expected to own
 * any higher-level retry/backoff policy themselves.
 */
import { SidecarResponseError, SidecarUnreachableError } from "./errors.js";

/** Default sidecar base URL when STEALTH_SIDECAR_URL is unset. */
const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8000";

/**
 * The sidecar's own configured operation timeout default (`op_timeout_ms`).
 * Used as the client-side fetch timeout for calls that don't send their own
 * `timeout_ms` (context/page create, deletes) and as the fallback when a
 * caller omits `timeoutMs` on `navigate`/`getContent`.
 */
const DEFAULT_OP_TIMEOUT_MS = 30_000;

/**
 * Safe ceiling for a caller-requested `navigate` timeout. Must stay below
 * the sidecar's configured `op_timeout_ms` (default 30_000ms) — sending
 * `timeout_ms` at or above that gets a 422 `invalid_timeout`. We cap well
 * below the default (rather than matching it exactly) since a deployment
 * could configure a lower `op_timeout_ms` than the default.
 */
const MAX_NAVIGATE_TIMEOUT_MS = 25_000;

/**
 * Headroom added on top of whatever `timeout_ms` we send the sidecar for
 * `navigate`, so the sidecar's own operation_timeout response has a chance
 * to arrive before our client-side abort fires first.
 */
const TIMEOUT_HEADROOM_MS = 5_000;

/**
 * True when `hostname` is loopback or within a private (RFC1918) IPv4
 * range. The client assumes localhost/private-network reachability only —
 * a deliberately simple string/prefix check, not full CIDR matching (no
 * extra dependency for this).
 */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // Node's URL always brackets an IPv6 hostname (`new URL("http://[::1]:8000").hostname`
  // is `"[::1]"`, never bare `"::1"`) — match the bracketed form so this branch is
  // actually reachable rather than silently dead code.
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;

  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = parts.map(Number);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
  }
  return false;
}

/**
 * Resolve the sidecar base URL from the environment (read fresh each call).
 * Throws if `STEALTH_SIDECAR_URL` is malformed or doesn't resolve to a
 * loopback/private-network host — the client has no support for reaching a
 * public-internet sidecar.
 */
export function getSidecarBaseUrl(): string {
  const raw = process.env.STEALTH_SIDECAR_URL || DEFAULT_SIDECAR_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`STEALTH_SIDECAR_URL is not a valid URL: ${raw}`);
  }
  if (!isLoopbackOrPrivateHost(parsed.hostname)) {
    throw new Error(
      `STEALTH_SIDECAR_URL (${raw}) must resolve to a loopback or private-network ` +
        `address (localhost, 127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, or 192.168.0.0/16) — ` +
        `got hostname "${parsed.hostname}".`,
    );
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Single-attempt fetch with a client-side timeout via `AbortSignal.timeout`.
 * No retry: a connect-level failure (`fetch()` itself rejects — e.g.
 * ECONNREFUSED/ECONNRESET/ENOTFOUND) or a timeout firing first both throw
 * immediately.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (isAbortError(err)) {
      throw new SidecarUnreachableError(
        `sidecar request timed out after ${timeoutMs}ms: ${url}`,
        err,
      );
    }
    throw new SidecarUnreachableError(`sidecar unreachable: ${url}`, err);
  }
}

/** Parse the sidecar's `{ error: { type, message } }` envelope off a non-2xx response. */
async function parseErrorEnvelope(response: Response): Promise<SidecarResponseError> {
  let type = "internal_error";
  let message = `sidecar returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  try {
    const body = (await response.json()) as { error?: { type?: string; message?: string } };
    if (body?.error?.type) type = body.error.type;
    if (body?.error?.message) message = body.error.message;
  } catch {
    // Non-JSON or empty error body — fall back to the generic status-based message.
  }
  return new SidecarResponseError(response.status, type, message);
}

/**
 * Issue a sidecar request (single attempt, no retry — see module docs) and
 * throw `SidecarResponseError` on any non-2xx response. Returns both the
 * raw `Response` and the parsed JSON body.
 */
async function sidecarRequest<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: T }> {
  const url = `${getSidecarBaseUrl()}${path}`;
  const response = await fetchWithTimeout(url, init, timeoutMs);
  if (!response.ok) {
    throw await parseErrorEnvelope(response);
  }
  const body = (await response.json()) as T;
  return { response, body };
}

/**
 * Best-effort cleanup delete: treats 404 (already gone) as success rather
 * than throwing. Any other non-2xx status still throws, so a caller that
 * cares can observe a genuinely failed cleanup.
 */
async function bestEffortDelete(path: string): Promise<void> {
  const url = `${getSidecarBaseUrl()}${path}`;
  const response = await fetchWithTimeout(url, { method: "DELETE" }, DEFAULT_OP_TIMEOUT_MS);
  if (response.ok || response.status === 404) return;
  throw await parseErrorEnvelope(response);
}

export interface SidecarContext {
  contextId: string;
}

/**
 * `POST /v1/contexts` with an empty JSON body — estate-scraper needs no
 * per-account profile/userDataDir option (no login required for
 * estatesales.net), so this always creates a fresh anonymous context.
 */
export async function createContext(): Promise<SidecarContext> {
  const { body } = await sidecarRequest<{ context_id: string }>(
    "/v1/contexts",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    DEFAULT_OP_TIMEOUT_MS,
  );
  return { contextId: body.context_id };
}

export interface SidecarPage {
  pageId: string;
}

/** `POST /v1/contexts/{contextId}/pages` — 404 surfaces as `SidecarResponseError` errorType `"not_found"`. */
export async function createPage(contextId: string): Promise<SidecarPage> {
  const { body } = await sidecarRequest<{ page_id: string }>(
    `/v1/contexts/${encodeURIComponent(contextId)}/pages`,
    { method: "POST" },
    DEFAULT_OP_TIMEOUT_MS,
  );
  return { pageId: body.page_id };
}

export interface NavigateResult {
  status: number;
  url: string;
}

/**
 * `POST /v1/pages/{pageId}/navigate` with JSON body `{ url, timeout_ms? }`.
 * Returns the sidecar-reported target-site HTTP status and final URL, so
 * callers can decide null-vs-continue vs throw off the actual navigation
 * result rather than just success/failure of the sidecar call itself.
 *
 * `timeoutMs`, if passed, is capped at `MAX_NAVIGATE_TIMEOUT_MS` (25s) —
 * safely below the sidecar's default `op_timeout_ms` (30s) — rather than
 * forwarded as-is, since the sidecar 422s with `invalid_timeout` when
 * `timeout_ms` meets or exceeds its configured limit. Omitting `timeoutMs`
 * entirely omits `timeout_ms` from the request body, letting the sidecar
 * use its own default. Our own client-side fetch timeout (separate from
 * the sidecar's `timeout_ms`) is that capped value plus `TIMEOUT_HEADROOM_MS`,
 * giving the sidecar's own operation-timeout response a chance to arrive
 * first.
 */
export async function navigate(
  pageId: string,
  url: string,
  timeoutMs?: number,
): Promise<NavigateResult> {
  const cappedTimeoutMs =
    timeoutMs === undefined ? undefined : Math.min(timeoutMs, MAX_NAVIGATE_TIMEOUT_MS);

  const requestBody: { url: string; timeout_ms?: number } = { url };
  if (cappedTimeoutMs !== undefined) requestBody.timeout_ms = cappedTimeoutMs;

  const clientTimeoutMs = (cappedTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS) + TIMEOUT_HEADROOM_MS;

  const { body } = await sidecarRequest<{ status: number; url: string }>(
    `/v1/pages/${encodeURIComponent(pageId)}/navigate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
    clientTimeoutMs,
  );
  return { status: body.status, url: body.url };
}

/**
 * `GET /v1/pages/{pageId}/content` — returns the page's raw HTML.
 *
 * `timeoutMs`, if omitted, falls back to `DEFAULT_OP_TIMEOUT_MS` (30s,
 * matching the sidecar's own configured `op_timeout_ms` default). Unlike
 * `navigate`, this is a GET with no `timeout_ms` request field to cap —
 * `timeoutMs` here only governs our own client-side fetch timeout.
 *
 * ASSUMPTION: the response envelope is `{ content: string }` — flagged for
 * confirmation against the live sidecar during integration validation.
 */
export async function getContent(pageId: string, timeoutMs?: number): Promise<string> {
  const { body } = await sidecarRequest<{ content: string }>(
    `/v1/pages/${encodeURIComponent(pageId)}/content`,
    { method: "GET" },
    timeoutMs ?? DEFAULT_OP_TIMEOUT_MS,
  );
  return body.content;
}

/** `DELETE /v1/pages/{pageId}` — best-effort; 404 (already gone) is not an error. */
export async function closePage(pageId: string): Promise<void> {
  await bestEffortDelete(`/v1/pages/${encodeURIComponent(pageId)}`);
}

/** `DELETE /v1/contexts/{contextId}` — best-effort; 404 (already gone) is not an error. */
export async function closeContext(contextId: string): Promise<void> {
  await bestEffortDelete(`/v1/contexts/${encodeURIComponent(contextId)}`);
}
