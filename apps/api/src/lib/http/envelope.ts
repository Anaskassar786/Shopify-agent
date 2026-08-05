import type {
  ApiErrorItem,
  ApiErrorResponse,
  ApiMeta,
  ApiSuccessResponse,
  PaginationMeta,
} from "@profit/types";

/**
 * Response envelope builders (P2 RESPONSE FORMAT). Controllers MUST respond
 * via these builders so every endpoint shares one contract — including the
 * `requestId` that the frontend renders in error states (P9 "Error ID").
 */

export interface EnvelopeContext {
  readonly requestId: string;
}

export interface SuccessOptions {
  readonly message?: string;
  readonly meta?: ApiMeta;
}

export interface ErrorOptions {
  readonly message?: string;
}

export function successEnvelope<TData>(
  ctx: EnvelopeContext,
  data: TData,
  options: SuccessOptions = {},
): ApiSuccessResponse<TData> {
  return {
    success: true,
    message: options.message ?? "OK",
    data,
    meta: options.meta ?? null,
    errors: null,
    timestamp: new Date().toISOString(),
    requestId: ctx.requestId,
  };
}

export function errorEnvelope(
  ctx: EnvelopeContext,
  errors: readonly ApiErrorItem[],
  options: ErrorOptions = {},
): ApiErrorResponse {
  return {
    success: false,
    message: options.message ?? "Request failed",
    data: null,
    meta: null,
    errors,
    timestamp: new Date().toISOString(),
    requestId: ctx.requestId,
  };
}

export function paginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
): PaginationMeta {
  const totalPages = pageSize > 0 ? Math.ceil(totalItems / pageSize) : 0;
  return { page, pageSize, totalItems, totalPages };
}

/** Build an ApiMeta carrying pagination for list endpoints. */
export function listMeta(
  page: number,
  pageSize: number,
  totalItems: number,
): ApiMeta {
  return { pagination: paginationMeta(page, pageSize, totalItems) };
}
