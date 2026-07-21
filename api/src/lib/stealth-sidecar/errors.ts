/**
 * Error types for the stealth-sidecar HTTP client.
 *
 * Distinct from parsing/scraping failures: these represent failures to talk to
 * the sidecar process itself (connection-level or sidecar-reported HTTP errors),
 * not failures to parse a scraped page. Call sites can branch on the whole family
 * with `err instanceof SidecarError`.
 */

/** High-level discriminator for the two SidecarError subclasses. */
export type SidecarErrorKind = "unreachable" | "response";

export class SidecarError extends Error {
  constructor(
    message: string,
    readonly type: SidecarErrorKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SidecarError";
  }
}

export class SidecarUnreachableError extends SidecarError {
  constructor(message: string, cause?: unknown) {
    super(message, "unreachable", cause === undefined ? undefined : { cause });
    this.name = "SidecarUnreachableError";
  }
}

export class SidecarResponseError extends SidecarError {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(message, "response");
    this.name = "SidecarResponseError";
  }
}
