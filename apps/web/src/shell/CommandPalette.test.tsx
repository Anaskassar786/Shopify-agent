import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderHook, act } from "@testing-library/react";
import { buildPaletteItems, CommandPalette, useDebouncedValue } from "./CommandPalette";
import { APP_SECTIONS, visibleSections } from "./sections";
import { renderApp, OWNER_PERMISSIONS } from "../test-support/render";
import { searchResponse } from "../test-support/fixtures";

const hasAll = (p: string): boolean => (OWNER_PERMISSIONS as readonly string[]).includes(p);
const SECTIONS = visibleSections(hasAll);

describe("buildPaletteItems (pure core)", () => {
  const actions = {
    navigate: vi.fn(),
    triggerFullSync: vi.fn(),
    markAllRead: vi.fn(),
  };

  it("lists permitted sections first, filtered by query", () => {
    const items = buildPaletteItems({
      query: "",
      sections: SECTIONS,
      canSyncAll: true,
      canMarkAllRead: true,
      actions,
      search: undefined,
    });
    expect(items.filter((i) => i.group === "Go to")).toHaveLength(SECTIONS.length);
    expect(items[0]?.label).toBe("Dashboard");

    const filtered = buildPaletteItems({ query: "orders", sections: SECTIONS, canSyncAll: true, canMarkAllRead: true, actions, search: undefined });
    const labels = filtered.map((i) => i.label);
    expect(labels).toContain("Orders");
    expect(labels).not.toContain("Products");
  });

  it("marks roadmap sections with their milestone hint", () => {
    const items = buildPaletteItems({ query: "", sections: SECTIONS, canSyncAll: false, canMarkAllRead: false, actions, search: undefined });
    const ai = items.find((i) => i.label === "AI Command Center");
    expect(ai?.hint).toBe("arrives in M4");
  });

  it("gates actions behind their permissions", () => {
    const both = buildPaletteItems({ query: "", sections: [], canSyncAll: true, canMarkAllRead: true, actions, search: undefined });
    expect(both.map((i) => i.label)).toEqual(["Trigger full data sync", "Mark all notifications as read"]);
    const none = buildPaletteItems({ query: "", sections: [], canSyncAll: false, canMarkAllRead: false, actions, search: undefined });
    expect(none).toHaveLength(0);
  });

  it("appends search groups at 2+ characters and run() delegates", () => {
    actions.navigate.mockClear();
    const items = buildPaletteItems({
      query: "alp",
      sections: [],
      canSyncAll: false,
      canMarkAllRead: false,
      actions,
      search: searchResponse(),
    });
    const product = items.find((i) => i.group === "Products");
    expect(product?.label).toBe("Alpha Runner");
    product?.run();
    expect(actions.navigate).toHaveBeenCalledWith("/products/33333333-3333-4333-8333-333333333333");
  });

  it("includes no search results below 2 characters even with data", () => {
    const items = buildPaletteItems({ query: "a", sections: [], canSyncAll: false, canMarkAllRead: false, actions, search: searchResponse() });
    expect(items.find((i) => i.group === "Products")).toBeUndefined();
  });
});

describe("useDebouncedValue", () => {
  it("trails the input by the delay", async () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 40), { initialProps: { value: "a" } });
    rerender({ value: "al" });
    expect(result.current).toBe("a");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(result.current).toBe("al");
  });
});

describe("CommandPalette component", () => {
  function renderPalette(onClose = vi.fn()) {
    return renderApp(
      <>
        <CommandPalette open onClose={onClose} sections={SECTIONS} canSyncAll canMarkAllRead />
        <Routes>
          <Route path="/dashboard" element={<p>start</p>} />
          <Route path="/settings" element={<p>settings page</p>} />
          <Route path="/products/:id" element={<p>product detail</p>} />
        </Routes>
      </>,
      {
        route: "/dashboard",
        handlers: {
          get: { "/api/v1/search": () => searchResponse() },
          post: { "/api/v1/sync/full": () => ({ jobId: "j1" }), "/api/v1/notifications/read-all": () => ({ markedRead: 2 }) },
        },
      },
    );
  }

  it("renders sections and keyboard-selects one to navigate", async () => {
    renderPalette();
    const input = await screen.findByLabelText("Command palette search");
    fireEvent.change(input, { target: { value: "settings" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("settings page")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    renderPalette(onClose);
    const input = await screen.findByLabelText("Command palette search");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("debounces federated search and navigates to a result", async () => {
    const { stub } = renderPalette();
    const input = await screen.findByLabelText("Command palette search");
    fireEvent.change(input, { target: { value: "alp" } });
    await waitFor(() => expect(stub.calls.get).toHaveBeenCalledWith("/api/v1/search", { q: "alp" }), { timeout: 3000 });
    const result = await screen.findByText("Alpha Runner");
    fireEvent.click(result);
    expect(await screen.findByText("product detail")).toBeInTheDocument();
  });

  it("runs the full sync action against the real endpoint", async () => {
    const { stub } = renderPalette();
    const input = await screen.findByLabelText("Command palette search");
    fireEvent.change(input, { target: { value: "full sync" } });
    const action = await screen.findByText("Trigger full data sync");
    fireEvent.click(action);
    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/sync/full", {}));
    expect(await screen.findByText("Full sync scheduled")).toBeInTheDocument();
  });
});
