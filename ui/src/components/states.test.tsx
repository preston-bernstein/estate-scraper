import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LoadingState, ErrorState } from "./states";

describe("LoadingState", () => {
  it("exposes a status role and the default label", () => {
    render(<LoadingState />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders a custom label", () => {
    render(<LoadingState label="Fetching sales…" />);
    expect(screen.getByText("Fetching sales…")).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("shows the message under an alert role", () => {
    render(<ErrorState message="Boom" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });

  it("hides the retry button when no handler is given", () => {
    render(<ErrorState message="Boom" />);
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("calls onRetry when the button is clicked", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Boom" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
