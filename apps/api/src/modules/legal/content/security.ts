import type { LegalDocument } from "./types";

/** Security Policy — public statement of the real controls (M1–M7) + disclosure channel. */
export const SECURITY_POLICY: LegalDocument = {
  slug: "security",
  title: "Security Policy",
  effectiveDate: "2026-08-07",
  version: 1,
  summary: "The technical and organizational controls protecting merchant data, and how to report a vulnerability.",
  sections: [
    {
      heading: "1. Scope",
      paragraphs: [
        "This policy describes the security posture of PROFIT TOOL AI as deployed and operated by {entity}: the embedded Shopify application, its API, background workers, data stores, and the platform-admin operations console. It summarizes the controls; detailed architecture and decision records are maintained in the project's engineering documentation.",
      ],
    },
    {
      heading: "2. Application and API security",
      paragraphs: [],
      list: [
        "Tenant isolation in depth: every business record carries a store identifier; application middleware scopes every request to the authenticated tenant, and PostgreSQL row-level security policies enforce the same boundary inside the database as a second defense. Cross-tenant isolation is continuously test-covered.",
        "Authentication: Shopify OAuth for installation plus Shopify session tokens for embedded login; first-party API sessions use short-lived JWT access tokens with refresh-token rotation and replay detection that revokes the full session chain on token reuse.",
        "Authorization: role-based access control with per-permission checks on every route; privileged platform-admin operations require a separate environment-held key plus short-lived operator sessions, and every administrative write is recorded in a tamper-evident action ledger with operator identity, payload hash, and IP address.",
        "Webhook integrity: Shopify webhooks are HMAC-verified against the app secret and deduplicated by delivery identifier before processing.",
        "Input handling: schema validation on all API inputs, parameterized database access, security headers (including a restrictive Content-Security-Policy permitting the app to be framed only by Shopify Admin), strict CORS, request-size limits, and rate limiting on authentication, expensive, and public endpoints.",
      ],
    },
    {
      heading: "3. Data protection",
      paragraphs: [],
      list: [
        "Encryption in transit: TLS for all production traffic.",
        "Encryption at rest: Shopify access tokens encrypted with AES-256-GCM before storage; hosted database volumes use the infrastructure provider's at-rest encryption.",
        "Secrets management: secrets live in environment configuration and platform secret stores — never in source code; logging conventions exclude tokens, secrets, and payment information, and redaction is test-enforced.",
        "Minimization: AI prompts are built from aggregated, non-PII business context; payment card data never touches the platform (billing runs entirely through Shopify).",
      ],
    },
    {
      heading: "4. Operations",
      paragraphs: [],
      list: [
        "Environment separation for development, testing, staging, and production, with a continuous-delivery pipeline in which type checks, the full test suite, coverage gates, production build, and migration-drift checks must all pass before a release is accepted.",
        "Health and readiness probes with dependency checks drive load-balancer rotation; background jobs are idempotent and retry-bounded with dead-letter handling; audit trails cover authentication, billing, AI decisions, settings and rule changes, automations, webhook events, and platform-admin actions.",
        "Backups: encrypted daily backups with point-in-time recovery where supported by the hosting provider, and documented restore drills as part of the release runbook.",
        "Access reviews: operator access, merchant user roles, active access overrides, and administrative sessions are reviewable in the platform-admin console at any time (SOC-2-lite evidence practice).",
      ],
    },
    {
      heading: "5. Incident response and availability practices",
      paragraphs: [
        "Suspected incidents are triaged from structured logs and health signals; merchant-impacting security incidents are communicated without undue delay with what happened, what was affected, and what we did. Failover design is degrade-safe: a failing subsystem (for example, email/SMS delivery or the AI provider) fails visibly in that feature area only and never silently corrupts data or drops actioned work.",
      ],
    },
    {
      heading: "6. Vulnerability disclosure",
      paragraphs: [
        "We welcome good-faith security research. Report vulnerabilities to {supportEmail} with reproduction details and your contact information. Do not access or modify data that is not yours, do not degrade service availability, and give us reasonable time to remediate before public disclosure. We acknowledge submissions and coordinate credit where desired. Testing against your own store and account is permitted within the Acceptable Use Policy.",
      ],
    },
    {
      heading: "7. Changes",
      paragraphs: [
        "Security evolves with the product; material changes to this statement are announced in-app, and the effective date above reflects the current text.",
      ],
    },
  ],
};
