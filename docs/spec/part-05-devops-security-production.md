# PROFIT TOOL AI — MASTER PRD
## PART 5: Deployment, DevOps, Security, Monitoring & Production

> Status: RECEIVED (2026-08-05)

## OBJECTIVE
Production-grade SaaS safely serving thousands of Shopify merchants: highly available, secure, scalable, observable, fault tolerant, maintainable.

## DEPLOYMENT
- Primary: Railway. Future-ready: AWS, GCP, Azure, DigitalOcean, Fly.io.
- Must remain **cloud-agnostic**.

## ENVIRONMENTS
Development · Testing · Staging · Production — separate config each; never hardcode secrets.

## REQUIRED ENV VARS
- App: APP_URL, NODE_ENV, PORT
- DB: DATABASE_URL
- Shopify: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL, SHOPIFY_SCOPES
- AI: GEMINI_API_KEY
- JWT: JWT_SECRET, JWT_REFRESH_SECRET
- Billing: SHOPIFY_BILLING_PLAN
- Email: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
- Notifications: WEBHOOK_SECRET
- Monitoring: SENTRY_DSN (optional), LOG_LEVEL

## SECRET MANAGEMENT
Never expose/commit secrets · periodic rotation · rotation without downtime.

## DATABASE SAFETY
Automatic backups · point-in-time recovery where supported · migration versioning · rollback strategy · connection pooling · health checks · slow-query logging.

## SECURITY
- Auth: JWT, refresh tokens, rotation, session expiration, secure cookies, permission verification, role validation.
- Shopify: OAuth state validation, HMAC verification, webhook signature validation, session token validation, app uninstall cleanup, store ownership validation.
- API: rate limiting, input validation, request size limits, CORS, Helmet headers, request ID generation, replay-attack prevention where applicable.

## DATA PROTECTION
Encrypt sensitive merchant data at rest where appropriate.
Never log: passwords, tokens, secrets, payment info, API keys.

## AUDIT LOGGING
Authentication · billing · AI decisions · rule changes · automation · discount creation · webhook events · API errors · system events.

## ERROR MONITORING (capture)
Unhandled exceptions · promise rejections · worker failures · DB errors · webhook failures · AI provider failures · billing failures.

## LOGGING FORMAT
Levels: INFO, WARNING, ERROR, DEBUG. Every log: timestamp, store_id, request_id, user_id (if available), service name, duration.

## HEALTH CHECKS
Endpoints: /health, /ready, /live — return DB status, queue status, AI provider status, Shopify connectivity, app version, uptime.

## MONITORING (track)
CPU · memory · response time · API latency · queue length · worker status · DB connections · error rate · webhook success rate · AI response time.

## JOB QUEUE MONITORING
Pending · running · completed · failed · retries · dead-letter queue · worker health.

## ALERTING (notify admins when)
Database down · queue stuck · webhook failure-rate high · AI provider down · billing failure · app crash · high error rate.

## BACKGROUND WORKERS
Dedicated: AI, email, SMS, Shopify sync, analytics, cleanup, notifications, discount generation. Restart-safe and idempotent where possible.

## FAILOVER
AI fails → do not execute automation → notify merchant → retry safely → detailed logs.

## BACKUPS
Daily backups · weekly snapshots · retention policy · restore testing.

## SCALABILITY
10 → 100 → 1,000 → 10,000 → 100,000+ stores. Stateless application architecture preferred.

## PERFORMANCE TARGETS
- Dashboard load < 2s
- API response < 500ms typical
- Webhooks: acknowledge fast, heavy work → background jobs
- AI recommendation generation: background with progress tracking

## CI/CD
GitHub Actions: install → typecheck → tests → build → deploy to Railway; block deploy on critical check failure.

## VERSIONING
Semantic versioning + maintained changelog.

## ROLLBACK
Every deployment supports rollback to previous stable release.

## MAINTENANCE MODE
Enable · disable · custom message · admin bypass.

## FEATURE FLAGS
Enable/disable: AI features, automation, experimental features, beta modules — per merchant.

## BUSINESS CONTINUITY
Module failure isolation (e.g., email down → dashboard/recommendations/billing still work; only email worker pauses).

## PRODUCTION CHECKLIST (every release)
Build passes · tests pass · migrations verified · security review · env vars verified · monitoring active · health checks passing · rollback plan prepared.
