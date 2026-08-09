import { useMemo, type ReactNode } from "react";
import { ExternalLink, ShieldCheck, Store } from "lucide-react";
import { Button, Card } from "@profit/ui";
import { detectEmbeddedHost } from "../lib/shopify";

/**
 * Shown ONLY when no valid session exists (outside Shopify Admin, expired
 * standalone visit, or a revoked install). It never pretends to be the app:
 * it either deep-links into the real OAuth install flow or explains where the
 * app must be opened from.
 */
export function InstallGate(): ReactNode {
  const host = useMemo(() => detectEmbeddedHost(window.location.search), []);

  // The OAuth entry point is a real API route; target _top so a request made
  // inside the Shopify Admin iframe escapes it for the consent screen.
  const installUrl = host.shop !== null ? `/shopify/install?shop=${encodeURIComponent(host.shop)}` : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <Card className="w-full max-w-md">
        <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
          <div className="flex size-14 items-center justify-center rounded-xl bg-primary text-on-primary shadow-[var(--shadow-card)]">
            <ShieldCheck className="size-7" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">PROFIT TOOL AI</h1>
            <p className="mt-1 text-sm text-muted">AI decision support for your Shopify store</p>
          </div>
          <p className="text-sm leading-relaxed text-muted">
            This app runs inside Shopify Admin so it can verify your identity with Shopify directly.
            {" "}Open it from <span className="font-medium text-foreground">Admin → Apps</span>, or start the
            secure install below.
          </p>
          {installUrl !== null ? (
            <a href={installUrl} target="_top" rel="noreferrer" className="w-full">
              <Button className="w-full" iconLeft={<Store className="size-4" aria-hidden />}>
                Install for {host.shop}
              </Button>
            </a>
          ) : (
            <div className="w-full rounded-lg border border-subtle bg-surface-raised px-4 py-3 text-left">
              <p className="text-xs leading-relaxed text-muted">
                To install, open your Shopify Admin and choose{" "}
                <span className="font-medium text-foreground">Apps → PROFIT TOOL AI</span>, or add{" "}
                <code className="rounded bg-surface-solid px-1.5 py-0.5 font-mono text-[11px]">
                  ?shop=your-store.myshopify.com
                </code>{" "}
                to this URL and reload to begin OAuth.
              </p>
            </div>
          )}
          {installUrl !== null && (
            <p className="inline-flex items-center gap-1.5 text-[11px] text-faint">
              <ExternalLink className="size-3" aria-hidden />
              You will be redirected to Shopify to approve access — nothing is installed silently.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
