import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, DropdownMenu, Modal, Tabs } from "./overlays";
import { Button } from "./primitives";

describe("Modal", () => {
  it("renders nothing while closed; opens as a labelled dialog", () => {
    const { rerender } = render(
      <Modal open={false} onClose={() => undefined} title="Explain recommendation">
        <p>Because…</p>
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <Modal open onClose={() => undefined} title="Explain recommendation">
        <p>Because…</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Explain recommendation");
    expect(screen.getByText("Because…")).toBeInTheDocument();
  });

  it("ESC closes when dismissible, does not when locked", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Closeable">
        x
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    const onCloseLocked = vi.fn();
    render(
      <Modal open onClose={onCloseLocked} title="Locked" dismissible={false}>
        y
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onCloseLocked).not.toHaveBeenCalled();
  });

  it("close button and backdrop both dismiss", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Any">
        z
      </Modal>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.parentElement !== null
      ? document.querySelector(".bg-overlay")
      : null;
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("ConfirmDialog", () => {
  it("confirm and cancel route to the right handlers", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        onConfirm={onConfirm}
        title="Delete discount?"
        body="This stops the code from working immediately."
        confirmLabel="Delete"
        danger
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("DropdownMenu", () => {
  it("opens on trigger, runs item action and closes; outside click dismisses", async () => {
    const onSelect = vi.fn();
    render(
      <div>
        <DropdownMenu
          ariaLabel="Row actions"
          trigger={<span>⋯</span>}
          items={[
            { key: "edit", label: "Edit", onSelect },
            { key: "delete", label: "Delete", danger: true, onSelect: () => undefined },
          ]}
        />
        <Button variant="ghost">Outside</Button>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Row actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Row actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("Tabs", () => {
  it("renders active state and switches via click", async () => {
    function Wrapper(): React.ReactNode {
      const [active, setActive] = useState("overview");
      return (
        <Tabs
          items={[
            { key: "overview", label: "Overview" },
            { key: "evidence", label: "Evidence", count: 4 },
          ]}
          active={active}
          onChange={setActive}
        />
      );
    }
    render(<Wrapper />);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Evidence 4" }));
    expect(screen.getByRole("tab", { name: "Evidence 4" })).toHaveAttribute("aria-selected", "true");
  });
});
