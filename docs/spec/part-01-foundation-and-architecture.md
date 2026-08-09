# PROFIT TOOL AI — MASTER PRD
## PART 1: Foundation & Architecture

> Status: RECEIVED (2026-08-05)

## ROLE & RESPONSIBILITY
Lead Software Architect, Senior Full Stack Engineer, AI Engineer, DevOps Engineer, Shopify Expert, Product Designer.
Build a production-ready enterprise SaaS application.
- Never generate demo code.
- Never generate placeholder implementations unless explicitly requested.
- Everything must be production-ready.

## PROJECT
- **Name:** PROFIT TOOL AI
- **Type:** Enterprise AI Decision Support & Revenue Automation Platform for Shopify Merchants.
- **NOT** a dashboard, **NOT** a reporting tool, **NOT** only analytics.
- Must behave like an **AI employee** working inside a Shopify store.

## PRIMARY GOAL
Increase merchant revenue using AI. The AI must:
1. Analyze the merchant's business.
2. Understand customers, products, inventory, orders.
3. Predict future problems.
4. Suggest actions.
5. Execute approved actions automatically.
6. Measure business impact.

## TARGET USERS
- Small Shopify merchants
- Medium Shopify merchants
- Enterprise Shopify merchants
- Agencies managing multiple stores
- Shopify Plus merchants

## CORE PHILOSOPHY
Install → AI understands store → Continuous monitoring → Detects opportunities → Explains every recommendation → Merchant approves → Automation executes → Revenue increases → Everything measurable.

## APPLICATION TYPE
- Embedded Shopify App
- Multi-Tenant SaaS
- Cloud Native / Enterprise Grade
- AI Powered / Production Ready

## TECH STACK
### Frontend
React 19 · TypeScript · Vite · React Router · TanStack Query · React Hook Form · Zod · Tailwind CSS · Framer Motion · Recharts · Lucide Icons

### Backend
Node.js · Express · TypeScript · REST API · GraphQL · WebSockets (where required)

### Database
PostgreSQL · Drizzle ORM · Migrations · Indexes · Relations · Constraints · Transactions

### Infrastructure
Railway · GitHub · GitHub Actions · Docker-ready · Environment variables · Health checks · Structured logging

### AI
- Primary provider: Google Gemini
- Provider-agnostic architecture:
  AI Provider Interface → Gemini Provider → (future) OpenAI Provider → (future) Claude Provider
- **Business logic must never depend directly on the Gemini SDK.**

## SHOPIFY INTEGRATION (MUST SUPPORT)
OAuth · Session Tokens · Embedded App · GraphQL Admin API · REST Admin API · Webhooks · Billing API · Discount API · Products · Customers · Orders · Inventory · Collections · Draft Orders · Metafields · App Bridge · App Uninstall

## MULTI-TENANCY
- Every merchant has isolated data; Store A must never access Store B.
- Every table contains store_id.
- Every API validates store ownership.

## ENTERPRISE PRINCIPLES
Scalable · Maintainable · Modular · Secure · Testable · Observable · Performant · Extensible · Reusable · Production Ready

## DEVELOPMENT RULES
- Never rewrite working modules.
- Always reuse architecture; avoid duplicate logic.
- Keep modules small; prefer composition.
- Strong typing; **no `any` type**.
- No magic strings; no hardcoded secrets; no demo bypasses.
- Dependency injection where appropriate.

## MODULE MAP (required separation)
Frontend · Backend · Database · Services · Controllers · Repositories · Workers · Jobs · Automation · AI · Rules · Analytics · Billing · Shopify · Notifications · Emails · SMS · Discounts · Security · Monitoring · Tests · Documentation

## CODING STANDARDS
Clean Architecture · SOLID · DRY · KISS · Strong types · Reusable components/services · Consistent naming · Meaningful commits & comments

## ERROR HANDLING
Global error handler · Validation · Authentication · Shopify · Database · AI · Queue · Network · Structured error responses

## LOGGING
Request/response · AI · Shopify · Webhook · Automation · Worker · Billing · Security · Audit logs

## CONFIGURATION
Everything configurable · Never hardcode · Environment variables · Feature flags where appropriate

## PERFORMANCE
Lazy loading · Pagination · Caching · Background jobs · Optimized SQL · Indexes · Connection pooling · Compression · Rate limiting

## SECURITY
JWT · Encryption · Secret rotation · CSRF · XSS · SQL-injection protection · HMAC verification · OAuth state validation · Permission system · Audit trail

## DOCUMENTATION
Every module · Architecture · Database · API · Deployment · Developer docs

## GIT
Meaningful commits · Feature branches · PR-ready · CI-compatible

## FINAL BAR
Comparable to enterprise SaaS: professional, modern, reliable, fast, secure, AI-first, production-ready.
