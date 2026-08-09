import type { LegalDocument } from "./types";

/** Terms of Service — the merchant contract, scoped to what the app actually does. */
export const TERMS_OF_SERVICE: LegalDocument = {
  slug: "terms",
  title: "Terms of Service",
  effectiveDate: "2026-08-07",
  version: 1,
  summary: "The agreement between you and us for using PROFIT TOOL AI: accounts, subscriptions, acceptable use, liability.",
  sections: [
    {
      heading: "1. Agreement",
      paragraphs: [
        "These Terms of Service (\"Terms\") form a binding agreement between {entity} (\"we\", \"us\") and the merchant entity or person that installs or uses PROFIT TOOL AI (\"you\", \"the merchant\"). By installing the app, connecting a Shopify store, or using any part of the service, you accept these Terms and our Privacy Policy, Acceptable Use Policy, and Refund Policy, each of which is incorporated by reference. If you act for a company, you represent that you are authorized to bind it.",
      ],
    },
    {
      heading: "2. The service",
      paragraphs: [
        "The service is an AI-assisted decision-support and revenue-automation application for Shopify stores: analytics and store-health metrics, AI-generated recommendations with evidence, merchant-approved automations (workflows, campaigns, discounts, customer tagging), exports, billing and subscription management, and support tooling. Features are described in plan documentation; some features are limited by plan tier and usage quotas shown in the app at purchase time.",
        "AI recommendations are decision support, not guarantees. Revenue projections, recovery estimates, and scores are analytical estimates derived from your store data; actual business outcomes depend on factors outside our control.",
      ],
    },
    {
      heading: "3. Accounts and eligibility",
      paragraphs: [
        "You must operate a valid Shopify store and have authority to grant the API scopes the app requests. Team members you invite act under your account; you are responsible for their use of the service and for maintaining appropriate roles and credentials. You must be at least 18 years old and able to form a binding contract.",
        "You control access: owners and admins manage user roles in the app. Notify us promptly at {supportEmail} if credentials are compromised.",
      ],
    },
    {
      heading: "4. Subscriptions, trials, and billing",
      paragraphs: [
        "Paid plans are billed through the Shopify Billing API on the recurring terms shown at purchase (monthly or annual intervals, per plan). A free trial, where offered, converts to a paid subscription unless you cancel before the trial ends. Charges, approvals, and cancellations happen on Shopify's billing screens; we never collect card numbers.",
        "You authorize us to create recurring application charges for the plan you select, and usage-based charges where your plan includes them. Plan changes take effect as described in the app (upgrades immediately with proration handled by Shopify; downgrades at the next billing cycle). Uninstalling the app cancels future charges. Taxes are your responsibility and may be added by Shopify where applicable.",
        "If a charge fails, access may be suspended after the grace handling described in the app until payment is resolved. We may change prices with at least 30 days' notice before your next billing cycle; continued use after the effective date accepts the new price.",
      ],
    },
    {
      heading: "5. Your data and permissions",
      paragraphs: [
        "You retain all rights to your store data. You grant us a limited license to host, copy, process, and display that data solely to provide the service to you, as described in the Privacy Policy. You represent that you have all rights and lawful bases needed to share your customers' personal data with us for those purposes, including for marketing messages you send through the service.",
        "API scopes are requested at install and visible in Shopify Admin; automations you enable act within those scopes on your instruction. Records of what the service changed in your store are visible in the app's audit and activity surfaces.",
      ],
    },
    {
      heading: "6. Acceptable use",
      paragraphs: [
        "Your use of the service is subject to the Acceptable Use Policy. In short: no unlawful content or messaging, no spam, no abuse of the platform or other tenants, no reverse engineering, no security probing without consent. We may suspend access for violations, with notice where practicable.",
      ],
    },
    {
      heading: "7. Service levels and changes",
      paragraphs: [
        "We operate the service with commercially reasonable care: health monitoring, background-job retries, encrypted storage of credentials, tenant isolation, and a documented backup cadence. Scheduled maintenance is announced in-app where practicable. We may improve, add, or remove features over time; if a change materially reduces a feature you pay for, you may cancel for a prorated refund of the affected period under the Refund Policy.",
      ],
    },
    {
      heading: "8. Intellectual property",
      paragraphs: [
        "We own the service, including software, design, models' orchestration, documentation, and branding. You own your data and your store content. Feedback you send may be used to improve the service without obligation to you. These Terms grant no rights to either party's trademarks except as needed to operate the service.",
      ],
    },
    {
      heading: "9. Disclaimers and limitation of liability",
      paragraphs: [
        "THE SERVICE IS PROVIDED \"AS IS\" AND \"AS AVAILABLE\" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT AI RECOMMENDATIONS, ANALYTICS, OR AUTOMATIONS WILL PRODUCE ANY PARTICULAR REVENUE OR BUSINESS RESULT.",
        "TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THE SERVICE IS LIMITED TO THE AMOUNTS YOU PAID US FOR THE SERVICE IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO LIABILITY. WE ARE NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, DATA, OR GOODWILL. Nothing in these Terms limits liability that cannot be limited by law.",
      ],
    },
    {
      heading: "10. Indemnification",
      paragraphs: [
        "You will indemnify us against third-party claims arising from your data, your messages and campaigns (including claims you lacked a lawful basis to send them), your store content, or your breach of these Terms. We will indemnify you against third-party claims that the service, as provided by us and used per these Terms, infringes intellectual-property rights, with the customary exceptions (combinations, modifications by you, use after notice to stop).",
      ],
    },
    {
      heading: "11. Term and termination",
      paragraphs: [
        "These Terms apply while you use the service. You may cancel your subscription and uninstall at any time from Shopify Admin. We may suspend or terminate access for breach, non-payment, or legal risk, with notice where practicable. On termination: your right to use the service ends, remaining charges are handled by Shopify per their rules, and data deletion follows the Privacy Policy's retention schedule. Sections that by nature survive (disclaimers, liability, indemnities, data handling) survive.",
      ],
    },
    {
      heading: "12. General",
      paragraphs: [
        "These Terms are governed by the laws of the jurisdiction of our registered entity, excluding conflict-of-laws rules; dispute venue is the competent court of that jurisdiction unless mandatory law says otherwise. The United Nations Convention on Contracts for the International Sale of Goods does not apply. If any provision is unenforceable, the rest remains in force; failure to enforce a provision is not a waiver. You may not assign these Terms without our consent; we may assign them in connection with a merger, acquisition, or asset sale with notice. These Terms plus the incorporated policies are the entire agreement between us about the service.",
        "Questions: {supportEmail}. We may update these Terms; material changes are announced in-app before taking effect, and the effective date above shows the current version.",
      ],
    },
  ],
};
