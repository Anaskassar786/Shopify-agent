import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SectionRoadmapPage } from "./SectionRoadmapPage";
import { NotFoundPage } from "./NotFoundPage";
import { APP_SECTIONS, type AppSection } from "../shell/sections";
import { renderApp } from "../test-support/render";

describe("SectionRoadmapPage", () => {
  /**
   * M6 promoted the last roadmap surface (Campaigns) to live — the roadmap
   * shell stays as permanent infrastructure for future milestones, so the
   * unit test feeds it a synthetic section (component prop, not a fixture
   * pretending to be product data).
   */
  const synthetic: AppSection = {
    key: "future",
    path: "/future",
    label: "Future surface",
    icon: APP_SECTIONS[0]!.icon,
    group: "Intelligence",
    permission: null,
    availability: "roadmap",
    milestone: "M9",
    description: "Something honest that will ship in a later milestone.",
  };

  it("states what arrives, when, and shows zero actionable controls (no-placeholders rule)", () => {
    renderApp(<SectionRoadmapPage section={synthetic} />, { route: "/future" });
    expect(screen.getByRole("heading", { name: "Future surface" })).toBeInTheDocument();
    expect(screen.getByText("Arriving in milestone M9")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /live dashboard/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /full analytics/i })).toHaveAttribute("href", "/analytics");
    // The no-placeholders rule, asserted in the DOM: zero actionable controls.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("every registered section is live or honestly dated", () => {
    for (const section of APP_SECTIONS) {
      if (section.availability === "roadmap") expect(section.milestone).not.toBeNull();
    }
  });
});

describe("NotFoundPage", () => {
  it("offers a safe way back", async () => {
    renderApp(
      <Routes>
        <Route path="/dashboard" element={<p>dashboard content</p>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>,
      { route: "/definitely-not-a-page" },
    );
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toHaveAttribute("href", "/dashboard");
  });
});
