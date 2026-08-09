import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  ChevronRight,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import {
  cn,
  DropdownMenu,
  Spinner,
  useTheme,
  useToast,
} from "@profit/ui";
import { RealtimeEventKind } from "@profit/types";
import { useAuth } from "../lib/auth-context";
import { RealtimeClient } from "../lib/realtime";
import { useOnlineStatus } from "../lib/use-online";
import { useStoreQuery, useSyncStatusQuery, useUnreadCountQuery } from "../lib/queries";
import { OfflineIcon } from "../components/QueryBoundary";
import { CommandPalette } from "./CommandPalette";
import { NotificationDrawer } from "./NotificationDrawer";
import { APP_SECTIONS, SECTION_GROUPS, sectionsForGroup, visibleSections, type AppSection } from "./sections";

/**
 * The embedded app shell (P9): left section nav, top utility bar, main
 * workspace, notification drawer, command palette. Responsiveness: the
 * sidebar is fixed ≥lg and an overlay panel below; every touch target is a
 * real button with an accessible name.
 */

type SyncHealth = "healthy" | "attention" | "failed" | "loading";

function syncHealth(status: ReturnType<typeof useSyncStatusQuery>["data"]): SyncHealth {
  if (status === undefined) return "loading";
  const modules = status.modules;
  if (modules.some((m) => m.status === "FAILED")) return "failed";
  if (modules.some((m) => m.status === "RUNNING" || m.status === "PENDING" || m.finishedAt === null)) {
    return "attention";
  }
  return "healthy";
}

const HEALTH_DOT: Record<SyncHealth, string> = {
  healthy: "bg-success",
  attention: "bg-warning animate-pulse",
  failed: "bg-danger animate-pulse",
  loading: "bg-faint",
};

const HEALTH_LABEL: Record<SyncHealth, string> = {
  healthy: "Data fresh — all modules synced",
  attention: "Sync in progress or pending",
  failed: "A sync module needs attention",
  loading: "Checking sync status…",
};

function SectionLink({ section, onNavigate }: { readonly section: AppSection; readonly onNavigate?: (() => void) | undefined }): ReactNode {
  const Icon = section.icon;
  return (
    <NavLink
      to={section.path}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors",
          "focus-visible:outline-2 focus-visible:outline-primary",
          isActive
            ? "bg-primary-soft text-foreground"
            : "text-muted hover:bg-surface-raised hover:text-foreground",
        )
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 truncate">{section.label}</span>
      {section.availability === "roadmap" && (
        <span className="rounded-full bg-ai-soft px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-ai">
          {section.milestone}
        </span>
      )}
    </NavLink>
  );
}

