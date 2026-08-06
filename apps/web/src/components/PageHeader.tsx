import type { ReactNode } from "react";
import { cn } from "@profit/ui";

/**
 * Consistent page masthead across all 15 sections: title, one-line purpose,
 * and an actions slot (range selectors, primary buttons). Keeps vertical
 * rhythm identical so section switching feels stable (P9 layout contract).
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          {title}
        </h1>
        {subtitle !== undefined && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{subtitle}</p>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
