import { useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ShieldCheck, LogOut } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Input } from "@profit/ui";
import { AdminTabs } from "./AdminTabs";

/**
 * Super Admin v1 (M5) — a SEPARATE application tree from the merchant app:
 * no Shopify session, no App Bridge, no install gate. Its only credential is
 * the platform admin key, held in MEMORY (never localStorage, never cookies)
 * so a browser restart always revokes access. Read-only by design — the API
 * enforces the same rule.
 */
export function AdminApp(): ReactNode {
  const [adminKey, setAdminKey] = useState<string | null>(null);
  if (adminKey === null) {
    return <AdminKeyGate onUnlock={setAdminKey} />;
  }
  return <AdminShell adminKey={adminKey} onLock={() => setAdminKey(null)} />;
}

/** Probe the key against the live API before revealing the panel — no fake gates. */
function AdminKeyGate({ onUnlock }: { readonly onUnlock: (key: string) => void }): ReactNode {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const key = draft.trim();
    if (key === "") {
      setError("Enter the platform admin key.");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/admin/overview", {
        headers: { Accept: "application/json", "X-Platform-Admin-Key": key },
      });
      if (response.status === 401 || response.status === 403) {
        setError("That key was rejected. Check the key and try again — attempts are audit-logged.");
        return;
      }
      if (!response.ok) {
        setError(`The admin API answered ${String(response.status)}. Is this the right environment?`);
        return;
      }
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null && (parsed as { success?: unknown }).success === true) {
        onUnlock(key);
        return;
      }
      setError("Unexpected response from the admin API.");
    } catch {
      setError("The server could not be reached. Check your connection and retry.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" aria-hidden /> PROFIT TOOL AI — Super Admin
            </span>
          }
          subtitle="Platform operator console. Access is key-gated and fully audit-logged."
        />
        <CardBody>
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-foreground">Platform admin key</span>
              <Input
                type="password"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="PLATFORM_ADMIN_KEY"
                autoComplete="off"
                autoFocus
              />
            </label>
            {error !== null && (
              <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">
                {error}
              </p>
            )}
            <Button type="submit" loading={checking}>
              Unlock console
            </Button>
            <p className="text-xs leading-relaxed text-faint">
              The key is kept in memory only and disappears when this tab closes. Read-only
              observability — merchants, funnel, modeled revenue, AI usage.
            </p>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}

function AdminShell({ adminKey, onLock }: { readonly adminKey: string; readonly onLock: () => void }): ReactNode {
  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 border-b border-subtle bg-surface-raised/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <ShieldCheck className="size-5 text-primary" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-foreground">PROFIT TOOL AI — Super Admin</p>
              <p className="text-[11px] text-faint">read-only platform observability · every request audited</p>
            </div>
            <Badge tone="info">v1</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={onLock} iconLeft={<LogOut className="size-3.5" aria-hidden />}>
            Lock console
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route index element={<Navigate to="/admin/overview" replace />} />
          <Route path="/admin/overview" element={<AdminOverviewView adminKey={adminKey} />} />
          <Route path="/admin/merchants" element={<AdminMerchantsView adminKey={adminKey} />} />
          <Route path="/admin/ai-usage" element={<AdminAiUsageView adminKey={adminKey} />} />
          <Route path="*" element={<Navigate to="/admin/overview" replace />} />
        </Routes>
      </main>
    </div>
  );
}

import { AdminAiUsageView } from "./AdminAiUsageView";
import { AdminMerchantsView } from "./AdminMerchantsView";
import { AdminOverviewView } from "./AdminOverviewView";
