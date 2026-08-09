# PROFIT TOOL AI — MASTER PRD
## PART 9: Enterprise UI/UX Design System

> Status: RECEIVED (2026-08-05)

## OBJECTIVE
World-class SaaS UI comparable to Shopify Admin, Stripe, Linear, Notion, Vercel, HubSpot. Trust within 10 seconds. Feel: premium, fast, minimal, enterprise, AI-first, data-rich without clutter. No template-like dashboards.

## DESIGN LANGUAGE
- Theme: **dark (default)**, light, system auto.
- Visual: soft rounded corners, glass effects only where useful, clean cards, subtle shadows, smooth transitions, consistent spacing.

## DESIGN TOKENS
- Spacing: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64
- Radius: sm / md / lg / xl
- Elevation: card / modal / drawer / dropdown

## COLOR SYSTEM
Primary · secondary · accent · success · warning · danger · info · neutral · chart colors · AI-confidence colors · priority colors · automation-status colors. All WCAG-contrast compliant.

## TYPOGRAPHY
Display · H1–4 · body · caption · table text · buttons · labels · numbers. Modern sans-serif, excellent readability.

## ICONS
One consistent set (Lucide per Part 1). Domains: revenue, customers, orders, products, AI, automation, notifications, billing, security, settings, analytics, rules, audit.

## LAYOUT
Top nav · left sidebar · main workspace · optional right context panel · notification drawer · search overlay · command palette.

### Sidebar sections (definitive nav)
Dashboard · AI Command Center · Recommendations · Customers · Products · Orders · Inventory · Automation · Analytics · Campaigns · Notifications · Audit Logs · Billing · Settings · Support.

## KEY PAGE SPECS
- **Dashboard:** hero cards (revenue, orders, customers, profit, AI score, store health) + charts (revenue trend, orders, customer growth, inventory health) + recent activity + AI insights.
- **AI Command Center:** recommendation cards (title, confidence, priority, est. revenue, est. ROI, risk) + approve/reject/explain/schedule + automation status.
- **Recommendation Details:** business summary, why, evidence, affected customers/products, est. impact, risk, timeline, merchant notes, approval history.
- **Customer:** profile, purchase timeline, LTV, risk score, VIP badge, segments, orders, AI suggestions, campaigns.
- **Product:** performance, margin, inventory trend, AI suggestions, bundles, cross-sell, upsell, restock.
- **Inventory:** warehouse view, stock status, forecast, restock timeline, dead stock, fast movers.
- **Analytics:** revenue, profit, orders, AOV, LTV, retention, churn, refund rate, inventory turnover; filters today/7d/30d/90d/custom.
- **Automation:** workflow cards, status, success rate, executions, failures, last run, pause/resume, logs.
- **Billing:** current plan, usage, invoices, renewal date, upgrade/cancel, payment history.
- **Settings:** store, branding, AI preferences, automation, notifications, security, users, API keys, billing.

## COMMAND PALETTE & SEARCH
Keyboard shortcut; search everything; run actions; open pages; create automation; open customer/product. Global search: customers, products, orders, recommendations, notifications, audit logs.

## COMPONENTS
- **Tables:** sticky headers, sorting, filtering, search, pagination, bulk actions, export, resizable columns.
- **Forms:** inline validation, autosave where appropriate, clear errors, progress indicators, confirmation dialogs.
- **Modals:** centered, animated, keyboard accessible, ESC to close, backdrop blur.
- **Drawers:** right-side, responsive, multi-step workflows.
- **Toasts:** success/warning/error/info, undo where applicable.
- **Loading:** skeletons, progress bars, minimal spinners, background-sync indicators.
- **Empty states:** illustration, explanation, primary + secondary CTA.
- **Error states:** human-friendly message, retry button, support link, error ID.

## RESPONSIVE / ACCESSIBILITY / MICRO-INTERACTIONS
Desktop, laptop, tablet, mobile — usable at every size. Keyboard navigation, screen-reader labels, focus states, high contrast, scalable fonts. Subtle, performance-friendly animations: hover effects, card expansion, animated counters, chart animations, button feedback, status transitions.

## PER-PAGE QUALITY CHECKLIST
Clear hierarchy · consistent spacing · fast loading · accessible colors · responsive layout · meaningful empty states · helpful error handling · polished animations · professional visual identity.

## FINAL GOAL
Merchant immediately feels a premium enterprise product. Trust, clarity, intelligence — AI recommendations central to the experience.
