import { useState, type ReactNode } from "react";
import { BadgeCheck, Bug, ChevronRight, LifeBuoy, Mail, ScrollText, ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../lib/auth-context";
import { useStoreQuery } from "../lib/queries";
import { TicketsWorkspace } from "./support/TicketsWorkspace";

/**
 * Real support surface: a direct mail channel (with store + error id context),
 * honest FAQ entries about how THIS build behaves, and where to find the
 * machine-readable trail. No fake chat widget, no dead "docs" links.
 * The mail channel comes from the platform configuration (SUPPORT_EMAIL,
 * shared with the /legal plane) — never a hardcoded address.
 */

/** Public legal pages served by the API outside the SPA shell (M7 legal plane). */
const LEGAL_LINKS: ReadonlyArray<{ readonly href: string; readonly label: string; readonly description: string }> = [
  { href: "/legal/privacy", label: "Privacy policy", description: "What data we read, why, and how to delete it." },
  { href: "/legal/terms", label: "Terms of service", description: "The contract for using the app." },
  { href: "/legal/refunds", label: "Refund policy", description: "How refunds work through Shopify billing." },
  { href: "/legal/acceptable-use", label: "Acceptable use", description: "The rules that keep the platform safe." },
  { href: "/legal/security", label: "Security", description: "How we protect data and accept disclosures." },
];

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
  const storeQuery = useStoreQuery();
  const supportEmail = storeQuery.data?.supportEmail ?? null;
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
              {supportEmail !== null ? (
                <p className="flex gap-2.5">
                  <Mail className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span>
                    Email{" "}
                    <a href={`mailto:${supportEmail}`} className="font-medium text-primary transition-colors hover:text-primary-strong">
                      {supportEmail}
                    </a>{" "}
                    — a human answers every message, typically within one business day.
                  </span>
                </p>
              ) : (
                <p className="flex gap-2.5">
                  <Mail className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  Open a ticket above — every thread reaches the team directly, and replies land in your mailbox.
                </p>
              )}
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
            <CardHeader title="Legal & policies" subtitle="The public policy pages for this app" />
            <CardBody className="flex flex-col text-[13px] leading-relaxed text-muted">
              <ul className="flex flex-col">
                {LEGAL_LINKS.map((link) => (
                  <li key={link.href} className="border-b border-subtle last:border-0">
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-start justify-between gap-3 px-1 py-3 focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <span>
                        <span className="flex items-center gap-1.5 font-medium text-foreground">
                          <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
                          {link.label}
                        </span>
                        <span className="mt-0.5 block text-muted">{link.description}</span>
                      </span>
                      <ChevronRight className="mt-1 size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-3 flex items-start gap-2 text-[12px] text-faint">
                <BadgeCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                These pages are served unauthenticated so regulators and reviewers can verify them without logging in.
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
