import type { LegalDocument } from "./types";

/** Acceptable Use Policy — the abuse boundary for the messaging/automation surface. */
export const ACCEPTABLE_USE_POLICY: LegalDocument = {
  slug: "acceptable-use",
  title: "Acceptable Use Policy",
  effectiveDate: "2026-08-07",
  version: 1,
  summary: "What you may not do with the service: unlawful content, spam, abuse, probing, and circumvention.",
  sections: [
    {
      heading: "1. Lawful use only",
      paragraphs: [
        "You may use PROFIT TOOL AI only for lawful purposes and in compliance with these Terms, Shopify's terms and acceptable-use rules, and all applicable laws — including marketing, privacy, consumer-protection, and anti-spam law (such as CAN-SPAM, CASL, GDPR/ePrivacy, TCPA) in every jurisdiction you message into.",
      ],
    },
    {
      heading: "2. Messaging rules (email/SMS)",
      paragraphs: ["When you send email or SMS through the service you must:"],
      list: [
        "Have a lawful basis to message every recipient (consent where required, or a valid existing-customer basis where the law allows it).",
        "Identify yourself truthfully — no forged sender identities, deceptive subjects, or misleading content.",
        "Honor opt-outs immediately. The platform appends unsubscribe handling automatically and enforces its suppression ledger on every send; you must not bypass, strip, or route around those mechanisms, and you must process opt-outs you receive outside the app promptly too.",
        "Keep complaint, bounce, and unsubscribe rates within industry norms; sustained abusive metrics are ground for suspension of messaging features.",
        "Not message purchased, rented, scraped, or otherwise third-party contact lists.",
      ],
    },
    {
      heading: "3. Prohibited content and conduct",
      paragraphs: ["You may not use the service to create, store, send, or promote:"],
      list: [
        "Content that is unlawful, defamatory, harassing, hateful, or incites violence or discrimination.",
        "Malware, phishing, or links to deceptive or malicious destinations, including cloaked tracking links.",
        "Infringing content (copyright, trademark, trade secret) or content violating privacy or publicity rights.",
        "Goods or categories barred by Shopify's own acceptable-use rules where your store operates.",
      ],
    },
    {
      heading: "4. Platform abuse",
      paragraphs: ["You may not:"],
      list: [
        "Probe, scan, or test the vulnerability of the service or any tenant without written consent, or breach authentication and isolation controls.",
        "Interfere with other tenants, the queueing system, rate limits, or infrastructure (including deliberate load floods).",
        "Reverse engineer the service except where the law permits interoperability regardless.",
        "Circumvent plan entitlements, usage quotas, billing, or trial boundaries, or resell access without our written agreement.",
        "Scrape the service systematically, or misuse exports and APIs to build a competing registry of merchant data.",
        "Use AI outputs in a way that misrepresents them as professional, legal, financial, or medical advice to third parties.",
      ],
    },
    {
      heading: "5. Enforcement",
      paragraphs: [
        "We may investigate suspected violations, remove offending content, suspend or rate-limit features (starting with the affected capability), suspend or terminate accounts, and report unlawful conduct to authorities. Where practicable we warn first and give a path to cure; severe or repeated violations lead to termination without refund under the Refund Policy's terms. Reports of abuse: {supportEmail}.",
      ],
    },
  ],
};
