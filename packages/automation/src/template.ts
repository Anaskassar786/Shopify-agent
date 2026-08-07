/**
 * Server-side message templating (M6). `{{ path.to.value }}` interpolation
 * against a CLOSED variable catalog — templates can never execute code or
 * reach outside the provided context (no eval, no prototype walk, no
 * arbitrary key lookup). HTML contexts escape interpolated values; text
 * contexts substitute verbatim. Unknown variables fail validation at
 * save-time and render as "" (never crash a send).
 */

export interface TemplateStoreContext {
  readonly name: string;
  readonly domain: string;
}

export interface TemplateCustomerContext {
  readonly firstName?: string | null | undefined;
  readonly lastName?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly ordersCount?: number | undefined;
  readonly totalSpent?: string | undefined;
}

/** The full catalog. Keep in sync with TEMPLATE_VARIABLE_PATHS. */
export interface MessageTemplateContext {
  readonly store: TemplateStoreContext;
  readonly customer?: TemplateCustomerContext | null;
  readonly campaign?: { readonly name: string } | null;
  readonly workflow?: { readonly name: string } | null;
  readonly unsubscribeUrl?: string | null;
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9.]*)\s*\}\}/g;

interface VariableSpec {
  readonly path: string;
  readonly resolve: (ctx: MessageTemplateContext) => string;
}

const trim = (value: string): string => value.trim();
const empty = "";

function fullName(customer: TemplateCustomerContext | null | undefined): string {
  if (customer === null || customer === undefined) return empty;
  return trim(`${customer.firstName ?? ""} ${customer.lastName ?? ""}`);
}

/**
 * Closed variable catalog — the ONLY paths a template may reference.
 * Validation rejects anything outside this list.
 */
const VARIABLES: readonly VariableSpec[] = [
  { path: "store.name", resolve: (ctx) => ctx.store.name },
  { path: "store.domain", resolve: (ctx) => ctx.store.domain },
  { path: "customer.firstName", resolve: (ctx) => ctx.customer?.firstName ?? empty },
  { path: "customer.lastName", resolve: (ctx) => ctx.customer?.lastName ?? empty },
  { path: "customer.fullName", resolve: (ctx) => fullName(ctx.customer) },
  { path: "customer.email", resolve: (ctx) => ctx.customer?.email ?? empty },
  {
    path: "customer.ordersCount",
    resolve: (ctx) =>
      ctx.customer?.ordersCount !== undefined ? String(ctx.customer.ordersCount) : empty,
  },
  { path: "customer.totalSpent", resolve: (ctx) => ctx.customer?.totalSpent ?? empty },
  { path: "campaign.name", resolve: (ctx) => ctx.campaign?.name ?? empty },
  { path: "workflow.name", resolve: (ctx) => ctx.workflow?.name ?? empty },
  { path: "unsubscribeUrl", resolve: (ctx) => ctx.unsubscribeUrl ?? empty },
];

const VARIABLE_MAP: ReadonlyMap<string, VariableSpec> = new Map(
  VARIABLES.map((spec) => [spec.path, spec]),
);

/** Documented, UI-enumerable catalog (builder autocomplete + M6 doc table). */
export const TEMPLATE_VARIABLE_PATHS: readonly string[] = VARIABLES.map((v) => v.path);

/** Unknown variable paths found in `input` (deduped, sorted). */
export function validateTemplateVars(input: string): readonly string[] {
  const unknown = new Set<string>();
  for (const match of input.matchAll(VARIABLE_PATTERN)) {
    const path = match[1];
    if (path !== undefined && !VARIABLE_MAP.has(path)) unknown.add(path);
  }
  return [...unknown].sort();
}

export function isTemplateValid(input: string): boolean {
  return validateTemplateVars(input).length === 0;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface RenderOptions {
  /** Escape interpolated values for an HTML body. Default false (text). */
  readonly html?: boolean;
}

/** Render a template against the catalog. Unknown variables render as "". */
export function renderTemplate(
  input: string,
  context: MessageTemplateContext,
  options?: RenderOptions,
): string {
  const escape = options?.html === true;
  return input.replace(VARIABLE_PATTERN, (_whole, rawPath: string) => {
    const spec = VARIABLE_MAP.get(rawPath);
    if (spec === undefined) return empty;
    const value = spec.resolve(context);
    return escape ? escapeHtml(value) : value;
  });
}
