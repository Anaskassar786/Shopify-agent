import type { ReactNode } from "react";

/**
 * Shared compact evidence/facts table (M8): the copilot's evidence bundles
 * (ADR 32) and enterprise-report sections (ADR 34) render the same
 * {title, columns, rows} wire shape — one renderer keeps both surfaces
 * visually and accessibly identical.
 */
export interface FactsTableData {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export function FactsTable({ table }: { readonly table: FactsTableData }): ReactNode {
  return (
    <div className="overflow-x-auto rounded-lg border border-subtle">
      <p className="border-b border-subtle bg-surface-raised px-3 py-1.5 text-xs font-semibold text-foreground">{table.title}</p>
      <table className="w-full text-left text-xs" aria-label={table.title}>
        <thead>
          <tr className="border-b border-subtle">
            {table.columns.map((column) => (
              <th key={column} scope="col" className="px-3 py-1.5 font-medium text-muted">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index} className="border-b border-subtle last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-1.5 text-foreground">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
