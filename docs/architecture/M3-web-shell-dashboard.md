# M3 — Web Shell + Dashboard (as built)

> Status: **delivered**. 465 tests green workspace-wide (126 web + 49 ui), zero
> TypeScript errors (13 projects), `vite build` (code-split), `tsup` bundles for
> api/worker, `drizzle-kit generate` = no drift. Branch: `arena/019fd0a3-shopify-agent`.

M3 turns the M2 data plane into the merchant-facing product: the design
system, the embedded app shell, a live dashboard, realtime notifications,
command palette + global search, and the onboarding → trial flow. Everything
renders data from the M1–M3 APIs; **no demo, mock or placeholder content
exists anywhere in the tree** (roadmap surfaces say so explicitly, with links
to what works today).

## 1. Deliverables map

| Deliverable | Where | Backed by |
|---|---|---|
| Design tokens (dark default, light, radius/elevation/type/chart + AI colors, WCAG-checked pairs) | `packages/ui/src/tokens.css` (`@theme` → Tailwind utilities; `data-theme="light"` overrides) | P9 follow |
| Component library | `packages/ui/src/components/*` (Button/Badge/Card/Input/Select, Spinner/Skeleton/ProgressBar/AnimatedNumber/EmptyState/ErrorState, Modal/Drawer/ConfirmDialog/DropdownMenu/Tabs, Toast provider, DataTable/StatCard, AreaChart/Sparkline/Gauge/HealthBar) | 49 tests, 94% stmt |
| App shell (sidebar 15 sections, topbar, notification drawer, command palette, theme toggle, user menu, offline chip, sync-health dot) | `apps/web/src/shell/*` | `/store`, `/sync/status`, `/notifications`, WS |
| Live dashboard | `apps/web/src/pages/DashboardPage.tsx` | `/analytics/summary|top-products|top-customers`, `/sync/status`, `/inventory/levels?below=5`, `/audit-logs` |
| Analytics, catalog, inventory, notifications, audit, billing, settings, support pages | `apps/web/src/pages/*` | v1 routers (M2/M3) |
| Realtime channel (WS gateway → per-store pub/sub fan-out → query invalidation + toasts) | `apps/api/src/modules/realtime/gateway.ts`, `packages/cache` pub/sub port, `apps/web/src/lib/realtime.ts` | worker emits after durable writes |
| Global search | `apps/api/src/modules/search/search.router.ts` (per-permission groups), palette in shell | products/customers/orders |
| Onboarding wizard + trial | `apps/web/src/pages/OnboardingPage.tsx` | `/store`, `/sync/*`, PATCH `/store/settings`, `/subscription`, POST onboarding/complete + start-trial |

## 2. Runtime topology (final)

```
Shopify Admin (iframe)
   │  App Bridge CDN (auto-init via <meta shopify-api-key>) → window.shopify.idToken()
   ▼
apps/web (React 19 + Vite, served BY THE API as a static bundle — one origin)
   │  /api/v1/* + /shopify/* same-origin (Vite dev proxy mirrors prod topology)
   ▼
apps/api (Express)
   ├─ SPA handler: index.html + %SHOPIFY_API_KEY% injected at serve time (build once, deploy many)
   ├─ helmet CSP: script cdn.shopify.com · frame-ancestors admin.shopify.com/*.myshopify.com · wss:
   ├─ WS gateway /api/v1/realtime (JWT on upgrade; per-tenant channel rt:{storeId})
   └─ REST routers (M1–M3)
        ▲                         ▲
        │ publish                 │ publish (after durable commits)
packages/cache createPubSub ◄──── apps/worker (sync.module.*, sync.full-run.completed,
(memory dev/test, Redis prod)     notification.created → notifications rows)
```

Auth handoff (M1 contract, unchanged): idToken → `/auth/session` → API
JWT + rotating refresh (stored `profit.refresh.v1`; access token memory-only).
Boot order embedded-token → refresh → standalone (install gate). **Never a
fake session anywhere.**

## 3. Frontend architecture

