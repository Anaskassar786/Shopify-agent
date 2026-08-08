import {
  ChartColumn,
  Download,
  FileText,
  Lightbulb,
  LayoutDashboard,
  Megaphone,
  MessageSquareText,
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
 * Navigation registry — the application surfaces defined by P9 (extended by
 * M8 with the copilot + report vault), in P9 order. This is the ONLY place
 * section metadata lives: sidebar groups, the command palette, route guards,
 * and tests all read from here, so navigation can never drift between entry
 * points.
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
    availability: "live",
    milestone: null,
    description: "The AI engine's home: live decision feed, autonomy controls and profit impact.",
  },
  {
    key: "recommendations",
    path: "/recommendations",
    label: "Recommendations",
    icon: Lightbulb,
    group: "Intelligence",
    permission: "recommendations:read",
    availability: "live",
    milestone: null,
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
    key: "copilot",
    path: "/copilot",
    label: "AI Copilot",
    icon: MessageSquareText,
    group: "Intelligence",
    permission: "copilot:read",
    availability: "live",
    milestone: null,
    description: "Ask about your store in plain words — answers render from stamped evidence, never invented numbers.",
  },
  {
    key: "automation",
    path: "/automation",
    label: "Automation",
    icon: Workflow,
    group: "Intelligence",
    permission: "automation:read",
    availability: "live",
    milestone: null,
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
    permission: "campaigns:read",
    availability: "live",
    milestone: null,
    description:
      "Email and SMS campaigns with A/B variants, tracked opens and clicks, and honest unsubscribe handling.",
  },
  {
    key: "reports",
    path: "/reports",
    label: "Reports",
    icon: FileText,
    group: "Intelligence",
    permission: "reports:read",
    availability: "live",
    milestone: null,
    description: "Scheduled enterprise reports with Executive-agent summaries, filed as PDFs and deliverable by email.",
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
    key: "exports",
    path: "/exports",
    label: "Exports",
    icon: Download,
    group: "System",
    permission: "exports:read",
    availability: "live",
    milestone: null,
    description:
      "Queued CSV, XLSX and PDF reports of your real data, downloadable for seven days after they finish.",
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
    description: "Tickets with the team, answers about this build, and a direct mail line.",
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
