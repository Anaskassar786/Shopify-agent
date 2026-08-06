import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, Sparkles, X } from "lucide-react";
import { cn } from "../cn";

/**
 * Toasts (P9: success/warning/error/info; AI tone for agent actions). A
 * headless store + viewport renderer; enqueueing is safe before the viewport
 * mounts (provider renders both). Auto-dismiss with manual close; maximum one
 * stack, newest on top.
 */

export type ToastTone = "success" | "warning" | "error" | "info" | "ai";

export interface Toast {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly body?: string | undefined;
  readonly durationMs?: number | undefined;
}

export interface ToastApi {
  readonly toast: (input: Omit<Toast, "id">) => string;
  readonly dismiss: (id: string) => void;
  readonly success: (title: string, body?: string) => string;
  readonly error: (title: string, body?: string) => string;
  readonly info: (title: string, body?: string) => string;
}

const ToastContext = createContext<ToastApi | null>(null);

const toneStyles: Record<ToastTone, { icon: ReactNode; ring: string }> = {
  success: { icon: <CheckCircle2 className="size-4 text-success" aria-hidden />, ring: "border-success/30" },
  warning: { icon: <AlertTriangle className="size-4 text-warning" aria-hidden />, ring: "border-warning/30" },
  error: { icon: <XCircle className="size-4 text-danger" aria-hidden />, ring: "border-danger/30" },
  info: { icon: <Info className="size-4 text-info" aria-hidden />, ring: "border-info/30" },
  ai: { icon: <Sparkles className="size-4 text-ai" aria-hidden />, ring: "border-ai/30" },
};

const DEFAULT_DURATION_MS = 4_500;
const MAX_VISIBLE = 5;

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: Omit<Toast, "id">): string => {
      counter.current += 1;
      const id = `toast-${String(counter.current)}`;
      const duration = input.durationMs ?? DEFAULT_DURATION_MS;
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { ...input, id }]);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, body) => toast({ tone: "success", title, body }),
      error: (title, body) => toast({ tone: "error", title, body }),
      info: (title, body) => toast({ tone: "info", title, body }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[var(--pf-z-toast,80)] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-lg border bg-surface-raised px-4 py-3 shadow-[var(--shadow-dropdown)]",
              toneStyles[item.tone].ring,
            )}
            role="status"
          >
            <div className="mt-0.5 shrink-0">{toneStyles[item.tone].icon}</div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-foreground">{item.title}</p>
              {item.body !== undefined && (
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{item.body}</p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(item.id)}
              className="shrink-0 rounded-md p-1 text-faint transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
