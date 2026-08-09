import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChartColumn, LayoutDashboard, Settings } from "lucide-react";
import { Card, CardBody } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import type { AppSection } from "../shell/sections";

/**
 * Honest surface for sections whose backend ships in a later milestone (the
 * no-placeholders rule, applied to navigation): the page says what the
 * surface WILL do, when it arrives, and routes the merchant to the parts of
 * the product that already work. There are intentionally zero interactive
 * controls here — nothing pretends to function.
 */
export function SectionRoadmapPage({ section }: { readonly section: AppSection }): ReactNode {
  const Icon = section.icon;
  return (
    <div>
      <PageHeader title={section.label} subtitle={section.description} />
      <Card className="mx-auto max-w-2xl">
        <CardBody className="flex flex-col items-center gap-5 py-12 text-center">
          <div className="flex size-14 items-center justify-center rounded-xl bg-ai-soft text-ai">
            <Icon className="size-7" aria-hidden />
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">
              Arriving in milestone {section.milestone ?? "soon"}
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
              {section.key === "ai-command-center" &&
                "The command center will stream every AI decision with its reasoning, confidence and expected revenue impact — and let you steer autonomy from one place."}
              {section.key === "recommendations" &&
                "Ranked recommendations will appear here with projected profit, one-click approve/reject, and measured outcomes after execution."}
              {section.key === "automation" &&
                "Automation will let approved playbooks run on their own inside guardrails you define — every run still lands in the audit log."}
              {section.key === "campaigns" &&
                "Campaigns will draft channel-ready marketing from your real catalog and rank it by measured revenue, not vanity metrics."}
            </p>
          </div>
          <div className="w-full max-w-md rounded-lg border border-subtle bg-surface-raised/40 px-5 py-4 text-left">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">Already working today</p>
            <ul className="mt-2.5 flex flex-col gap-2 text-[13px]">
              <li>
                <Link to="/dashboard" className="group inline-flex items-center gap-2 font-medium text-foreground transition-colors hover:text-primary">
                  <LayoutDashboard className="size-4 text-primary" aria-hidden />
                  Live dashboard with revenue, orders and store health
                  <ArrowRight className="size-3 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
              <li>
                <Link to="/analytics" className="group inline-flex items-center gap-2 font-medium text-foreground transition-colors hover:text-primary">
                  <ChartColumn className="size-4 text-primary" aria-hidden />
                  Full analytics over 7/30/90 days
                  <ArrowRight className="size-3 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
              <li>
                <Link to="/settings?tab=branding" className="group inline-flex items-center gap-2 font-medium text-foreground transition-colors hover:text-primary">
                  <Settings className="size-4 text-primary" aria-hidden />
                  Set your AI autonomy preference now — the engine reads it at activation
                  <ArrowRight className="size-3 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
            </ul>
          </div>
          <p className="text-[11px] leading-relaxed text-faint">
            This page intentionally contains no disabled buttons or sample data — the surface turns real the
            moment its backend ships.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
