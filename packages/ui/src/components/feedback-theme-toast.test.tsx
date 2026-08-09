import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AnimatedNumber, EmptyState, ErrorState, ProgressBar, SkeletonText, Spinner } from "./feedback";
import { ThemeProvider, useTheme, THEME_STORAGE_KEY } from "../hooks/theme";
import { ToastProvider, useToast } from "./toast";
import { Button } from "./primitives";

describe("Spinner / Skeleton / ProgressBar", () => {
  it("Spinner is a labelled status", () => {
    render(<Spinner label="Loading analytics" />);
    expect(screen.getByRole("status", { name: "Loading analytics" })).toBeInTheDocument();
  });

  it("SkeletonText renders N decorative lines", () => {
    const { container } = render(<SkeletonText lines={4} />);
    expect(container.querySelectorAll(".animate-pulse").length).toBe(4);
  });

  it("ProgressBar clamps values and exposes progress semantics", () => {
    const { rerender } = render(<ProgressBar value={140} label="Sync progress" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    rerender(<ProgressBar value={33} label="Sync progress" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "33");
  });
});

describe("AnimatedNumber", () => {
  it("renders the initial value and settles on the updated value", async () => {
    const { rerender } = render(<AnimatedNumber value={100} durationMs={30} />);
    expect(screen.getByText("100")).toBeInTheDocument();
    rerender(<AnimatedNumber value={200} durationMs={30} />);
    await waitFor(() => expect(screen.getByText("200")).toBeInTheDocument());
  });

  it("unchanged values never animate (same render output)", () => {
    const { rerender } = render(<AnimatedNumber value={42} />);
    rerender(<AnimatedNumber value={42} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("applies a custom formatter", () => {
    render(<AnimatedNumber value={129900} format={(n) => `$${(n / 100).toFixed(2)}`} />);
    expect(screen.getByText("$1299.00")).toBeInTheDocument();
  });
});

describe("EmptyState / ErrorState", () => {
  it("EmptyState renders title + actions", async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No orders yet"
        body="Orders appear here after the first sync."
        primaryAction={<Button onClick={onClick}>Run sync</Button>}
      />,
    );
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run sync" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("ErrorState renders the error id and retry", async () => {
    const onRetry = vi.fn();
    render(<ErrorState errorId="req-123" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("req-123");
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("ThemeProvider", () => {
  function CurrentTheme(): React.ReactNode {
    const { choice, resolved, setChoice } = useTheme();
    return (
      <div>
        <span data-testid="choice">{choice}</span>
        <span data-testid="resolved">{resolved}</span>
        <Button onClick={() => setChoice("light")}>Light</Button>
        <Button onClick={() => setChoice("system")}>System</Button>
      </div>
    );
  }

  it("dark is the default and data-theme is written to the document", () => {
    render(
      <ThemeProvider>
        <CurrentTheme />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });

  it("persists choice and restores it on next mount", async () => {
    const { unmount } = render(
      <ThemeProvider>
        <CurrentTheme />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    unmount();
    render(
      <ThemeProvider>
        <CurrentTheme />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("choice")).toHaveTextContent("light");
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });

  it("useTheme outside the provider throws a descriptive error", () => {
    expect(() => renderHook(() => useTheme())).toThrow(/ThemeProvider/);
  });

  it("system choice resolves through matchMedia and follows OS changes", () => {
    window.localStorage.clear(); // tests in this file share one jsdom
    let light = false;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const media = {
      get matches(): boolean {
        return light;
      },
      addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    } as unknown as MediaQueryList;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => (query.includes("prefers-color-scheme") ? media : media),
    });
    render(
      <ThemeProvider defaultChoice="system">
        <CurrentTheme />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    act(() => {
      light = true;
      for (const cb of listeners) cb({ matches: true } as MediaQueryListEvent);
    });
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });

  it("honors an injected storage (no window.localStorage dependency)", () => {
    const memory = new Map<string, string>([[THEME_STORAGE_KEY, "light"]]);
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
    };
    render(
      <ThemeProvider storage={storage}>
        <CurrentTheme />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("choice")).toHaveTextContent("light");
  });
});

describe("ToastProvider", () => {
  function Trigger(): React.ReactNode {
    const toast = useToast();
    return (
      <>
        <Button onClick={() => toast.success("Sync started", "Full sync was queued.")}>ok</Button>
        <Button onClick={() => toast.toast({ tone: "error", title: "Webhook failed", durationMs: 0 })}>err</Button>
      </>
    );
  }

  it("renders toasts with tone iconography and dismisses on click", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "ok" }));
    expect(screen.getByText("Sync started")).toBeInTheDocument();
    expect(screen.getByText("Full sync was queued.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Sync started")).toBeNull();
  });

  it("auto-dismisses after the duration", () => {
    // fireEvent (not userEvent) keeps the test synchronous under fake timers.
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Trigger />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "ok" }));
      expect(screen.getByText("Sync started")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.queryByText("Sync started")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persistent toast (durationMs 0) survives the auto-dismiss window", () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Trigger />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "err" }));
      expect(screen.getByText("Webhook failed")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("Webhook failed")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
