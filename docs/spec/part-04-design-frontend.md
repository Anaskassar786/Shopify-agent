# PROFIT TOOL AI — MASTER PRD
## PART 4: Design System & Frontend Experience

> Status: RECEIVED (2026-08-05)

## DESIGN PHILOSOPHY
Enterprise SaaS quality comparable to: Shopify Admin, Stripe Dashboard, Notion, Linear, Vercel Dashboard, HubSpot, Klaviyo. Never a basic admin template. Must feel like a polished commercial SaaS merchants trust with critical business operations.

## DESIGN SYSTEM
Dark theme · light theme · auto system theme · responsive · professional typography · consistent spacing · rounded components · smooth animations · accessible · keyboard friendly.

### Color system
Primary · secondary · success · warning · danger · info · neutral · merchant brand colors.

### Typography scale
Display · heading · subheading · body · caption · labels · buttons · tables · charts.

## GLOBAL LAYOUT
Top nav · left sidebar · main content · context panel · notification drawer · profile menu · quick search · command palette.

## PAGES / SURFACES
- **Dashboard Home:** store health understandable in ≤10 seconds. Widgets: revenue, orders, customers, products, inventory, profit, AI score, store health, automation status, subscription status, recent activity, alerts.
- **AI Command Center:** latest recommendations, confidence, priority, revenue impact, approve/reject/explain, automation status, history.
- **Analytics Dashboard:** revenue trend, orders, customers, LTV, AOV, retention, inventory health, refund rate, growth forecast. Filters: today, yesterday, 7d, 30d, 90d, custom.
- **Recommendations:** cards (title, confidence, priority, est. revenue, category, created, status) + actions: explain, approve, reject, schedule.
- **Explainability Modal:** why, evidence, rules fired, AI reasoning summary, affected products/customers, estimated impact, merchant notes.
- **Customer Management:** search, filters, segments, VIP badge, purchase history, LTV, risk score, AI insights, recommended actions.
- **Product Management:** products, variants, inventory, margin, performance, AI suggestions, restock, bundles.
- **Inventory Center:** stock levels, warehouses, low stock, dead stock, predicted stockout, restock recommendations, supplier notes.
- **Automation Center:** enable/disable/pause/resume/schedule, logs, execution history, success rate.
- **Email Center:** templates, campaigns, recovery emails, preview, performance (open/click rate, revenue generated).
- **Notification Center:** real-time; categories: AI, orders, inventory, billing, security, automation, system.
- **Audit Logs:** searchable, filterable, exportable, timeline (user, action, IP, timestamp).
- **Billing Page:** current plan, trial status, usage, invoices, payment history, upgrade/downgrade/cancel/renew.
- **Settings:** general, store, brand, AI preferences, automation preferences, notifications, security, users, integrations, billing, API keys.
- **User Management:** invite/remove users, roles, permissions, activity, sessions.
- **Super Admin Panel (platform-level):** all merchants, subscriptions, revenue, errors, workers, queues, AI usage, billing, support, announcements, feature flags.
- **Global Search:** customers, orders, products, recommendations, rules, notifications, audit logs.
- **Command Palette:** keyboard navigation anywhere, run actions, search entities, open settings.

## UX STATES & QUALITY
- Mobile/tablet/desktop/large-screen responsive.
- Loading: skeletons, progress bars, animated placeholders.
- Empty states: helpful illustrations, clear CTAs, guided actions.
- Error states: friendly, recoverable, retry buttons, developer logs.
- Exports: CSV, Excel, PDF, print, scheduled reports.
- Accessibility: keyboard navigation, ARIA, screen readers, high contrast, scalable fonts.
- i18n: multiple languages, currency, timezone, date/number formats.

## ONBOARDING FLOW
Install app → connect store → sync products → configure AI → enable automation → start trial.

## SUBSCRIPTION EXPERIENCE
3-day trial · usage dashboard · upgrade prompts · feature comparison · renewal reminders · grace period.

## HELP CENTER
Documentation · FAQs · video tutorials · live chat integration · support tickets · release notes.