- **Design tokens only.** Every color/spacing/elevation reference in web and
  ui code is a token utility (`bg-canvas`, `text-muted`, `border-subtle`,
  `shadow-card`, …) or a `var(--color-*)`. Zero hardcoded palette values —
  verified by inspection; the only inline `style={{backgroundColor}}` is the
  merchant's own branding swatch (user data, not palette).
- **Data layer.** `lib/queries.ts` is the ONLY place pages talk to the API —
  one typed hook per endpoint (TanStack Query), query keys centralized in
  `lib/query-keys.ts` with prefixes (`sync|analytics|catalog|notifications|
  dashboard`) that the realtime client maps 1:1 to invalidations. The socket
  never mutates cache; it invalidates → REST stays the single source of truth.
- **State boundaries.** Data-driven blocks render through `QueryBoundary`:
  unified skeletons / ErrorState(+request id, retry) / offline variant with
  automatic refetch on reconnect (`useOnlineStatus` + `NETWORK_ERROR` status-0
  from the ApiClient). Empty states are content and stay page-owned.
- **Code splitting.** Every page is a lazy route chunk (verified in `vite
  build` output: 16 page chunks, each 1.4–13 KB); the boot chunk holds only
  the shell + providers.
- **A11y (WCAG AA).** aria labels on all icon-only controls, `aria-sort` on
  sortable headers, `aria-selected` tabs, `aria-current` wizard steps,
  focus-visible outlines via tokens, ESC/backdrop dialog semantics with focus
  restore, `prefers-reduced-motion` respected by AnimatedNumber, contrast
  pairs fixed in tokens for both themes.
- **Responsiveness.** Sidebar fixed ≥lg, overlay nav below; all grids collapse
  4→2→1 columns; tables horizontally scroll with sticky headers; the palette
  and drawer are mobile-sized; touch targets ≥32px.

## 4. Backend additions (all M1/M2-compatible)

- `packages/notifications` — NotificationService (create→persist→publish; list
  with audience scoping + unread counts; markRead/markAllRead idempotent) ·
  `notifications` table (migration 0004 + RLS) · PGlite integration tests.
- Pub/sub port in `packages/cache` — `createPubSub(env)` → memory (dev/test)
  or Redis (prod, dedicated pub+sub connections, JSON parse-drop guard).
- API routers: `notifications` (list/read/read-all), `search` (per-permission
  grouped results), `audit-logs` (filters + pagination, `audit:read`),
  `subscription` (GET joined plan; POST start-trial = recovery path, idempotent),
  `store` extensions (PATCH settings strict whitelist + audit; POST
  onboarding/complete idempotent + audit), WS gateway, SPA static handler,
  shared `parsePageParams` extraction (DRY across 5 routers).
- Worker realtime handlers — module-completed socket events, final-attempt
  failure notifications (row + event), full-run completion notification
  ({"Data sync complete"} → /dashboard) **fanned in against `groupModules`**
  (see §6), dead-DB tolerant best-effort notification path.
- Shared wire contracts in `@profit/types` — `RealtimeEventKind`,
  per-kind payload map, `isRealtimeEvent` guard (single type used by
  worker → gateway → web: drift impossible by construction).

## 5. Decisions taken (documented per permanent rule 6)

1. **Fan-in scope fix (latent M2 defect, explained before change).** M2's
   fan-in compared pending modules against the FULL 7-module order even when
   `sync.store.full` was enqueued with a module subset — `analytics.refresh`
   could therefore never fire after a partial group (no producer exercised it,
   so nothing was broken in prod). Fix: additive optional `groupModules` on
   the sync payload schema; fan-in compares against `groupModules ?? FULL_SYNC_ORDER`;
   the "Data sync complete" notification fires only when the group == full 7.
   Deploy-safe: old payloads parse unchanged.
2. **Envelope meta access (additive client API).** The P2 envelope carries
   pagination/extras OUTSIDE `data`; list endpoints return bare arrays. Rather
   than reshape frozen M1/M2 server contracts, the web `ApiClient` gained
   `getWithMeta()` returning `{data, meta}`; `get/post/patch` keep unwrapping.
