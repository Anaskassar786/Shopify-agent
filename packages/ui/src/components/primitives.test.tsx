import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Badge, Button, Card, Input, Select, Textarea } from "./primitives";

describe("Button", () => {
  it("renders children and fires onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save changes</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("loading state disables interaction and exposes busy semantics", () => {
    render(<Button loading>Syncing</Button>);
    const button = screen.getByRole("button", { name: "Syncing" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("all variants render with tone classes", () => {
    const { rerender } = render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-danger-soft");
    rerender(<Button variant="ai">Generate</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-ai-soft");
    rerender(<Button variant="ghost">Skip</Button>);
    expect(screen.getByRole("button")).toHaveClass("text-muted");
  });
});

describe("Badge", () => {
  it("maps tones to semantic colors", () => {
    const { rerender } = render(<Badge tone="success">Active</Badge>);
    expect(screen.getByText("Active")).toHaveClass("text-success");
    rerender(<Badge tone="ai">AI Draft</Badge>);
    expect(screen.getByText("AI Draft")).toHaveClass("text-ai");
  });
});

describe("Card", () => {
  it("non-interactive by default (no button role)", () => {
    render(<Card>Static content</Card>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Static content")).toBeInTheDocument();
  });

  it("interactive cards respond to click and keyboard", async () => {
    const onClick = vi.fn();
    render(
      <Card interactive onClick={onClick}>
        Open details
      </Card>,
    );
    const card = screen.getByRole("button");
    await userEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
    card.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe("Form primitives", () => {
  it("Input marks invalid accessibly", () => {
    render(<Input invalid placeholder="Store name" />);
    expect(screen.getByPlaceholderText("Store name")).toHaveAttribute("aria-invalid", "true");
  });

  it("Select renders options and honors changes", async () => {
    function Wrapper(): React.ReactNode {
      const [value, setValue] = useState("30");
      return (
        <Select aria-label="Range" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </Select>
      );
    }
    render(<Wrapper />);
    await userEvent.selectOptions(screen.getByLabelText("Range"), "90");
    expect(screen.getByLabelText("Range")).toHaveValue("90");
  });

  it("Textarea forwards value + invalid state", async () => {
    render(<Textarea invalid defaultValue="hello" aria-label="Notes" />);
    const area = screen.getByLabelText("Notes");
    expect(area).toHaveAttribute("aria-invalid", "true");
    await userEvent.type(area, " world");
    expect(area).toHaveValue("hello world");
  });
});
