import {
  ChartColumn,
  Lightbulb,
  LayoutDashboard,
  Megaphone,
  Package,
  ScrollText,
  Settings,
  ShoppingCart,
  Boxes,
  Bell,
  CreditCard,
  LifeBuoy,
  Sparkles,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * Navigation registry — the 15 application surfaces defined by P9, in P9
 * order. This is the ONLY place section metadata lives: sidebar groups, the
 * command palette, route guards, and tests all read from here, so navigation
 * can never drift between entry points.
 *
 * `permission` mirrors the RBAC codes seeded in M1 — a section renders only
 * when the signed-in user holds it (server enforces the same rule; the shell
 * merely keeps impossible destinations out of sight). `availability` marks
 * surfaces whose backend ships in a later milestone: they render an honest
 * roadmap page (live links to working surfaces, NO fake controls).
 */

export type SectionGroup = "Overview" | "Intelligence" | "Catalog" | "System";

export interface AppSection {
  readonly key: string;
  readonly path: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: SectionGroup;
  readonly permission: string | null;
  readonly availability: "live" | "roadmap";
  /** Milestone that delivers the roadmap surface (P-Roadmap). */
  readonly milestone: string | null;
  readonly description: string;
}

export const APP_SECTIONS: readonly AppSection[] = [
  {
    key: "dashboard",
    path: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    group: "Overview",
    permission: "analytics:read",
    availability: "live",
    milestone: null,
    description: "Revenue, orders, customers and store health at a glance.",
  },
  {
    key: "ai-command-center",
    path: "/ai",
    label: "AI Command Center",
    icon: Sparkles,
    group: "Intelligence",
    permission: "recommendations:read",
    availability: "roadmap",
    milestone: "M4",
    description: "The AI engine's home: live decision feed, autonomy controls and profit impact.",
  },
  {
    key: "recommendations",
    path: "/recommendations",
    label: "Recommendations",
    icon: Lightbulb,
    group: "Intelligence",
    permission: "recommendations:read",
    availability: "roadmap",
    milestone: "M4",
    description: "Ranked, revenue-attributed actions the AI proposes — approve, reject, automate.",
  },
  {
    key: "customers",
    path: "/customers",
    label: "Customers",
    icon: Users,
    group: "Catalog",
    permission: "customers:read",
    availability: "live",
    milestone: null,
    description: "Synced customers with lifetime value, order history and segments.",
  },
  {
    key: "products",
    path: "/products",
    label: "Products",
    icon: Package,
    group: "Catalog",
    permission: "products:read",
    availability: "live",
    milestone: null,
    description: "Synced catalog with variants, pricing and publishing state.",
  },
  {
    key: "orders",
    path: "/orders",
    label: "Orders",
    icon: ShoppingCart,
    group: "Catalog",
    permission: "orders:read",
    availability: "live",
    milestone: null,
    description: "Synced orders with financial status, fulfillment and line items.",
  },
  {
    key: "inventory",
    path: "/inventory",
    label: "Inventory",
    icon: Boxes,
    group: "Catalog",
    permission: "inventory:read",
    availability: "live",
    milestone: null,
    description: "Stock levels per location with low-stock alerting.",
  },
  {
    key: "automation",
    path: "/automation",
    label: "Automation",
    icon: Workflow,
    group: "Intelligence",
    permission: "automation:read",
    availability: "roadmap",
    milestone: "M4",
    description: "Rules that let the AI execute approved playbooks on its own.",
  },
  {
    key: "analytics",
    path: "/analytics",
    label: "Analytics",
    icon: ChartColumn,
    group: "Overview",
    permission: "analytics:read",
    availability: "live",
    milestone: null,
    description: "Sales trends, top products and top customers over 7/30/90 days.",
  },
  {
    key: "campaigns",
    path: "/campaigns",
    label: "Campaigns",
    icon: Megaphone,
    group: "Intelligence",
    permission: null,
    availability: "roadmap",
    milestone: "M6",
    description: "AI-drafted marketing campaigns measured against real revenue.",
  },
  {
    key: "notifications",
    path: "/notifications",
    label: "Notifications",
    icon: Bell,
    group: "System",
    permission: "notifications:read",
    availability: "live",
    milestone: null,
    description: "Everything the platform flagged — sync, security, billing, AI.",
  },
  {
    key: "audit-logs",
    path: "/audit-logs",
    label: "Audit Logs",
    icon: ScrollText,
    group: "System",
    permission: "audit:read",
    availability: "live",
    milestone: null,
    description: "Immutable trail of who did what, when, from where.",
  },
  {
    key: "billing",
    path: "/billing",
    label: "Billing",
    icon: CreditCard,
    group: "System",
    permission: "billing:read",
    availability: "live",
    milestone: null,
    description: "Plan, trial countdown and subscription state.",
  },
  {
    key: "settings",
    path: "/settings",
    label: "Settings",
    icon: Settings,
    group: "System",
    permission: "store:read",
    availability: "live",
    milestone: null,
    description: "Store profile, appearance, branding, AI preferences and sync.",
  },
  {
    key: "support",
    path: "/support",
    label: "Support",
    icon: LifeBuoy,
    group: "System",
    permission: null,
    availability: "live",
    milestone: null,
    description: "Help, answers and a direct line to the team.",
  },
];

export const SECTION_GROUPS: readonly SectionGroup[] = ["Overview", "Intelligence", "Catalog", "System"];

export function sectionsForGroup(group: SectionGroup): readonly AppSection[] {
  return APP_SECTIONS.filter((section) => section.group === group);
}

export function sectionByPath(pathname: string): AppSection | null {
  const match = APP_SECTIONS.find(
    (section) => pathname === section.path || pathname.startsWith(`${section.path}/`),
  );
  return match ?? null;
}

export function visibleSections(hasPermission: (permission: string) => boolean): readonly AppSection[] {
  return APP_SECTIONS.filter(
    (section) => section.permission === null || hasPermission(section.permission),
  );
}
