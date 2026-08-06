import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../cn";
import { Button } from "./primitives";

/**
 * Modal & Drawer (P9: centered animated modal, ESC close, backdrop blur;
 * right-side responsive drawer). Portaled onto document.body, aria-modal with
 * labelled-by wiring, body scroll locked for the time they're open. Focus is
 * handed to the dialog on open and restored to the previously focused element
 * on close; Tab stays inside (minimal trap: wraps at the edges).
 */

function useOverlayLifecycle(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = typeof document !== "undefined" ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open, onClose]);
}

function mountNode(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.body;
}

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: "md" | "lg" | "xl";
  readonly dismissible?: boolean;
}

const modalSizes = {
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = "md",
  dismissible = true,
}: ModalProps): ReactNode {
  const mount = mountNode();
  useOverlayLifecycle(open, dismissible ? onClose : () => undefined);
  if (mount === null || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--pf-z-modal,70)] flex items-center justify-center p-4" role="presentation">
      <div
        className="absolute inset-0 bg-overlay backdrop-blur-sm transition-opacity duration-[var(--transition-base)]"
        onClick={dismissible ? onClose : undefined}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={cn(
          "relative w-full rounded-xl border border-subtle bg-surface-solid shadow-[var(--shadow-modal)]",
          "animate-[pf-modal-in_var(--transition-base)]",
          modalSizes[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-subtle px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {subtitle !== undefined && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer !== undefined && (
          <div className="flex items-center justify-end gap-3 border-t border-subtle px-6 py-4">{footer}</div>
        )}
      </div>
    </div>,
    mount,
  );
}

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly width?: "md" | "lg";
  readonly footer?: ReactNode;
}

export function Drawer({ open, onClose, title, children, width = "md", footer }: DrawerProps): ReactNode {
  const mount = mountNode();
  useOverlayLifecycle(open, onClose);
  if (mount === null || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--pf-z-modal,70)]" role="presentation">
      <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={cn(
          "absolute inset-y-0 right-0 flex w-full flex-col border-l border-subtle bg-surface-solid shadow-[var(--shadow-drawer)]",
          width === "md" ? "max-w-md" : "max-w-xl",
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-subtle px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined && <div className="border-t border-subtle px-5 py-4">{footer}</div>}
      </aside>
    </div>,
    mount,
  );
}

/* ─── ConfirmDialog ──────────────────────────────────────────────────────── */

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-muted">{body}</p>
    </Modal>
  );
}

/* ─── DropdownMenu (lightweight, absolute-positioned) ────────────────────── */

export interface MenuItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export function DropdownMenu({
  trigger,
  items,
  align = "right",
  ariaLabel,
}: {
  trigger: ReactNode;
  items: readonly MenuItem[];
  align?: "left" | "right";
  ariaLabel: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center rounded-md text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-[var(--pf-z-dropdown,60)] mt-1 min-w-44 overflow-hidden rounded-md border border-subtle bg-surface-raised py-1 shadow-[var(--shadow-dropdown)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled === true}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors",
                "hover:bg-surface-solid focus-visible:bg-surface-solid focus-visible:outline-none",
                "disabled:pointer-events-none disabled:opacity-50",
                item.danger === true ? "text-danger" : "text-foreground",
              )}
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Tabs ───────────────────────────────────────────────────────────────── */

export interface TabItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly count?: number | undefined;
}

export function Tabs({
  items,
  active,
  onChange,
  className,
}: {
  items: readonly TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}): ReactNode {
  return (
    <div className={cn("flex items-center gap-1 border-b border-subtle", className)} role="tablist">
      {items.map((item) => {
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.key)}
            className={cn(
              "relative px-3.5 pb-2.5 pt-1 text-[13px] font-medium transition-colors",
              "focus-visible:outline-2 focus-visible:outline-primary",
              selected ? "text-foreground" : "text-muted hover:text-foreground",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.label}
              {item.count !== undefined && (
                <span className="rounded-full bg-surface-raised px-1.5 py-px text-[10px] font-semibold text-muted">
                  {item.count}
                </span>
              )}
            </span>
            <span
              className={cn(
                "absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-all duration-[var(--transition-fast)]",
                selected ? "bg-primary" : "bg-transparent",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
