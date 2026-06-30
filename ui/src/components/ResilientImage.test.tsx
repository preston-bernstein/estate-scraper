import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResilientImage } from "./ResilientImage";

describe("ResilientImage", () => {
  it("renders the first usable source", () => {
    render(<ResilientImage srcs={["/thumbs/1", "https://cdn/x.jpg"]} alt="a chair" />);
    const img = screen.getByAltText("a chair") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/thumbs/1");
  });

  it("skips null/undefined sources", () => {
    render(<ResilientImage srcs={[null, undefined, "https://cdn/x.jpg"]} alt="x" />);
    expect((screen.getByAltText("x") as HTMLImageElement).getAttribute("src")).toBe("https://cdn/x.jpg");
  });

  it("advances to the next source on error, then shows a placeholder", () => {
    render(<ResilientImage srcs={["/thumbs/1", "https://cdn/x.jpg"]} alt="lamp" />);
    const img = screen.getByAltText("lamp");
    expect(img.getAttribute("src")).toBe("/thumbs/1");

    fireEvent.error(img); // thumbnail 404 → fall back to CDN
    expect(screen.getByAltText("lamp").getAttribute("src")).toBe("https://cdn/x.jpg");

    fireEvent.error(screen.getByAltText("lamp")); // CDN dead too → placeholder
    const placeholder = screen.getByRole("img", { name: "lamp" });
    expect(placeholder).toHaveTextContent("No image");
  });

  it("shows the placeholder when no sources are provided", () => {
    render(<ResilientImage srcs={[null, undefined]} alt="empty" />);
    expect(screen.getByRole("img", { name: "empty" })).toHaveTextContent("No image");
  });
});
