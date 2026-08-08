/**
 * Legal document model (M7 legal plane, ADR 25). Documents are typed data —
 * never freeform HTML — so the renderer is the single escaping authority and
 * every published page provably passes through it (no XSS surface, no
 * hand-edited markup drift). `{tokens}` are substituted at render time from
 * deployment config (entity name, support email, app URL), keeping the prose
 * environment-agnostic while the identity stays env-owned (P5: never hardcode
 * per-environment values).
 */

export interface LegalSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  /** Unordered bullet list, appended after the paragraphs when present. */
  readonly list?: readonly string[];
  /** Paragraphs rendered after the list (rare; keeps list semantics clean). */
  readonly paragraphsAfterList?: readonly string[];
}

export interface LegalDocument {
  /** URL slug under /legal (kebab-case, stable forever — review links depend on it). */
  readonly slug: string;
  readonly title: string;
  /** ISO date the current text took effect. */
  readonly effectiveDate: string;
  /** Monotonic document version (changelog lives in git). */
  readonly version: number;
  /** One-line summary shown on the /legal index card. */
  readonly summary: string;
  readonly sections: readonly LegalSection[];
}

/** Tokens interpolated into sections at render time. */
export interface LegalIdentity {
  readonly entityName: string;
  readonly supportEmail: string | null;
  readonly appUrl: string;
}
