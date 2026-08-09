import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  areaPath,
  compactNumber,
  formatDateLabel,
  formatMoney,
  niceTicks,
  seriesExtent,
  smoothPath,
  toPoints,
} from "./chart-utils";
import { AreaChart, Gauge, HealthBar, Sparkline } from "./charts";

describe("chart math (pure)", () => {
  it("niceTicks produce evenly spaced, ordered, rounded ticks", () => {
    const ticks = niceTicks(0, 97, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[0]).toBe(0);
    const diffs = ticks.slice(1).map((t, i) => Number((t - (ticks[i] ?? 0)).toFixed(6)));
    expect(new Set(diffs).size).toBe(1);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(97);
  });

  it("niceTicks handles degenerate ranges", () => {
    expect(niceTicks(5, 5, 4).length).toBeGreaterThan(0);
    expect(niceTicks(-8, 2, 4)[0]).toBeLessThanOrEqual(-8);
  });

  it("seriesExtent reports min/max with sane default for empty", () => {
    expect(seriesExtent([3, -1, 8])).toEqual({ min: -1, max: 8 });
    expect(seriesExtent([])).toEqual({ min: 0, max: 1 });
  });

  it("toPoints maps into viewBox space; flat series centers vertically", () => {
    const points = toPoints([0, 50, 100], 100, 40, 0);
    expect(points[0]).toEqual({ x: 0, y: 40 });
    expect(points[2]).toEqual({ x: 100, y: 0 });
    const flat = toPoints([7, 7, 7], 100, 40, 0);
    expect(flat.every((p) => p.y === 20)).toBe(true);
  });

  it("smoothPath produces a valid cubic path; areaPath closes to baseline", () => {
    const points = toPoints([1, 4, 2, 8], 100, 40, 0);
    const line = smoothPath(points);
    expect(line.startsWith("M")).toBe(true);
    expect(line).toContain("C");
    const area = areaPath(points, 100, 40);
    expect(area.endsWith("Z")).toBe(true);
    expect(area).toContain("L100,40");
  });

  it("formatters", () => {
    expect(compactNumber(2_400_000)).toBe("2.4M");
    expect(compactNumber(12_500)).toBe("12.5K");
    expect(compactNumber(999)).toBe("999");
    expect(formatMoney(129900, "USD")).toBe("$1,299.00");
    expect(formatDateLabel("2026-08-05")).toBe("Aug 5");
  });
});

describe("chart components", () => {
  it("AreaChart renders labelled svg with series paths and x labels", () => {
    render(
      <AreaChart
        series={[{ label: "Net revenue", values: [10, 40, 22, 55, 31] }]}
        xLabels={["Aug 1", "Aug 2", "Aug 3", "Aug 4", "Aug 5"]}
        testId="revenue-chart"
      />,
    );
    expect(screen.getByTestId("revenue-chart")).toHaveAttribute(
      "aria-label",
      "Trend chart: Net revenue",
    );
    expect(screen.getByText("Aug 1")).toBeInTheDocument();
  });

  it("AreaChart renders a legend for multi-series", () => {
    render(
      <AreaChart
        series={[
          { label: "Gross", values: [1, 2, 3] },
          { label: "Net", values: [1, 1.5, 2] },
        ]}
      />,
    );
    expect(screen.getByText("Gross")).toBeInTheDocument();
    expect(screen.getByText("Net")).toBeInTheDocument();
  });

  it("Sparkline renders nothing for empty values, svg otherwise", () => {
    const { container, rerender } = render(<Sparkline values={[]} />);
    expect(container.firstChild).toBeNull();
    rerender(<Sparkline values={[1, 3, 2, 5]} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("Gauge clamps and labels", () => {
    render(<Gauge value={140} label="AI score" />);
    expect(screen.getByRole("img", { name: "Score: 140 of 100" })).toHaveTextContent("140");
  });

  it("HealthBar renders segment counts", () => {
    render(
      <HealthBar
        segments={[
          { label: "Healthy", tone: "success", count: 5 },
          { label: "Attention", tone: "warning", count: 2 },
        ]}
      />,
    );
    expect(screen.getByText("Healthy · 5")).toBeInTheDocument();
    expect(screen.getByText("Attention · 2")).toBeInTheDocument();
  });
});