3. **`GET /products/:id` (additive consistency).** M2 exposed list + variants
   but no single-product read — the product page would have needed hidden
   cross-page state. Added the symmetric route (same 404 semantics as
   customers/orders) + 2 integration tests. No existing route changed.
4. **Vitest 3 for apps/web.** vitest 2 pins vite-5 types; apps/web builds on
   vite 6. vitest ^3 resolves the plugin typing conflict; jest-dom matcher
   types are restored by augmenting `@vitest/expect` (vitest ≥3.2 re-exports
   Assertion from there — documented in `src/test-support/jest-dom.d.ts`).
   The ui package intentionally stays on vitest 2 (zero reason to churn it).
5. **Roadmap surfaces are honest pages, not hidden nav.** P9's 15 sections are
   all navigable; the four whose backends ship in M4/M6 render
   `SectionRoadmapPage` — what the surface will do, its milestone, and links
   to working features — with **zero controls** (asserted in tests).
6. **Shopify HTML rendered as text.** `body_html` is merchant-authored HTML;
   the product page displays tag-stripped readable text — no `dangerouslySetInnerHTML` anywhere.

## 6. Dashboard — built vs honestly deferred (scope-trap report)

P9 describes hero cards: revenue / orders / customers / **profit** /
**AI score** / store health, plus **AI insights**.

| P9 item | M3 status | Reason |
|---|---|---|
| Revenue / orders / customers cards + trends | ✅ live | M2 metrics pipeline |
| AOV card | ✅ live (as 4th KPI) | computed in summary |
| Store health card | ✅ live | sync module roll-up + freshness |
| Recent activity | ✅ live | audit trail (`audit:read` gated) |
| Inventory alerts | ✅ live | `/inventory/levels?below=5` |
| **Profit card** | ⛔ deferred | no COGS in the data plane; numbers would be invented. Lands with cost fields (M6 automation/cost or earlier if reprioritized) |
| **AI score card + AI insights panel** | ⛔ deferred | needs the M4 engine; the AI Command Center roadmap page says exactly this and links to working surfaces |
| Automation status widget | ⛔ deferred | M4 |

Chart data on every dashboard/analytics chart comes from `/analytics/*` only —
user requirement honored: zero mock series.

## 7. Gates (this milestone, all green)

| Gate | Result |
|---|---|
| `pnpm -r run typecheck` | 13 projects, 0 errors |
| `pnpm -r run test` | **465 passed + 4 skipped** (Redis-gated; CI runs them) |
| Web coverage | 91.33 stmts / 86.77 branch / 83.18 funcs / 91.33 lines (gate 80/75/80/80) |
| UI coverage | 94.4 stmts / 84.06 branch |
| API coverage | 92.1 stmts / 76.35 branch (149 tests) |
| Worker coverage | 93.84 stmts / 83.8 branch |
| `pnpm -r run build` | api + worker (tsup), web (`tsc` + vite, 16 lazy chunks) |
| `pnpm --filter @profit/db run generate` | No schema changes (no drift) |

## 8. Files (new/changed highlights)

- `apps/web/**` (new app): config (`vite/vitest/tsconfig/index.html`), `lib/`
  (api-client, auth-context, shopify bootstrap, realtime, query keys/factory,
  queries, api-types, format, series, use-online), `shell/` (sections registry,
  AppLayout, guards, InstallGate, NotificationDrawer, CommandPalette),
  `components/` (QueryBoundary, PageHeader, SyncManager), `pages/` (17),
  `test-support/` (harness, fixtures, setup), 20 test files (126 tests).
- `packages/ui/**` (new package) — tokens + 14 components + charts, 49 tests.
- `packages/notifications/**` (new package) — service + PGlite tests.
- `packages/cache` — pub/sub port + memory/Redis drivers + factory.
- `packages/types` — realtime wire contract.
- `packages/db` — notifications + onboardingCompletedAt (migration 0004).
- `apps/api` — notifications/search/audit/subscription routers, store router
  extensions, realtime gateway, SPA static serving, pagination extraction,
  embedded CSP.
- `apps/worker` — realtime emit/notify handlers, groupModules fan-in fix,
  pubsub wiring.
- `packages/sync` — groupModules payload field (additive).
