import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SectionRoadmapPage } from "./SectionRoadmapPage";
import { NotFoundPage } from "./NotFoundPage";
import { APP_SECTIONS } from "../shell/sections";
import { renderApp } from "../test-support/render";

describe("SectionRoadmapPage", () => {
  const campaigns = APP_SECTIONS.find((s) => s.key === "campaigns");

  it("states what arrives, when, and shows zero actionable controls (no-placeholders rule)", () => {
    renderApp(campaigns !== undefined ? <SectionRoadmapPage section={campaigns} /> : <p>missing</p>, {
      route: "/campaigns",
    });
    expect(screen.getByRole("heading", { name: "Campaigns" })).toBeInTheDocument();
    expect(screen.getByText("Arriving in milestone M6")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /live dashboard/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /full analytics/i })).toHaveAttribute("href", "/analytics");
    // The no-placeholders rule, asserted in the DOM: zero actionable controls.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
