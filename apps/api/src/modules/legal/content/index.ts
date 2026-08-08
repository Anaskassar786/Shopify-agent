import type { LegalDocument } from "./types";
import { ACCEPTABLE_USE_POLICY } from "./acceptable-use";
import { PRIVACY_POLICY } from "./privacy";
import { REFUND_POLICY } from "./refunds";
import { SECURITY_POLICY } from "./security";
import { TERMS_OF_SERVICE } from "./terms";

/**
 * The published legal set (P7: privacy · terms · refund · acceptable use ·
 * security). Order defines the /legal index and its review-checklist anchors;
 * slugs are stable URLs forever.
 */
export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
  REFUND_POLICY,
  ACCEPTABLE_USE_POLICY,
  SECURITY_POLICY,
];

const BY_SLUG = new Map(LEGAL_DOCUMENTS.map((doc) => [doc.slug, doc]));

export function legalDocumentBySlug(slug: string): LegalDocument | null {
  return BY_SLUG.get(slug) ?? null;
}
