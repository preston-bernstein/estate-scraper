import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary, friendlyMessage } from "./ErrorBoundary";

// A child that throws on first render, then (after reset) renders fine.
function Boom({ throwError }: { throwError: { current: boolean } }) {
  if (throwError.current) throw new Error("Unauthorized");
  return <div>recovered content</div>;
}

describe("friendlyMessage", () => {
  it("maps Unauthorized to a sign-in nudge", () => {
    expect(friendlyMessage(new Error("Unauthorized"))).toMatch(/session expired/i);
  });
  it("falls back to a generic load message", () => {
    expect(friendlyMessage(new Error("ECONNREFUSED"))).toMatch(/couldn't load/i);
  });
});

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div>all good</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("shows the fallback error UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom throwError={{ current: true }} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it("recovers when retry is clicked after the cause is resolved", () => {
    const flag = { current: true };
    render(
      <ErrorBoundary>
        <Boom throwError={flag} />
      </ErrorBoundary>,
    );
    flag.current = false; // the underlying issue is now fixed
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("recovered content")).toBeInTheDocument();
  });

  it("uses a custom fallback when provided", () => {
    render(
      <ErrorBoundary fallback={() => <span>quiet fallback</span>}>
        <Boom throwError={{ current: true }} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("quiet fallback")).toBeInTheDocument();
  });
});
