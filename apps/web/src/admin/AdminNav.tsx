import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

/** Admin section tab — plain NavLink (real paths, no fake buttons). */
export function NavButton({ to, label }: { readonly to: string; readonly label: string }): ReactNode {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        isActive
          ? "inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-md border border-subtle bg-surface-raised px-3 text-[13px] font-medium text-foreground transition-all duration-[var(--transition-fast)]"
          : "inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-md border border-transparent px-3 text-[13px] font-medium text-muted transition-all duration-[var(--transition-fast)] hover:bg-surface-raised hover:text-foreground"
      }
    >
      {label}
    </NavLink>
  );
}
