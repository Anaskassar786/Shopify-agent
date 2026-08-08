import type { LegalDocument } from "./types";

/** Refund Policy — aligned to how Shopify app charges actually settle. */
export const REFUND_POLICY: LegalDocument = {
  slug: "refunds",
  title: "Refund Policy",
  effectiveDate: "2026-08-07",
  version: 1,
  summary: "How refunds work for subscriptions and usage charges billed through the Shopify Billing API.",
  sections: [
    {
      heading: "1. Where billing happens",
      paragraphs: [
        "All charges for PROFIT TOOL AI — subscriptions and usage-based components — are created and settled through the Shopify Billing API on Shopify's checkout and invoicing surfaces. We never take card details. Refunds are therefore issued as credits or refunds against Shopify application charges, and appear on your Shopify invoice.",
      ],
    },
    {
      heading: "2. Free trial",
      paragraphs: [
        "Where a free trial applies, you can evaluate the full plan during the trial window and you are not charged if you cancel before it ends. Days already consumed past the trial convert under the plan's normal billing terms.",
      ],
    },
    {
      heading: "3. Eligible refunds",
      paragraphs: ["We grant refunds or credits in these cases:"],
      list: [
        "Duplicate or erroneous charges — a charge created in error (for example, a duplicated application charge) is refunded in full once verified.",
        "Material service failure — a confirmed, sustained outage or defect on our side that made the paid service substantially unusable for more than 72 consecutive hours in a billing period: prorated credit for the affected period on request.",
        "Material feature reduction — if we remove a paid feature you rely on during a paid period and you choose to cancel for that reason: prorated refund of the unused prepaid time for the affected plan component.",
        "First-billing-cycle goodwill — if you are charged for the first time after a trial and contact us within 7 days because the app is not a fit, we will refund that first charge as a one-time courtesy.",
      ],
    },
    {
      heading: "4. What is not refundable",
      paragraphs: [
        "Partial-month use after the first billing cycle, unused quotas or AI/usage balances, charges for periods already consumed, and amounts attributable to store performance or business outcomes. AI recommendations and analytics are analytical outputs; dissatisfaction with business results is not a billing defect.",
      ],
    },
    {
      heading: "5. How to request",
      paragraphs: [
        "Email {supportEmail} from the store owner's address (or open a ticket in the app's support center) with the shop domain, the invoice or charge date, and the reason. We acknowledge within 2 business days. Approved refunds are issued against the Shopify charge and settle on your next Shopify invoice; Shopify does not move cash backward through older invoices.",
      ],
    },
    {
      heading: "6. Statutory rights",
      paragraphs: [
        "Where consumer-protection or distance-selling law grants you rights beyond this policy (for example, a statutory withdrawal right where it applies to business consumers), this policy adds to those rights and never reduces them.",
      ],
    },
  ],
};
