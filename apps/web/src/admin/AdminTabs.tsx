import type { ReactNode } from "react";
import { NavButton } from "./AdminNav";

/** Section tabs shared by the admin views (real routes, never fake buttons). */
export function AdminTabs(): ReactNode {
  return (
    <nav className="mb-5 flex flex-wrap items-center gap-2" aria-label="Admin sections">
      <NavButton to="/admin/overview" label="Overview" />
      <NavButton to="/admin/merchants" label="Merchants" />
      <NavButton to="/admin/ai-usage" label="AI usage" />
      <NavButton to="/admin/tickets" label="Tickets" />
      <NavButton to="/admin/account-actions" label="Account actions" />
      <NavButton to="/admin/actions" label="Action log" />
      <NavButton to="/admin/access-review" label="Access review" />
    </nav>
  );
}
