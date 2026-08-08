import type { LegalDocument } from "./types";

/**
 * Privacy Policy — written against the ACTUAL data flows of this codebase
 * (tenant-scoped replica, GDPR mandatory webhooks, M6 data export, RLS
 * isolation), not a generic template. Counsel review before submission is
 * tracked in docs/appstore/review-checklist.md.
 */
export const PRIVACY_POLICY: LegalDocument = {
  slug: "privacy",
  title: "Privacy Policy",
  effectiveDate: "2026-08-07",
  version: 1,
  summary: "What data we collect from merchants and their customers, why, how it is protected, and the rights you have over it.",
  sections: [
    {
      heading: "1. Who we are and what this policy covers",
      paragraphs: [
        "{entity} (\"we\", \"us\", \"the platform\") operates PROFIT TOOL AI, an AI decision-support and revenue-automation application for Shopify merchants (\"the app\"). This policy describes how we collect, use, store, share, and delete information when a merchant installs and uses the app, and when the app processes data about the merchant's customers on the merchant's behalf. It applies to the app itself, the merchant dashboard, the platform-admin console, and the public pages served from {appUrl}.",
        "Installing merchants are the data controllers for their store and customer data; we act as a data processor on their documented instructions. For our own business data (merchant accounts, billing relationships, platform telemetry) we are the data controller.",
      ],
    },
    {
      heading: "2. Information we collect",
      paragraphs: ["We collect only what the app's stated features require:"],
      list: [
        "Merchant account data: Shopify shop domain, store name, merchant email addresses of staff users who log in, user roles, and authentication credentials we issue (hashed refresh tokens).",
        "Store operational data, replicated through the Shopify API after you grant scopes: products, collections, orders, customers, inventory levels, discounts, price rules, refunds, fulfillments, checkouts, and draft orders. This replica is what powers analytics, AI recommendations, and automations.",
        "Usage and product telemetry: feature usage events, funnel milestones, audit-log actions (who did what, when, with what outcome), and aggregated daily metrics.",
        "Support data: support tickets, their messages, and — for platform operators acting on a ticket — time-boxed access records named below.",
        "Campaign data: message templates, campaign configurations, per-recipient delivery status, and engagement events (opens, clicks, unsubscribes) recorded through signed tracking endpoints.",
        "Billing data: subscription status, plan identifiers, trial windows, Shopify charge identifiers produced by the Shopify Billing API, and usage-meter rollups. We never see or store payment card numbers: charges are created, accepted, and settled entirely inside Shopify.",
        "Technical logs: request ids, IP addresses, user agents, and error diagnostics retained in short-lived operational logs.",
      ],
    },
    {
      heading: "3. How we use information",
      paragraphs: ["We use the information above exclusively to provide and operate the service:"],
      list: [
        "Compute analytics, store-health metrics, and AI recommendations for your store.",
        "Execute merchant-approved automations: workflows, email/SMS campaigns, discounts, and customer tagging in your Shopify store.",
        "Deliver transactional service email (welcome, trial reminders, payment outcome notices, security alerts).",
        "Operate billing, trials, entitlements, and usage metering through the Shopify Billing API.",
        "Provide merchant support, including time-boxed operator access responses when you open a ticket.",
        "Maintain security and abuse prevention: audit trails, rate limiting, session management, and platform-admin access logging.",
        "Meet legal obligations, including GDPR data-request, erasure, and redaction duties.",
      ],
    },
    {
      heading: "4. AI processing",
      paragraphs: [
        "AI recommendations are generated from a minimized business context: aggregated, numeric store metrics and catalog facts. Recommendation prompts never include your customers' names, email addresses, phone numbers, street addresses, or payment details. All monetary figures, counts, and order references shown in recommendations are computed by deterministic rules and database queries, not by the AI model.",
        "AI requests are logged with model, prompt version, token counts, and metered cost for your review in the AI activity surfaces. We do not use your store data to train foundation models.",
      ],
    },
    {
      heading: "5. How we share information (subprocessors)",
      paragraphs: ["We share data only with the categories of service providers required to run the app, under contractual confidentiality:"],
      list: [
        "Shopify, Inc. — the commerce platform the app is embedded in; store data originates from and actions are written back to Shopify under your granted API scopes.",
        "Cloud hosting provider — infrastructure hosting for the application and its PostgreSQL database (region selected at deployment).",
        "AI model provider (Google Gemini API) — receives only the minimized, non-PII business context described in section 4.",
        "Email delivery provider — SMTP delivery of transactional and campaign email you configure.",
        "SMS delivery provider (Twilio) — only when you use SMS features; receives recipient phone numbers and message bodies for the messages you send.",
        "Error-monitoring provider — only if enabled at deployment; receives error diagnostics scrubbed of secrets.",
      ],
      paragraphsAfterList: [
        "We do not sell merchant or customer personal data, and we do not share it for third-party advertising. We may disclose information when legally compelled (court order, lawful request) after assessing validity, or to protect the rights, safety, and security of merchants, their customers, or the platform.",
      ],
    },
    {
      heading: "6. Data isolation and security",
      paragraphs: [
        "Every business record in our database carries a store identifier; every request is scoped to the authenticated tenant by application middleware and, as a second defense, by PostgreSQL row-level security policies. Cross-tenant access is technically tested in our continuous test suites.",
        "Shopify access tokens are stored encrypted with AES-256-GCM and are never exposed to the browser or returned by any API. Secrets are held in environment configuration, never in source code or logs; log statements exclude tokens, secrets, and payment information by enforced convention. Transport is encrypted with TLS in production. Session credentials are short-lived JWTs with refresh-token rotation and reuse detection that revokes the full session chain on replay.",
      ],
    },
    {
      heading: "7. Marketing messages, tracking, and your customers",
      paragraphs: [
        "When you send email or SMS campaigns through the app, messages include an unsubscribe mechanism appended by the platform. Opens, clicks, and unsubscribes are recorded through signed, unauthenticated tracking endpoints whose tokens carry no email address and no store identifier. Unsubscribed destinations are written to a suppression ledger that every future send honors automatically, across all of your campaigns.",
        "You are responsible for having a lawful basis to message your customers and for honoring their choices; the platform enforces the technical side of suppression for you.",
      ],
    },
    {
      heading: "8. Data retention",
      paragraphs: [
        "We retain store data while the app is installed and your subscription is active. When you uninstall, Shopify notifies us immediately and we delete your store's access tokens and queued work without delay; operational, analytics, and ledger data tied to your store is then purged on a scheduled deletion cycle unless a longer retention is required by law (for example, financial or dispute records).",
        "Short-lived artifacts expire automatically: exports you generate, workflow run records, and webhook delivery logs follow bounded retention windows. Backups are encrypted and rotate on the same schedule as our hosting provider's backup policy; deleted data disappears from backups as they rotate.",
      ],
    },
    {
      heading: "9. Your rights and data rights of your customers (GDPR/CCPA)",
      paragraphs: [
        "Merchants (and, through merchants, their customers in the EEA, UK, Switzerland, and California) have the right to access, correct, export, and delete personal data, to object to or restrict processing, and to data portability.",
        "The app implements the mandatory Shopify privacy webhooks end-to-end: a customers/data_request is recorded for the platform's export workflow, a customers/redact request triggers deletion of that customer's personal data from the replica, and a shop/redact request after uninstall triggers full store deletion. You can also export your own data at any time from the in-app Exports page (customers, orders, products, recommendations, and audit logs, in CSV/XLSX/PDF) and can close your account by uninstalling the app.",
        "Requests can also be sent to us directly; see section 12. We honor verified requests within 30 days.",
      ],
    },
    {
      heading: "10. Cookies",
      paragraphs: [
        "The embedded app runs inside Shopify Admin and uses session tokens, not cookies, for authentication. We do not set tracking cookies and we do not use third-party advertising cookies. Any strictly necessary storage is browser session storage for interface state only.",
      ],
    },
    {
      heading: "11. International transfers and children",
      paragraphs: [
        "Store data may be processed in the region where our infrastructure is deployed; where data is transferred internationally, transfers rely on the subprocessor's applicable safeguards (such as standard contractual clauses). The app is a business tool and is not directed at children; we do not knowingly collect personal data from children under 16.",
      ],
    },
    {
      heading: "12. Contact and changes",
      paragraphs: [
        "Privacy questions, access requests, and deletion requests: {supportEmail}. We respond within 30 days. If you believe we have not resolved a concern, you may complain to your local data-protection authority.",
        "We may update this policy as the product evolves. Material changes are announced in the app before they take effect, and the effective date above always reflects the current text. The version history is available in the app's public source repository.",
      ],
    },
  ],
};
