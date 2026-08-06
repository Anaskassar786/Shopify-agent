import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { Button } from "@profit/ui";

/**
 * Inline upgrade CTA for entitlement refusals (UPGRADE_REQUIRED /
 * QUOTA_EXCEEDED). Revenue-action denials route merchants to Billing — the
 * one place the gate lifts — instead of dead-ending on an error toast.
 */
export function UpgradeNotice({
  message,
  onDismiss,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
}): ReactNode {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3"
    >
      <Sparkles className="size-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">{message}</p>
      <div className="flex items-center gap-2">
        <Link to="/billing">
          <Button size="sm" iconRight={<ArrowRight className="size-3.5" aria-hidden />}>
            View plans
          </Button>
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss upgrade notice"
          className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
