import { useState, type ReactNode } from "react";
import { Bug, ChevronRight, LifeBuoy, Mail, ScrollText } from "lucide-react";
import { Card, CardBody, CardHeader } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../lib/auth-context";
import { TicketsWorkspace } from "./support/TicketsWorkspace";

/**
 * Real support surface: a direct mail channel (with store + error id context),
 * honest FAQ entries about how THIS build behaves, and where to find the
 * machine-readable trail. No fake chat widget, no dead "docs" links.
 */

const SUPPORT_EMAIL = "support@profittool.ai";

const FAQS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "How fresh is my data?",
    a: "Webhooks keep products, customers, orders and inventory current in near real time. The Sync tab in Settings shows the exact last run per module, and you can trigger a manual re-pull at any time.",
  },
  {
    q: "Why does my dashboard show zeros?",
    a: "Zeros are real computed values, not placeholders: either the first sync has not finished yet, or there were genuinely no sales in the selected range. Check Settings → Sync for module status.",
  },
  {
    q: "How long is the free trial?",
    a: "Every plan includes a free trial (the exact length is shown on the Billing page). Charges happen only if you approve the subscription in Shopify after the trial ends.",
  },
  {
    q: "Who can see the audit log?",
    a: "Roles with the audit:read permission — owners and admins by default. The trail is append-only: nobody, including our team, can edit or delete entries.",
  },
  {
    q: "What does the AI autonomy mode do?",
    a: "It is a stored preference the AI engine reads before executing any action. In Manual mode every AI recommendation waits for your explicit approval, forever, until you change it.",
  },
  {
    q: "How do I report a problem precisely?",
    a: "Every error screen shows an error id — include it in your email. It maps one-to-one to a server log line, which turns 'it broke' into an exact trace we can fix.",
  },
];

function FaqItem({ faq }: { readonly faq: { q: string; a: string } }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-subtle last:border-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-1 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="text-sm font-medium text-foreground">{faq.q}</span>
        <ChevronRight className={`size-4 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
      </button>
      {open && <p className="px-1 pb-4 text-[13px] leading-relaxed text-muted">{faq.a}</p>}
    </div>
  );
}

export function SupportPage(): ReactNode {
  const { hasPermission } = useAuth();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Support"
        subtitle="Answers about this build, and a direct line to the team when those are not enough."
      />
      {hasPermission("support:read") && <TicketsWorkspace />}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Contact us" />
            <CardBody className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted">
              <p className="flex gap-2.5">
                <Mail className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>
                  Email{" "}
                  <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-primary transition-colors hover:text-primary-strong">
                    {SUPPORT_EMAIL}
                  </a>{" "}
                  — a human answers every message, typically within one business day.
                </span>
              </p>
              <p className="flex gap-2.5">
                <Bug className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                Reporting a bug? Include the error id shown on the error screen plus what you clicked — that is
                usually everything we need.
              </p>
              <p className="flex gap-2.5">
                <ScrollText className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
                <span>
                  Investigating who did what?{" "}
                  <a href="/audit-logs" className="font-medium text-primary transition-colors hover:text-primary-strong">
                    Audit logs
                  </a>{" "}
                  record every authenticated action with timestamp and IP.
                </span>
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-start gap-3">
              <LifeBuoy className="mt-0.5 size-5 shrink-0 text-ai" aria-hidden />
              <p className="text-[13px] leading-relaxed text-muted">
                <span className="font-semibold text-foreground">Guided tour missing?</span> Re-run onboarding any
                time from{" "}
                <a href="/onboarding" className="font-medium text-primary transition-colors hover:text-primary-strong">
                  the onboarding wizard
                </a>
                — it is safe: completed steps are detected and skipped.
              </p>
            </CardBody>
          </Card>
        </div>
        <Card className="lg:col-span-2">
          <CardHeader title="Frequently asked" subtitle="True for the version you are running right now" />
          <CardBody className="px-5 py-2">
            {FAQS.map((faq) => (
              <FaqItem key={faq.q} faq={faq} />
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
