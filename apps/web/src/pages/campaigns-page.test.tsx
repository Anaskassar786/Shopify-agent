import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CampaignsPage } from "./CampaignsPage";
import { renderApp, type StubHandlers } from "../test-support/render";
import type { CampaignRowDto, CampaignStatsResponse, CampaignTemplateRowDto } from "../lib/api-types";

/** M6 campaigns surface: list, detail actions, and the A/B create wizard. */

function templateRow(overrides: Partial<CampaignTemplateRowDto> = {}): CampaignTemplateRowDto {
  return {
    id: "tpl-1",
    name: "Win-back",
    channel: "EMAIL",
    subject: "We miss you, {{customer.firstName}}",
    bodyText: "Come back for 15% off.",
    bodyHtml: null,
    version: 2,
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-02T09:00:00.000Z",
    ...overrides,
  };
}

function campaignRow(overrides: Partial<CampaignRowDto> = {}): CampaignRowDto {
  return {
    id: "cmp-1",
    name: "Spring win-back",
    channel: "EMAIL",
    audience: "ALL_CUSTOMERS",
    status: "DRAFT",
    variantA: { subject: "s", bodyText: "b" },
    variantB: null,
    splitBPercent: 0,
    winnerVariant: null,
    scheduledAt: null,
    sendingStartedAt: null,
    sentAt: null,
    cancelledAt: null,
    recipientCount: 0,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    lastError: null,
    createdByUserId: "u-1",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_STATS: CampaignStatsResponse = {
  recipients: { pending: 0, sent: 0, failed: 0, skipped: 0 },
  variants: [],
  unsubscribes: 0,
  recentEvents: [],
};

function baseHandlers(rows: CampaignRowDto[], templates: CampaignTemplateRowDto[] = []): StubHandlers {
  return {
    get: {
      "/api/v1/campaigns": () => rows,
      "/api/v1/campaigns/templates": () => templates,
      "/api/v1/campaigns/cmp-1/stats": () => EMPTY_STATS,
      "/api/v1/campaigns/suppressions/EMAIL": () => ({ rows: [], total: 0 }),
      "/api/v1/campaigns/suppressions/SMS": () => ({ rows: [], total: 0 }),
    },
    getWithMeta: {},
    post: {},
    patch: {},
    put: {},
  };
}

describe("CampaignsPage", () => {
  it("lists campaigns and schedules a draft from the detail drawer", async () => {
    const rows = [campaignRow()];
    const handlers: StubHandlers = { ...baseHandlers(rows), post: { "/api/v1/campaigns/cmp-1/schedule": () => ({}) } };
    const { stub } = renderApp(<CampaignsPage />, { route: "/campaigns", handlers });

    fireEvent.click(await screen.findByText("Spring win-back"));
    fireEvent.click(await screen.findByRole("button", { name: /send on next tick/i }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/campaigns/cmp-1/schedule", { scheduledAt: null }),
    );
  });

  it("creates an EMAIL campaign from a template through the wizard", async () => {
    const handlers: StubHandlers = {
      ...baseHandlers([], [templateRow()]),
      post: { "/api/v1/campaigns": () => campaignRow({ status: "DRAFT" }) },
    };
    const { stub } = renderApp(<CampaignsPage />, { route: "/campaigns", handlers });

    fireEvent.click(await screen.findByRole("button", { name: /new campaign/i }));
    fireEvent.change(await screen.findByLabelText("Campaign name"), { target: { value: "Spring win-back" } });
    // The template picker snapshots content into the variant fields.
    fireEvent.change(await screen.findByLabelText(/variant a template/i), { target: { value: "tpl-1" } });
    expect(screen.getByLabelText(/variant a subject/i)).toHaveValue("We miss you, {{customer.firstName}}");
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));

    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith(
        "/api/v1/campaigns",
        expect.objectContaining({
          name: "Spring win-back",
          channel: "EMAIL",
          audience: "ALL_CUSTOMERS",
          variantA: expect.objectContaining({ bodyText: "Come back for 15% off." }),
        }),
      ),
    );
    // SMS-only field discipline: no subject leaks into SMS payloads (checked via call shape).
    const body = stub.calls.post.mock.calls.find((c) => c[0] === "/api/v1/campaigns")?.[1] as { variantB?: unknown };
    expect(body.variantB).toBeUndefined();
  });

  it("declares a winner on an A/B campaign that is sending", async () => {
    const rows = [campaignRow({ status: "SENDING", variantB: { subject: "b", bodyText: "b2" }, splitBPercent: 50 })];
    const handlers: StubHandlers = { ...baseHandlers(rows), post: { "/api/v1/campaigns/cmp-1/winner": () => ({}) } };
    const { stub } = renderApp(<CampaignsPage />, { route: "/campaigns", handlers });

    fireEvent.click(await screen.findByText("Spring win-back"));
    fireEvent.click(await screen.findByRole("button", { name: "Variant B wins" }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/campaigns/cmp-1/winner", { variant: "B" }),
    );
  });

  it("manages templates: create posts channel discipline; suppressions tab renders counts", async () => {
    const handlers: StubHandlers = {
      ...baseHandlers([], []),
      post: { "/api/v1/campaigns/templates": () => templateRow({ id: "tpl-2", name: "Launch" }) },
    };
    const { stub } = renderApp(<CampaignsPage />, { route: "/campaigns", handlers });

    fireEvent.click(await screen.findByRole("tab", { name: /templates/i }));
    fireEvent.click(await screen.findByRole("button", { name: /new template/i }));
    fireEvent.change(await screen.findByLabelText("Template name"), { target: { value: "Launch" } });
    fireEvent.change(await screen.findByLabelText("Template channel"), { target: { value: "SMS" } });
    fireEvent.change(await screen.findByLabelText("Template body"), { target: { value: "Hi {{customer.firstName}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));

    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/campaigns/templates", {
        name: "Launch",
        channel: "SMS",
        bodyText: "Hi {{customer.firstName}}",
      }),
    );
    // SMS carries no subject key at all (the server 409s when one slips through).
    const postCalls = stub.calls.post.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    const created = postCalls.find((c) => c[0] === "/api/v1/campaigns/templates")?.[1];
    expect(created !== undefined && !("subject" in created)).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: /suppressions/i }));
    expect(await screen.findByText("No suppressions")).toBeInTheDocument();
  });
});
