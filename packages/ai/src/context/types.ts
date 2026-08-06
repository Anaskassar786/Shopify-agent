/**
 * Business Context (P10: the bounded, privacy-minimized snapshot every agent
 * reasons over). Rules:
 *  - built ONLY from the M2 analytics/data planes — dashboards and AI read the
 *    same numbers, so explanations reconcile with what merchants see;
 *  - every list is capped (prompt size is a cost+latency budget);
 *  - NO payment data, NO full emails — first names + IDs + money in cents.
 *    (The recipient address required to SEND mail exists only at tool
 *    execution time, resolved server-side from the checkout row.)
 */

export interface ContextWindow {
  readonly daysAnalyzed: number;
  readonly from: string; // ISO date
  readonly to: string; // ISO date
}

export interface StoreContext {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly countryCode: string | null;
}

export interface RevenueContext {
  readonly windowDays: number;
  readonly netCents: number;
  readonly grossCents: number;
  readonly discountsCents: number;
  readonly refundsCents: number;
  readonly priorNetCents: number;
  /** Signed % change vs the preceding equal window; null when prior had no sales. */
  readonly trendPct: number | null;
  readonly ordersCount: number;
  readonly cancelledCount: number;
  readonly aovCents: number;
  /** Daily series for evidence (oldest → newest), capped at windowDays. */
  readonly daily: readonly { readonly date: string; readonly netCents: number; readonly orders: number }[];
}

export interface CustomerRef {
  readonly id: string;
  readonly firstName: string | null;
  readonly ltvCents: number;
  readonly ordersCount: number;
  readonly lastOrderAt: string | null; // ISO
  readonly daysSinceLastOrder: number | null;
}

export interface CustomersContext {
  readonly total: number;
  readonly newLastWindow: number;
  readonly vip: readonly CustomerRef[];
  readonly inactive: readonly CustomerRef[];
  readonly atRisk: readonly CustomerRef[];
}

export interface ProductRef {
  readonly id: string;
  readonly title: string;
  readonly priceCents: number;
}

export interface LowStockRef extends ProductRef {
  readonly onHand: number;
  readonly velocityPerDay: number;
  readonly daysOfStock: number;
}

export interface DeadStockRef extends ProductRef {
  readonly onHand: number;
  readonly unitsSoldInWindow: number;
  readonly daysListed: number;
}

export interface ProductsContext {
  readonly trackedCount: number;
  readonly topByRevenue: readonly (ProductRef & { readonly revenueCents: number; readonly units: number })[];
  readonly lowStock: readonly LowStockRef[];
  readonly deadStock: readonly DeadStockRef[];
}

export interface AbandonedCheckoutRef {
  readonly token: string;
  readonly customerId: string | null;
  readonly firstName: string | null;
  readonly hasEmail: boolean;
  readonly totalCents: number;
  readonly currency: string;
  readonly itemCount: number;
  readonly itemsPreview: readonly { readonly title: string; readonly quantity: number }[];
  readonly webUrl: string | null;
  readonly createdAt: string; // ISO
  readonly hoursAgo: number;
}

export interface CheckoutsContext {
  readonly abandonedCount: number;
  readonly abandonedValueCents: number;
  readonly abandoned: readonly AbandonedCheckoutRef[];
}

export interface RefundsContext {
  readonly count: number;
  readonly cents: number;
  /** % of window sales value refunded. */
  readonly ratePct: number;
}

export interface InventoryContext {
  readonly trackedVariants: number;
  readonly outOfStock: number;
  readonly lowStock: number;
}

/** Merchant automation policy snapshot the engine must respect (P3 modes + guardrails). */
export interface AutomationPolicy {
  readonly mode: "MANUAL" | "SEMI_AUTOMATIC" | "FULLY_AUTOMATIC";
  readonly abandonedCartEnabled: boolean;
  readonly abandonedCartDelayHours: number;
  readonly abandonedCartMinValueCents: number;
  readonly abandonedCartDiscountPercent: number; // 0 = no discount attached
  readonly maxAutoDiscountPercent: number; // hard ceiling for any auto-created discount
  readonly maxAutoApproveEstimatedRevenueCents: number; // autopilot value ceiling
}

export interface BusinessContext {
  readonly store: StoreContext;
  readonly window: ContextWindow;
  readonly revenue: RevenueContext;
  readonly customers: CustomersContext;
  readonly products: ProductsContext;
  readonly checkouts: CheckoutsContext;
  readonly refunds: RefundsContext;
  readonly inventory: InventoryContext;
  readonly policy: AutomationPolicy;
  /** Learning-loop inputs: acceptance + realized performance of past recommendations. */
  readonly learning: {
    readonly generatedTotal: number;
    readonly acceptedTotal: number;
    readonly rejectedTotal: number;
    readonly acceptanceRatePct: number | null;
    readonly attributedRevenueCents: number;
    readonly attributedOrders: number;
  };
  readonly computedAt: string; // ISO
}

/** Caps — prompt-size budget per slice (P10 cost optimization). */
export const CONTEXT_CAPS = {
  vip: 20,
  inactive: 20,
  atRisk: 20,
  topProducts: 10,
  lowStock: 20,
  deadStock: 20,
  abandoned: 25,
  dailySeries: 30,
} as const;
