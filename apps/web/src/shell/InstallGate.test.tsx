import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InstallGate } from "./InstallGate";

describe("InstallGate", () => {
  it("offers the real OAuth install link when a shop is known", () => {
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, search: "?shop=moradabad-gems.myshopify.com" },
    });
    render(<InstallGate />);
    const link = screen.getByRole("link", { name: /install for moradabad-gems\.myshopify\.com/i });
    expect(link).toHaveAttribute("href", "/shopify/install?shop=moradabad-gems.myshopify.com");
    expect(link).toHaveAttribute("target", "_top");
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });

  it("explains how to start without a shop — never a fake login", () => {
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, search: "" },
    });
    render(<InstallGate />);
    expect(screen.getByText(/Apps → PROFIT TOOL AI/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /log ?in/i })).not.toBeInTheDocument();
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });
});
