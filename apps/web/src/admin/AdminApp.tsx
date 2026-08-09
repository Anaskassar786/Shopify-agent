import { useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ShieldCheck, LogOut, KeyRound } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Input, Modal, Textarea, useToast } from "@profit/ui";
import { AdminTabs } from "./AdminTabs";
import { AdminAiUsageView } from "./AdminAiUsageView";
import { AdminMerchantsView } from "./AdminMerchantsView";
import { AdminOverviewView } from "./AdminOverviewView";
import { AdminTicketsView } from "./AdminTicketsView";
import { AdminActionsView } from "./AdminActionsView";
import { AdminAccessReviewView } from "./AdminAccessReviewView";
import { AdminAccountActionsView } from "./AdminAccountActionsView";
import { AdminOpsView } from "./AdminOpsView";
import { openAdminSession } from "../lib/admin-queries";
import {
  clearAdminSession,
  loadAdminSession,
  saveAdminSession,
  sessionFromResponse,
  type AdminSession,
} from "./admin-session-store";

/**
 * Super Admin (M5 reads + M6 writes) — a SEPARATE application tree from the
 * merchant app: no Shopify session, no App Bridge, no install gate.
 *
 * Trust model: the platform admin KEY (memory only, typed again after every
 * reload — a feature, not a bug) authorizes READS. WRITES additionally need
 * a 15-minute step-up session (operator id + reason → HMAC token, kept in
 * sessionStorage so one sitting survives reloads but the tab closing kills
 * it). The API enforces both boundaries; this UI only mirrors them honestly.
 */
export function AdminApp(): ReactNode {
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [session, setSession] = useState<AdminSession | null>(() => loadAdminSession());
  if (adminKey === null) {
    return <AdminKeyGate onUnlock={setAdminKey} />;
  }
  return (
    <AdminShell
      adminKey={adminKey}
      session={session}
      onSession={setSession}
      onLock={() => {
        clearAdminSession();
        setSession(null);
        setAdminKey(null);
      }}
    />
  );
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
              The key is kept in memory only and disappears when this tab closes. Reads unlock here; write actions
              additionally ask who you are (that stamp is permanent in the action log).
            </p>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}

/** Step-up modal: operator identity + reason → POST /admin/session. */
function SessionUnlockModal({
  adminKey,
  onClose,
  onSession,
}: {
  readonly adminKey: string;
  readonly onClose: () => void;
  readonly onSession: (session: AdminSession) => void;
}): ReactNode {
  const toast = useToast();
  const [operatorId, setOperatorId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (): Promise<void> => {
    const operator = operatorId.trim();
    const why = reason.trim();
    if (operator === "" || why.length < 3) return;
    setPending(true);
    setError(null);
    try {
      const response = await openAdminSession(adminKey, operator, why);
      const session = sessionFromResponse(response);
      saveAdminSession(session);
      onSession(session);
      toast.success("Write actions unlocked", `Operator ${session.operatorId} stamped until ${new Date(session.expiresAt).toLocaleTimeString()}.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The session request failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Unlock write actions"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} loading={pending} disabled={operatorId.trim() === "" || reason.trim().length < 3}>
            Open operator session
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-relaxed text-muted">
          Write actions (ticket replies, trial extensions, access overrides) are stamped with an operator identity in
          the permanent action log. The session lasts 15 minutes.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Operator identity</span>
          <Input value={operatorId} maxLength={200} onChange={(event) => setOperatorId(event.target.value)} aria-label="Operator identity" placeholder="name-or-initials@profit" autoFocus />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Reason for this session</span>
          <Textarea value={reason} rows={2} maxLength={500} onChange={(event) => setReason(event.target.value)} aria-label="Session reason" placeholder="Support shift, incident IN-123, merchant escalation…" />
        </label>
        {error !== null && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function AdminShell({
  adminKey,
  session,
  onSession,
  onLock,
}: {
  readonly adminKey: string;
  readonly session: AdminSession | null;
  readonly onSession: (session: AdminSession | null) => void;
  readonly onLock: () => void;
}): ReactNode {
  const [unlockOpen, setUnlockOpen] = useState(false);
  const minutesLeft = session !== null ? Math.max(0, Math.round((Date.parse(session.expiresAt) - Date.now()) / 60_000)) : 0;

  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 border-b border-subtle bg-surface-raised/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <ShieldCheck className="size-5 text-primary" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-foreground">PROFIT TOOL AI — Super Admin</p>
              <p className="text-[11px] text-faint">platform observability + operator-stamped support writes</p>
            </div>
            <Badge tone="info">v2</Badge>
          </div>
          <div className="flex items-center gap-2">
            {session !== null ? (
              <>
                <Badge tone="success">
                  operator {session.operatorId} · {minutesLeft} min
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearAdminSession();
                    onSession(null);
                  }}
                >
                  End session
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<KeyRound className="size-3.5" aria-hidden />}
                onClick={() => setUnlockOpen(true)}
              >
                Unlock write actions
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onLock} iconLeft={<LogOut className="size-3.5" aria-hidden />}>
              Lock console
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route index element={<Navigate to="/admin/overview" replace />} />
          <Route path="/admin/overview" element={<AdminOverviewView adminKey={adminKey} />} />
          <Route path="/admin/merchants" element={<AdminMerchantsView adminKey={adminKey} />} />
          <Route path="/admin/ops" element={<AdminOpsView adminKey={adminKey} session={session} />} />
          <Route path="/admin/ai-usage" element={<AdminAiUsageView adminKey={adminKey} />} />
          <Route path="/admin/tickets" element={<AdminTicketsView adminKey={adminKey} session={session} />} />
          <Route path="/admin/account-actions" element={<AdminAccountActionsView adminKey={adminKey} session={session} />} />
          <Route path="/admin/actions" element={<AdminActionsView adminKey={adminKey} />} />
          <Route path="/admin/access-review" element={<AdminAccessReviewView adminKey={adminKey} />} />
          <Route path="*" element={<Navigate to="/admin/overview" replace />} />
        </Routes>
      </main>
      {unlockOpen && <SessionUnlockModal adminKey={adminKey} onClose={() => setUnlockOpen(false)} onSession={onSession} />}
    </div>
  );
}
