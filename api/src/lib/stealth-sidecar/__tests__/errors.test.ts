import { describe, expect, it } from "vitest";
import {
  SidecarError,
  SidecarResponseError,
  SidecarUnreachableError,
} from "../errors.js";

describe("SidecarError", () => {
  it("sets name, message, and type from constructor args", () => {
    const err = new SidecarError("msg", "unreachable");

    expect(err.name).toBe("SidecarError");
    expect(err.message).toBe("msg");
    expect(err.type).toBe("unreachable");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("SidecarUnreachableError", () => {
  it("sets name, type, and message; leaves cause undefined when not passed", () => {
    const err = new SidecarUnreachableError("msg");

    expect(err.name).toBe("SidecarUnreachableError");
    expect(err.type).toBe("unreachable");
    expect(err.message).toBe("msg");
    expect(err).toBeInstanceOf(SidecarError);
    expect(err.cause).toBeUndefined();
  });

  it("passes through the exact cause reference when provided", () => {
    const causeError = new Error("root cause");

    const err = new SidecarUnreachableError("msg", causeError);

    expect(err.cause).toBe(causeError);
  });
});

describe("SidecarResponseError", () => {
  it("sets name, type, status, errorType, and message from constructor args", () => {
    const err = new SidecarResponseError(404, "not_found", "msg");

    expect(err.name).toBe("SidecarResponseError");
    expect(err.type).toBe("response");
    expect(err.status).toBe(404);
    expect(err.errorType).toBe("not_found");
    expect(err.message).toBe("msg");
    expect(err).toBeInstanceOf(SidecarError);
  });
});
