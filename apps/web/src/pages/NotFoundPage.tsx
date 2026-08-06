import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PackageSearch } from "lucide-react";
import { Button } from "@profit/ui";

export function NotFoundPage(): ReactNode {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <div className="flex size-14 items-center justify-center rounded-xl bg-surface-raised text-faint">
        <PackageSearch className="size-7" aria-hidden />
      </div>
      <div>
        <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
          This URL does not match any section of the app. It may have moved — the dashboard is always a safe
          place to restart.
        </p>
      </div>
      <Link to="/dashboard">
        <Button variant="secondary" size="sm">Go to dashboard</Button>
      </Link>
    </div>
  );
}
