import type { ApiErrorItem } from "@profit/types";

/**
 * Error taxonomy (P1/P2). Every thrown domain/infra error SHOULD be one of these
 * subclasses so the global handler can map it to a structured envelope without
 * leaking internals. Rule: messages of 5xx errors are NEVER exposed to clients
 * unless explicitly marked `expose`.
 */

export const ErrorCode = {
  ValidationFailed: "VALIDATION_FAILED",
  AuthenticationFailed: "AUTHENTICATION_FAILED",
  Forbidden: "FORBIDDEN",
  NotFound: "NOT_FOUND",
  Conflict: "CONFLICT",
  RateLimited: "RATE_LIMITED",
  ShopifyApi: "SHOPIFY_API_ERROR",
  Database: "DATABASE_ERROR",
  AiProvider: "AI_PROVIDER_ERROR",
  Queue: "QUEUE_ERROR",
  Billing: "BILLING_ERROR",
  /** M5: subscription state blocks a revenue action (trial ended / cancelled / suspended). */
  UpgradeRequired: "UPGRADE_REQUIRED",
  /** M5: a plan quota is exhausted for the current period (details carry meter/limit/used). */
  QuotaExceeded: "QUOTA_EXCEEDED",
  /** M5: the Shopify charge provider is not configured — never a fake charge. */
  BillingUnavailable: "BILLING_UNAVAILABLE",
  MaintenanceMode: "MAINTENANCE_MODE",
  /** Launch readiness (ADR 37): a per-merchant feature flag blocks this capability. */
  FeatureDisabled: "FEATURE_DISABLED",
  /** M7: express.json rejected an over-budget body before application code ran. */
  PayloadTooLarge: "PAYLOAD_TOO_LARGE",
  Internal: "INTERNAL_ERROR",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  readonly message: string;
  readonly httpStatus: number;
  /** Client-safe structured context. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Field-level items for validation responses. */
  readonly fieldErrors?: readonly ApiErrorItem[];
  /** When false (or 5xx default) the client receives a generic message. */
  readonly expose?: boolean;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly fieldErrors: readonly ApiErrorItem[];
  readonly expose: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    if (options.details !== undefined) this.details = options.details;
    this.fieldErrors = options.fieldErrors ?? [];
    this.expose = options.expose ?? options.httpStatus < 500;
  }

  toErrorItem(): ApiErrorItem {
    const base: ApiErrorItem = { code: this.code, message: this.message };
    if (this.details === undefined) return base;
    return { ...base, details: this.details };
  }
}

function clientError(
  code: ErrorCode,
  httpStatus: number,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  fieldErrors?: readonly ApiErrorItem[],
): AppError {
  return new AppError(code, {
    httpStatus,
    message,
    expose: true,
    ...(details !== undefined ? { details } : {}),
    ...(fieldErrors !== undefined ? { fieldErrors } : {}),
  });
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", fieldErrors: readonly ApiErrorItem[] = []) {
    super(ErrorCode.ValidationFailed, { httpStatus: 400, message, expose: true, fieldErrors });
    this.name = "ValidationError";
  }

  static fromZod(issues: ReadonlyArray<{ path: PropertyKey[]; message: string; code: string }>): ValidationError {
    const fieldErrors: ApiErrorItem[] = issues.map((issue) => ({
      code: ErrorCode.ValidationFailed,
      message: issue.message,
      field: issue.path.map(String).join(".") || "(root)",
      details: { zodCode: issue.code },
    }));
    return new ValidationError("Request validation failed", fieldErrors);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required", details?: Readonly<Record<string, unknown>>) {
    super(ErrorCode.AuthenticationFailed, { httpStatus: 401, message, expose: true, ...(details !== undefined ? { details } : {}) });
    this.name = "AuthenticationError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions", details?: Readonly<Record<string, unknown>>) {
    super(ErrorCode.Forbidden, { httpStatus: 403, message, expose: true, ...(details !== undefined ? { details } : {}) });
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(entity = "Resource", id?: string) {
    super(ErrorCode.NotFound, {
      httpStatus: 404,
      message: `${entity} not found`,
      expose: true,
      ...(id !== undefined ? { details: { id } } : {}),
    });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(ErrorCode.Conflict, { httpStatus: 409, message, expose: true, ...(details !== undefined ? { details } : {}) });
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(ErrorCode.RateLimited, {
      httpStatus: 429,
      message: "Too many requests",
      expose: true,
      details: { retryAfterSeconds },
    });
    this.name = "RateLimitError";
  }
}

export class ShopifyApiError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(ErrorCode.ShopifyApi, {
      httpStatus: 502,
      message,
      expose: true,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "ShopifyApiError";
  }
}

export class DatabaseError extends AppError {
  constructor(cause?: unknown) {
    super(ErrorCode.Database, {
      httpStatus: 500,
      message: "A database error occurred",
      expose: false,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "DatabaseError";
  }
}

export class AiProviderError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(ErrorCode.AiProvider, {
      httpStatus: 502,
      message,
      expose: true,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "AiProviderError";
  }
}

export class QueueError extends AppError {
  constructor(cause?: unknown) {
    super(ErrorCode.Queue, {
      httpStatus: 500,
      message: "A queue error occurred",
      expose: false,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "QueueError";
  }
}

export class BillingError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(ErrorCode.Billing, {
      httpStatus: 502,
      message,
      expose: true,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "BillingError";
  }
}

export class MaintenanceError extends AppError {
  constructor(message = "Service temporarily unavailable for maintenance") {
    super(ErrorCode.MaintenanceMode, { httpStatus: 503, message, expose: true });
    this.name = "MaintenanceError";
  }
}

/** Launch readiness (ADR 37): capability disabled for this store by an operator flag. */
export class FeatureDisabledError extends AppError {
  constructor(feature: string) {
    super(ErrorCode.FeatureDisabled, {
      httpStatus: 503,
      message: `${feature} is temporarily disabled for this store. Contact support if you did not expect this.`,
      expose: true,
      details: { feature },
    });
    this.name = "FeatureDisabledError";
  }
}

/** M5: structured entitlement failure — the web layer renders the upgrade CTA from this. */
export class EntitlementError extends AppError {
  constructor(
    code: typeof ErrorCode.UpgradeRequired | typeof ErrorCode.QuotaExceeded,
    message: string,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(code, { httpStatus: 403, message, expose: true, details });
    this.name = "EntitlementError";
  }
}

/** M5: no charge provider configured — subscribe is honestly unavailable, never simulated. */
export class BillingUnavailableError extends AppError {
  constructor(message = "Billing charges are not configured for this environment") {
    super(ErrorCode.BillingUnavailable, { httpStatus: 503, message, expose: true });
    this.name = "BillingUnavailableError";
  }
}

/** Unified mapper used by middleware to test client-error shape. */
export function asClientError(code: ErrorCode, message: string): AppError {
  return clientError(code, 400, message);
}
