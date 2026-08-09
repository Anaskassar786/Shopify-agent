# PROFIT TOOL AI — MASTER PRD
## PART 2: Database, Shopify Integration, Backend Foundation

> Status: RECEIVED (2026-08-05)

## DATABASE
- PostgreSQL (primary production DB), Drizzle ORM.
- Requirements: strong relations, foreign keys, transactions, indexes, soft deletes where appropriate, optimized queries.
- Every business table MUST include: `id`, `store_id`, `created_at`, `updated_at`.

### Core Tables (by domain)
- **Auth:** users, roles, permissions, sessions, refresh_tokens, api_keys
- **Merchant:** stores, store_settings, billing_accounts, subscriptions, plans
- **Shopify:** shopify_sessions, shopify_tokens, webhook_logs, sync_history
- **Customers:** customers, customer_tags, customer_segments, customer_notes
- **Products:** products, product_variants, collections, inventory_levels
- **Orders:** orders, order_items, refunds, fulfillments
- **Discounts:** discount_rules, generated_discounts, discount_usage
- **Recommendations:** recommendations, recommendation_history, evidence_snapshots, ai_reasoning, merchant_actions
- **Automation:** automation_rules, automation_jobs, automation_logs, automation_history
- **Notifications:** notifications, notification_preferences
- **Analytics:** daily_metrics, customer_metrics, product_metrics, revenue_metrics
- **Billing:** invoices, payments, usage_records
- **Audit:** audit_logs
- **Queue:** background_jobs, failed_jobs, retries

## SHOPIFY INTEGRATION
- Auth: OAuth 2.0, Embedded App, Session Tokens.
- Required APIs: Products, Orders, Customers, Inventory, Collections, Discounts, Metafields, Locations, Draft Orders, Fulfillments, Returns.

### Webhooks (auto-registered)
APP_UNINSTALLED · ORDERS_CREATE · ORDERS_UPDATED · ORDERS_PAID · ORDERS_CANCELLED · CUSTOMERS_CREATE · CUSTOMERS_UPDATE · CUSTOMERS_DELETE · PRODUCTS_CREATE · PRODUCTS_UPDATE · PRODUCTS_DELETE · INVENTORY_LEVELS_UPDATE · FULFILLMENTS_CREATE · REFUNDS_CREATE · CHECKOUTS_CREATE · CARTS_UPDATE (if supported)

Every webhook must: validate HMAC → verify store → store event → update DB → trigger AI if required → audit log → notification → return success.

### Sync Engine
Initial full sync · incremental sync · manual sync · scheduled sync · conflict detection · retry logic · sync logs.
Modules: products, customers, orders, inventory, collections, discounts, metafields.

## AUTHENTICATION
Merchant login · embedded session · JWT · refresh token · logout · remember session · token rotation · token expiration · secure cookies where required.

## PERMISSIONS
Roles: Owner, Admin, Manager, Staff, Viewer. Every API verifies permissions.

## AUTHORIZATION (every request validates)
Merchant → Store → Permission → Session → Subscription.

## BILLING (Shopify Billing API)
Free trial · monthly · yearly · enterprise · custom pricing · usage-based (future ready).
Plans: Starter, Growth, Professional, Enterprise.
Lifecycle: trial_started, trial_expired, subscribed, upgraded, downgraded, cancelled, expired, suspended.
Events: subscription_created/updated/cancelled, payment_failed/successful, trial_ended.

## API DESIGN
Versioned REST (`/api/v1/`, `/api/v2/`):
- Auth: POST /login, /logout, /refresh; GET /me
- Store: GET/PUT /store; GET/PUT /settings
- Products: GET /products, GET /products/:id, POST /products/sync
- Customers: GET /customers, GET /customers/:id, POST /customers/sync
- Orders: GET /orders, GET /orders/:id, POST /orders/sync
- Inventory: GET /inventory, POST /inventory/sync
- Analytics: GET /analytics, /analytics/revenue, /analytics/products, /analytics/customers, /analytics/dashboard
- Recommendations: GET /recommendations, GET /recommendations/:id, POST /recommendations/approve, POST /recommendations/reject
- Evidence: GET /recommendations/:id/evidence
- Automation: GET /automation, POST /automation/run, /pause, /resume
- Notifications: GET /notifications, PATCH /notifications/read
- Billing: GET /plans, POST /subscribe, POST /cancel, GET /usage, GET /invoice
- Audit: GET /audit, GET /audit/:id
- Shopify: GET /shopify/install, GET /shopify/callback, POST /shopify/sync, POST /shopify/webhooks

## RESPONSE FORMAT (every API)
`success`, `message`, `data`, `meta`, `errors`, `timestamp`, `request_id`.

## VALIDATION
Zod everywhere: body, query, params, headers. Never trust client input.

## RATE LIMITING
Auth: strict · Shopify callbacks: protected · AI endpoints: limited · Automation: controlled.

## CACHING
Dashboard · analytics · settings · product lists · customer lists — with intelligent invalidation after sync.

## MIGRATIONS
Drizzle migrations only. Never modify production tables manually.

## PART 2 EXIT CRITERIA
Enterprise-grade PG schema · secure authN/authZ · complete Shopify integration · production billing · versioned REST APIs · sync engine · webhook infrastructure · audit-ready architecture · scalable backend foundation.
