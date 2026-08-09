import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Package, Search, ShoppingCart, Users, Zap } from "lucide-react";
import { useToast } from "@profit/ui";
import type { GlobalSearchResponse } from "../lib/api-types";
import { useGlobalSearchQuery, useMarkAllNotificationsReadMutation, useTriggerFullSyncMutation } from "../lib/queries";
import { ApiError } from "../lib/api-client";
import type { AppSection } from "./sections";

/**
 * Command palette (P9): ⌘K / Ctrl+K anywhere. Three real capabilities and
 * nothing else: navigate to any permitted section, run the two safe global
 * actions the API exposes (full sync, mark-all-read), and federated search
 * across products/customers/orders via GET /search (per-permission groups,
 * exactly as the server scopes them).
 *
 * The item list is built by the pure `buildPaletteItems` so keyboard math and
 * group assembly are unit-tested without rendering.
 */

export interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint: string | null;
  readonly run: () => void;
}

export interface PaletteBuildInput {
  readonly query: string;
  readonly sections: readonly AppSection[];
  readonly canSyncAll: boolean;
  readonly canMarkAllRead: boolean;
  readonly actions: {
    readonly navigate: (path: string) => void;
    readonly triggerFullSync: () => void;
    readonly markAllRead: () => void;
  };
  readonly search: GlobalSearchResponse | undefined;
}

function matchesQuery(text: string, query: string): boolean {
  return query.trim() === "" || text.toLowerCase().includes(query.trim().toLowerCase());
}

export function buildPaletteItems(input: PaletteBuildInput): readonly PaletteItem[] {
  const items: PaletteItem[] = [];
  const { query, sections, actions } = input;

  for (const section of sections) {
    if (!matchesQuery(`${section.label} ${section.description}`, query)) continue;
    items.push({
      id: `nav:${section.key}`,
      group: "Go to",
      label: section.label,
      hint: section.availability === "roadmap" ? `arrives in ${section.milestone ?? "a later milestone"}` : null,
      run: () => actions.navigate(section.path),
    });
  }

  if (input.canSyncAll && matchesQuery("trigger full sync refresh data catalog", query)) {
    items.push({ id: "action:full-sync", group: "Actions", label: "Trigger full data sync", hint: "re-pull all modules from Shopify", run: actions.triggerFullSync });
  }
  if (input.canMarkAllRead && matchesQuery("mark all notifications read", query)) {
    items.push({ id: "action:read-all", group: "Actions", label: "Mark all notifications as read", hint: null, run: actions.markAllRead });
  }

  const groups = input.search?.groups;
  if (groups !== undefined && query.trim().length >= 2) {
    for (const product of groups.products.items) {
      items.push({
        id: `product:${product.id}`,
        group: "Products",
        label: product.title,
        hint: product.status.toLowerCase(),
        run: () => actions.navigate(`/products/${product.id}`),
      });
    }
    for (const customer of groups.customers.items) {
      items.push({
        id: `customer:${customer.id}`,
        group: "Customers",
        label: customer.name,
        hint: customer.email,
        run: () => actions.navigate(`/customers/${customer.id}`),
      });
    }
    for (const order of groups.orders.items) {
      items.push({
        id: `order:${order.id}`,
        group: "Orders",
        label: order.name,
        hint: order.financialStatus?.toLowerCase() ?? null,
        run: () => actions.navigate(`/orders/${order.id}`),
      });
    }
  }
  return items;
}

const DEBOUNCE_MS = 250;

export function useDebouncedValue(value: string, delayMs: number = DEBOUNCE_MS): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const GROUP_ICONS: Record<string, ReactNode> = {
  Products: <Package className="size-3.5" aria-hidden />,
  Customers: <Users className="size-3.5" aria-hidden />,
  Orders: <ShoppingCart className="size-3.5" aria-hidden />,
  Actions: <Zap className="size-3.5" aria-hidden />,
};

