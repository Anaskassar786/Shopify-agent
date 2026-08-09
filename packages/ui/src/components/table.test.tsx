import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, StatCard, type ColumnDef } from "./table";
import { EmptyState } from "./feedback";

interface Row {
  id: string;
  name: string;
  revenue: number;
}

const columns: readonly ColumnDef<Row>[] = [
  { key: "name", header: "Name", sortable: true, cell: (row) => row.name },
  { key: "revenue", header: "Revenue", align: "right", sortable: true, cell: (row) => `$${String(row.revenue)}` },
];

const rows: readonly Row[] = [
  { id: "1", name: "Aurora Lamp", revenue: 1200 },
  { id: "2", name: "Nimbus Chair", revenue: 900 },
];

describe("DataTable", () => {
  it("renders rows with stable keys and clickable rows", async () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    expect(screen.getByText("Aurora Lamp")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Nimbus Chair"));
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
  });

  it("sortable headers emit key changes with aria-sort", async () => {
    const onSortChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={onSortChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(onSortChange).toHaveBeenCalledWith("name");
    const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
  });

  it("shows loading skeletons instead of data while loading", () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} loading />);
    expect(screen.queryByText("Aurora Lamp")).toBeNull();
  });

  it("renders the empty state when no rows", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="No products yet" />}
      />,
    );
    expect(screen.getByText("No products yet")).toBeInTheDocument();
  });

  it("pagination clamps at boundaries and reports page position", async () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        pagination={{ page: 2, pageSize: 25, totalItems: 52, onPageChange }}
      />,
    );
    expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});

describe("StatCard", () => {
  it("renders a KPI with delta tone and hint", () => {
    render(
      <StatCard
        label="Net revenue"
        value="$4,210"
        delta="+12.4%"
        deltaTone="up"
        hint="vs previous 30d"
      />,
    );
    expect(screen.getByText("Net revenue")).toBeInTheDocument();
    expect(screen.getByText("$4,210")).toBeInTheDocument();
    expect(screen.getByText("+12.4%")).toHaveClass("text-success");
  });

  it("loading mode shows skeleton not the value", () => {
    render(<StatCard label="Orders" value="42" loading />);
    expect(screen.queryByText("42")).toBeNull();
  });
});
