/**
 * Uniform API envelope — PART 2 ("RESPONSE FORMAT") contract.
 * Every REST endpoint in apps/api MUST respond with one of these shapes.
 * Frontend code relies on the discriminator `success` for type narrowing.
 */

export interface PaginationMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface ApiMeta {
  readonly pagination?: PaginationMeta;
  /** Arbitrary, well-typed extras (e.g. cache status, sync freshness). */
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface ApiErrorItem {
  /** Machine-readable code from the server ErrorCodes registry. */
  readonly code: string;
  /** Human-readable, user-presentable message. */
  readonly message: string;
  /** Dotted field path for validation failures, e.g. "settings.timezone". */
  readonly field?: string;
  /** Optional structured details safe to expose to clients. */
  readonly details?: Readonly<Record<string, unknown>>;
}

interface EnvelopeBase {
  readonly message: string;
  readonly meta: ApiMeta | null;
  readonly timestamp: string;
  readonly requestId: string;
}

export interface ApiSuccessResponse<TData> extends EnvelopeBase {
  readonly success: true;
  readonly data: TData;
  readonly errors: null;
}

export interface ApiErrorResponse extends EnvelopeBase {
  readonly success: false;
  readonly data: null;
  readonly errors: readonly ApiErrorItem[];
}

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;