export function CommandPalette({
  open,
  onClose,
  sections,
  canSyncAll,
  canMarkAllRead,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly sections: readonly AppSection[];
  readonly canSyncAll: boolean;
  readonly canMarkAllRead: boolean;
}): ReactNode {
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const debounced = useDebouncedValue(query);
  const searchQuery = useGlobalSearchQuery(debounced);
  const fullSync = useTriggerFullSyncMutation();
  const markAll = useMarkAllNotificationsReadMutation();

  const runFullSync = useCallback(() => {
    fullSync.mutate(undefined, {
      onSuccess: () => toast.success("Full sync scheduled", "All modules will refresh from Shopify in the background."),
      onError: (error: ApiError) => toast.error("Sync could not be started", error.message),
    });
  }, [fullSync, toast]);

  const runMarkAll = useCallback(() => {
    markAll.mutate(undefined, {
      onSuccess: () => toast.success("Notifications cleared", "Every notification is now marked as read."),
      onError: (error: ApiError) => toast.error("Could not mark notifications", error.message),
    });
  }, [markAll, toast]);

  const actions = useMemo(
    () => ({
      navigate: (path: string) => {
        onClose();
        navigate(path);
      },
      triggerFullSync: () => {
        onClose();
        runFullSync();
      },
      markAllRead: () => {
        onClose();
        runMarkAll();
      },
    }),
    [navigate, onClose, runFullSync, runMarkAll],
  );

  const items = useMemo(
    () =>
      buildPaletteItems({
        query,
        sections,
        canSyncAll,
        canMarkAllRead,
        actions,
        search: debounced.trim().length >= 2 ? searchQuery.data : undefined,
      }),
    [query, sections, canSyncAll, canMarkAllRead, actions, debounced, searchQuery.data],
  );

  // Reset interaction state each time the palette opens / results change.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [open]);

  useEffect(() => setHighlight(0), [query, items.length]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const element = listRef.current?.querySelector(
        `[data-index="${String(Math.min(highlight, items.length - 1))}"]`,
      );
      // jsdom + very old WebViews lack scrollIntoView — degrade silently.
      if (element !== null && element !== undefined && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "nearest" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [highlight, items.length, open]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((prev) => (items.length === 0 ? 0 : (prev + 1) % items.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((prev) => (items.length === 0 ? 0 : (prev - 1 + items.length) % items.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[highlight];
      if (item !== undefined) item.run();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  let group = "";
  return (
    <div className="fixed inset-0 z-[var(--pf-z-modal,70)]" role="presentation" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="absolute inset-x-0 top-[12vh] mx-auto w-full max-w-xl overflow-hidden rounded-xl border border-subtle bg-surface-solid shadow-[var(--shadow-modal)] animate-[pf-modal-in_var(--transition-base)]"
      >
        <div className="flex items-center gap-3 border-b border-subtle px-4">
          <Search className="size-4 shrink-0 text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages, products, customers, orders — or run an action"
            aria-label="Command palette search"
            className="h-12 w-full bg-transparent text-sm text-foreground placeholder:text-faint focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-faint">
            ESC
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-2">
          {items.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">
              {debounced.trim().length >= 2
                ? `No pages, records or actions match "${query}".`
                : "Type to filter pages — two or more characters also searches your store data."}
            </p>
          )}
          {items.map((item, index) => {
            const showGroup = item.group !== group;
            group = item.group;
            return (
              <div key={item.id}>
                {showGroup && (
                  <p className="flex items-center gap-1.5 px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                    {GROUP_ICONS[item.group]}
                    {item.group}
                  </p>
                )}
                <button
                  type="button"
                  data-index={index}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => item.run()}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-[13px] transition-colors ${
                    index === highlight ? "bg-primary-soft text-foreground" : "text-muted"
                  }`}
                >
                  <span className="truncate">{item.label}</span>
                  {item.hint !== null && <span className="shrink-0 text-[11px] text-faint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
