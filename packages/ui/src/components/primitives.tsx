import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../cn";

/* ─── Button ─────────────────────────────────────────────────────────────── */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ai";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly iconLeft?: ReactNode;
  readonly iconRight?: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-on-primary shadow-[var(--shadow-card)] hover:bg-primary-strong active:translate-y-px",
  secondary:
    "bg-surface-raised text-foreground border border-subtle hover:border-strong active:translate-y-px",
  ghost: "text-muted hover:bg-surface-raised hover:text-foreground",
  danger:
    "bg-danger-soft text-danger border border-danger/30 hover:bg-danger/25 active:translate-y-px",
  ai: "bg-ai-soft text-ai border border-ai/30 hover:bg-ai/25 active:translate-y-px",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-[15px] gap-2.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, iconLeft, iconRight, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex select-none items-center justify-center rounded-md font-medium",
        "transition-all duration-[var(--transition-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:pointer-events-none disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        iconLeft
      )}
      {children}
      {iconRight}
    </button>
  );
});

/* ─── Badge ──────────────────────────────────────────────────────────────── */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "ai" | "primary";

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  readonly className?: string;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: "bg-surface-raised text-muted border-subtle",
  success: "bg-success-soft text-success border-success/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  info: "bg-info-soft text-info border-info/30",
  ai: "bg-ai-soft text-ai border-ai/30",
  primary: "bg-primary-soft text-primary border-primary/30",
};

export function Badge({ tone = "neutral", children, className }: BadgeProps): ReactNode {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ─── Card ───────────────────────────────────────────────────────────────── */

export interface CardProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Pointer affordance when the whole card is interactive. */
  readonly interactive?: boolean;
  readonly onClick?: () => void;
}

export function Card({ children, className, interactive = false, onClick }: CardProps): ReactNode {
  return (
    <div
      className={cn(
        "rounded-lg border border-subtle bg-surface-solid shadow-[var(--shadow-card)]",
        "transition-all duration-[var(--transition-base)]",
        interactive && "cursor-pointer hover:-translate-y-0.5 hover:border-strong",
        className,
      )}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive && onClick !== undefined
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}

export function CardHeader({ title, subtitle, actions, className }: CardHeaderProps): ReactNode {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-subtle px-5 py-4", className)}>
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
        {subtitle !== undefined && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

/* ─── Form primitives ────────────────────────────────────────────────────── */

const fieldBase =
  "w-full rounded-md border border-subtle bg-surface-raised px-3 text-sm text-foreground placeholder:text-faint " +
  "transition-colors duration-[var(--transition-fast)] focus:border-primary focus:outline-none disabled:opacity-50";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(fieldBase, "h-10", invalid && "border-danger focus:border-danger", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid = false, className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(fieldBase, "h-10 appearance-none pr-9 bg-[right_0.6rem_center] bg-no-repeat", invalid && "border-danger focus:border-danger", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239aa5c8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpath d='m6 9 6 6 6-6'/%3e%3c/svg%3e\")",
        backgroundSize: "1rem",
      }}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldBase, "min-h-24 py-2.5", invalid && "border-danger focus:border-danger", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});