function SectionNav({ onNavigate }: { readonly onNavigate?: (() => void) | undefined }): ReactNode {
  const { hasPermission } = useAuth();
  const sections = visibleSections(hasPermission);
  return (
    <nav aria-label="Sections" className="flex flex-col gap-4">
      {SECTION_GROUPS.map((group) => {
        const items = sectionsForGroup(group).filter((s) => sections.includes(s));
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-faint">
              {group}
            </p>
            <div className="flex flex-col gap-0.5">
              {items.map((section) => (
                <SectionLink key={section.key} section={section} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function ThemeMenu(): ReactNode {
  const { choice, setChoice } = useTheme();
  const icon = choice === "light" ? <Sun className="size-4" /> : choice === "dark" ? <Moon className="size-4" /> : <Monitor className="size-4" />;
  return (
    <DropdownMenu
      ariaLabel="Theme"
      trigger={<span className="inline-flex p-1.5">{icon}</span>}
      items={[
        { key: "dark", label: "Dark (default)", icon: <Moon className="size-3.5" aria-hidden />, onSelect: () => setChoice("dark") },
        { key: "light", label: "Light", icon: <Sun className="size-3.5" aria-hidden />, onSelect: () => setChoice("light") },
        { key: "system", label: "Match system", icon: <Monitor className="size-3.5" aria-hidden />, onSelect: () => setChoice("system") },
      ]}
    />
  );
}

export function AppLayout(): ReactNode {
  const { status, accessToken, user, claims, signOut, hasPermission } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const online = useOnlineStatus();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const store = useStoreQuery();
  const sync = useSyncStatusQuery();
  const unread = useUnreadCountQuery();
  const health = syncHealth(sync.data);

  // ── Realtime: events invalidate queries + toast new notifications ──────
  const realtime = useMemo(
    () =>
      new RealtimeClient({
        queryClient,
        onNotification: (event) => {
          if (event.kind !== RealtimeEventKind.NotificationCreated) return;
          const payload = event.payload;
          toast.toast({
            tone: payload.category === "SECURITY" ? "error" : payload.category === "AI" ? "ai" : "info",
            title: payload.title,
            body: payload.body,
          });
        },
      }),
    [queryClient, toast],
  );

  useEffect(() => {
    if (status === "ready" && accessToken !== null) {
      realtime.start(accessToken);
      return () => realtime.stop();
    }
    return undefined;
  }, [status, accessToken, realtime]);

  // ── Global palette hotkey (⌘K / Ctrl+K) ────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Close the mobile nav whenever the route changes.
  useEffect(() => setMobileNavOpen(false), [location.pathname]);

  const onboardingComplete =
    store.data === undefined || store.data.settings === null
      ? true // not loaded / provisioning edge → never trap the merchant
      : store.data.settings.onboardingCompletedAt !== null;

  if (!onboardingComplete) {
    return <Navigate to="/onboarding" replace />;
  }

  const storeName = store.data?.store.name ?? claims?.storeId ?? "Store";
  const shopDomain = store.data?.store.shopDomain ?? "";
  const canSeeNotifications = hasPermission("notifications:read");
  const permittedSections = visibleSections(hasPermission);

  return (
    <div className="min-h-screen bg-canvas text-foreground">
      {/* ── Sidebar (fixed ≥ lg) ─────────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-subtle bg-surface-solid lg:flex">
        <div className="flex items-center gap-2.5 border-b border-subtle px-4 py-4">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-on-primary">
            <ChevronRight className="size-4 -rotate-45" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-bold tracking-wide text-foreground">PROFIT TOOL AI</p>
            <p className="truncate text-[11px] text-faint">{shopDomain}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SectionNav />
        </div>
        <div className="border-t border-subtle px-4 py-3">
          <Link to="/settings?tab=sync" className="flex items-center gap-2 text-[11px] text-muted transition-colors hover:text-foreground">
            <span className={cn("inline-block size-1.5 rounded-full", HEALTH_DOT[health])} aria-hidden />
            <span className="flex-1 truncate">{HEALTH_LABEL[health]}</span>
          </Link>
        </div>
      </aside>

      {/* ── Mobile nav overlay ───────────────────────────────────────────── */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-[var(--pf-z-modal,70)] lg:hidden" role="presentation">
          <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-subtle bg-surface-solid shadow-[var(--shadow-drawer)]">
            <div className="flex items-center justify-between border-b border-subtle px-4 py-4">
              <p className="text-[13px] font-bold tracking-wide text-foreground">PROFIT TOOL AI</p>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileNavOpen(false)}
                className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-4">
              <SectionNav onNavigate={() => setMobileNavOpen(false)} />
            </div>
          </div>
        </div>
      )}

      {/* ── Main column ──────────────────────────────────────────────────── */}
      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-subtle bg-canvas/80 backdrop-blur-md">
          <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setMobileNavOpen(true)}
              className="rounded-md p-2 text-muted transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary lg:hidden"
            >
              <Menu className="size-4" aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className={cn(
                "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-subtle bg-surface-raised/60 px-3 text-left text-[13px] text-faint",
                "transition-colors hover:border-strong focus-visible:outline-2 focus-visible:outline-primary sm:max-w-xs",
              )}
              aria-label="Open command palette and search"
            >
              <Search className="size-3.5 shrink-0" aria-hidden />
              <span className="flex-1 truncate">Search or command…</span>
              <kbd className="hidden rounded border border-subtle bg-surface-solid px-1.5 py-0.5 font-mono text-[10px] sm:inline">⌘K</kbd>
            </button>

            <div className="ml-auto flex items-center gap-1">
              {!online && (
                <span className="mr-1 inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 py-1 text-[11px] font-medium text-warning">
                  <OfflineIcon />
                  Offline
                </span>
              )}
              <ThemeMenu />
              {canSeeNotifications && (
                <button
                  type="button"
                  aria-label={unread.data !== undefined && unread.data > 0 ? `Notifications, ${String(unread.data)} unread` : "Notifications"}
                  onClick={() => setDrawerOpen(true)}
                  className="relative rounded-md p-2 text-muted transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <Bell className="size-4" aria-hidden />
                  {unread.data !== undefined && unread.data > 0 && (
                    <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">
                      {unread.data > 99 ? "99+" : unread.data}
                    </span>
                  )}
                </button>
              )}
              <DropdownMenu
                ariaLabel="Account"
                trigger={
                  <span className="ml-1 flex size-8 items-center justify-center rounded-full bg-primary-soft text-[11px] font-bold text-primary">
                    {(user?.fullName ?? storeName).slice(0, 2).toUpperCase()}
                  </span>
                }
                items={[
                  {
                    key: "identity",
                    label: (
                      <span className="block">
                        <span className="block font-medium">{user?.fullName ?? storeName}</span>
                        <span className="block text-[11px] text-faint">
                          {user?.email ?? shopDomain} · {claims?.role ?? ""}
                        </span>
                      </span>
                    ),
                    disabled: true,
                    onSelect: () => undefined,
                  },
                  {
                    key: "settings",
                    label: "Store settings",
                    onSelect: () => {
                      navigate("/settings");
                    },
                  },
                  { key: "signout", label: "Sign out", icon: <LogOut className="size-3.5" aria-hidden />, danger: true, onSelect: signOut },
                ]}
              />
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8" id="main">
          <div className="mx-auto w-full max-w-7xl">
            {store.isPending ? (
              <div className="flex items-center justify-center py-24">
                <Spinner label="Loading your store" />
              </div>
            ) : (
              <Outlet />
            )}
          </div>
        </main>
      </div>

      {canSeeNotifications && <NotificationDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sections={permittedSections}
        canSyncAll={APP_SECTIONS.length > 0 && hasPermission("products:sync")}
        canMarkAllRead={hasPermission("notifications:update")}
      />
    </div>
  );
}
