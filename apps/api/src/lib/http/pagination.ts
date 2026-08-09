/**
 * Shared offset-pagination parsing (P2 list contract). Semantics pinned by
 * the integration suites: malformed values fall back to defaults, page clamps
 * to >= 1, page size clamps to 1..100. Extracted in M3 — catalog + sync +
 * notifications + search + audit all consume this one implementation (DRY).
 */
export interface PageParams {
  readonly page: number;
  readonly pageSize: number;
}

export const PAGINATION_DEFAULTS = {
  page: 1,
  pageSize: 25,
  maxPageSize: 100,
} as const;

export function parsePageParams(query: Record<string, unknown>): PageParams {
  const page = Math.max(Number(query["page"] ?? PAGINATION_DEFAULTS.page) || PAGINATION_DEFAULTS.page, 1);
  const pageSize = Math.min(
    Math.max(Number(query["limit"] ?? PAGINATION_DEFAULTS.pageSize) || PAGINATION_DEFAULTS.pageSize, 1),
    PAGINATION_DEFAULTS.maxPageSize,
  );
  return { page, pageSize };
}
