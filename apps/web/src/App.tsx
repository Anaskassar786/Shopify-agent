import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { SkeletonText } from "@profit/ui";
import { AppLayout } from "./shell/AppLayout";
import { RequireAuth, RequirePermission } from "./shell/guards";
import { APP_SECTIONS } from "./shell/sections";
import { SectionRoadmapPage } from "./pages/SectionRoadmapPage";

/**
 * Route table. Every page lazy-loads (user requirement: code splitting) — the
 * embedded shell boots fast, each section ships its own chunk. Roadmap
 * surfaces share one honest page driven by the section registry (no fake
 * controls), live surfaces get a permission guard mirroring the API.
 */

const DashboardPage = lazy(async () => ({ default: (await import("./pages/DashboardPage")).DashboardPage }));
const AnalyticsPage = lazy(async () => ({ default: (await import("./pages/AnalyticsPage")).AnalyticsPage }));
const ProductsPage = lazy(async () => ({ default: (await import("./pages/ProductsPage")).ProductsPage }));
const ProductDetailPage = lazy(async () => ({ default: (await import("./pages/ProductDetailPage")).ProductDetailPage }));
const CustomersPage = lazy(async () => ({ default: (await import("./pages/CustomersPage")).CustomersPage }));
const CustomerDetailPage = lazy(async () => ({ default: (await import("./pages/CustomerDetailPage")).CustomerDetailPage }));
const OrdersPage = lazy(async () => ({ default: (await import("./pages/OrdersPage")).OrdersPage }));
const OrderDetailPage = lazy(async () => ({ default: (await import("./pages/OrderDetailPage")).OrderDetailPage }));
const InventoryPage = lazy(async () => ({ default: (await import("./pages/InventoryPage")).InventoryPage }));
const NotificationsPage = lazy(async () => ({ default: (await import("./pages/NotificationsPage")).NotificationsPage }));
const AuditLogsPage = lazy(async () => ({ default: (await import("./pages/AuditLogsPage")).AuditLogsPage }));
const BillingPage = lazy(async () => ({ default: (await import("./pages/BillingPage")).BillingPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./pages/SettingsPage")).SettingsPage }));
const SupportPage = lazy(async () => ({ default: (await import("./pages/SupportPage")).SupportPage }));
const OnboardingPage = lazy(async () => ({ default: (await import("./pages/OnboardingPage")).OnboardingPage }));
const NotFoundPage = lazy(async () => ({ default: (await import("./pages/NotFoundPage")).NotFoundPage }));

function PageLoading(): ReactNode {
  return (
    <div className="flex flex-col gap-4 py-2" aria-label="Loading section">
      <SkeletonText lines={2} className="max-w-md" />
      <SkeletonText lines={5} />
    </div>
  );
}

function Guarded({ permission, children }: { readonly permission: string; readonly children: ReactNode }): ReactNode {
  return <RequirePermission permission={permission}>{children}</RequirePermission>;
}

export default function App(): ReactNode {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Guarded permission="analytics:read"><DashboardPage /></Guarded>} />
            <Route path="/analytics" element={<Guarded permission="analytics:read"><AnalyticsPage /></Guarded>} />
            <Route path="/products" element={<Guarded permission="products:read"><ProductsPage /></Guarded>} />
            <Route path="/products/:id" element={<Guarded permission="products:read"><ProductDetailPage /></Guarded>} />
            <Route path="/customers" element={<Guarded permission="customers:read"><CustomersPage /></Guarded>} />
            <Route path="/customers/:id" element={<Guarded permission="customers:read"><CustomerDetailPage /></Guarded>} />
            <Route path="/orders" element={<Guarded permission="orders:read"><OrdersPage /></Guarded>} />
            <Route path="/orders/:id" element={<Guarded permission="orders:read"><OrderDetailPage /></Guarded>} />
            <Route path="/inventory" element={<Guarded permission="inventory:read"><InventoryPage /></Guarded>} />
            <Route path="/notifications" element={<Guarded permission="notifications:read"><NotificationsPage /></Guarded>} />
            <Route path="/audit-logs" element={<Guarded permission="audit:read"><AuditLogsPage /></Guarded>} />
            <Route path="/billing" element={<Guarded permission="billing:read"><BillingPage /></Guarded>} />
            <Route path="/settings" element={<Guarded permission="store:read"><SettingsPage /></Guarded>} />
            <Route path="/support" element={<SupportPage />} />
            {APP_SECTIONS.filter((section) => section.availability === "roadmap").map((section) => (
              <Route
                key={section.key}
                path={section.path}
                element={
                  section.permission !== null ? (
                    <Guarded permission={section.permission}>
                      <SectionRoadmapPage section={section} />
                    </Guarded>
                  ) : (
                    <SectionRoadmapPage section={section} />
                  )
                }
              />
            ))}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
