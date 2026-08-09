import type { ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { Spinner } from "@profit/ui";
import { useAuth } from "../lib/auth-context";
import { InstallGate } from "./InstallGate";

/**
 * Route guards. RequireAuth owns the three boot states permanently:
 *   booting    → full-screen branded loading (App Bridge handshake / refresh)
 *   standalone → install gate (never a broken shell, never a fake session)
 *   ready      → the app
 */
export function RequireAuth(): ReactNode {
  const { status } = useAuth();
  if (status === "booting") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-on-primary">
          <ShieldCheck className="size-6" aria-hidden />
        </div>
        <Spinner label="Establishing secure session" />
        <p className="text-xs text-muted">Establishing a secure session…</p>
      </div>
    );
  }
  if (status === "standalone") return <InstallGate />;
  return <Outlet />;
}

/** Section-level RBAC — mirrors the server rule; renders an honest denial. */
export function RequirePermission({
  permission,
  children,
}: {
  readonly permission: string;
  readonly children: ReactNode;
}): ReactNode {
  const { hasPermission, user } = useAuth();
  if (!hasPermission(permission)) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-20 text-center">
        <div className="flex size-12 items-center justify-center rounded-lg bg-warning-soft text-warning">
          <ShieldCheck className="size-6" aria-hidden />
        </div>
        <h2 className="text-base font-semibold text-foreground">No access to this section</h2>
        <p className="text-sm leading-relaxed text-muted">
          Your role ({user?.role ?? "unknown"}) does not include the{" "}
          <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs">{permission}</code>{" "}
          permission. Ask an owner or admin to grant it in your store's user settings.
        </p>
        <NavigateFallback />
      </div>
    );
  }
  return children;
}

function NavigateFallback(): ReactNode {
  // Real link back to a surface every role can load.
  return (
    <Link
      to="/dashboard"
      className="mt-2 text-sm font-medium text-primary transition-colors hover:text-primary-strong"
    >
      Back to an area you can access
    </Link>
  );
}
