import { describe, expect, it } from "vitest";
import { renderTrialNudge, type TrialNudgeFacts } from "./trial-templates";

const base: TrialNudgeFacts = {
  shopName: "Demo Store",
  day: 1,
  openRecommendations: 3,
  openEstimatedRevenueCents: 123_456,
  attributedRevenueCents: 0,
  daysRemaining: 2,
  appUrl: "https://app.profit.test/billing",
};

describe("renderTrialNudge — D1 (opportunities discovered)", () => {
  it("names the real open-opportunity count (plural + singular)", () => {
    expect(renderTrialNudge(base).subject).toBe("Your store has 3 open opportunities");
    expect(renderTrialNudge({ ...base, openRecommendations: 1 }).subject).toBe(
      "Your store has 1 open opportunity",
    );
  });

  it("falls back to honest copy when nothing is open yet", () => {
    expect(renderTrialNudge({ ...base, openRecommendations: 0 }).subject).toBe(
      "Your AI analysis is ready to explore",
    );
  });
});

describe("renderTrialNudge — D2 (recovery value)", () => {
  it("quotes the deterministic estimate in dollars", () => {
    const rendered = renderTrialNudge({ ...base, day: 2 });
    expect(rendered.subject).toBe("AI found a potential $1,234.56 recovery opportunity");
    expect(rendered.textBody).toContain("$1,234.56");
    expect(rendered.textBody).toContain("Approve your first recommendation");
  });

  it("mentions recovered revenue only when attribution actually measured some", () => {
    const rendered = renderTrialNudge({ ...base, day: 2, attributedRevenueCents: 5000 });
    expect(rendered.textBody).toContain("recovered $50.00");
    const zero = renderTrialNudge({ ...base, day: 2, openEstimatedRevenueCents: 0 });
    expect(zero.subject).toBe("Your AI opportunities update");
  });
});

describe("renderTrialNudge — D3 (trial ending)", () => {
  it("says tomorrow while a day remains, today on the final day", () => {
    expect(renderTrialNudge({ ...base, day: 3, daysRemaining: 1 }).subject).toBe(
      "Demo Store: your free trial ends tomorrow",
    );
    expect(renderTrialNudge({ ...base, day: 3, daysRemaining: 0 }).subject).toBe(
      "Demo Store: your free trial ends today",
    );
  });
});

describe("renderTrialNudge — output safety + complete bodies", () => {
  it("escapes merchant-controlled text inside the HTML body", () => {
    const hostile = renderTrialNudge({
      ...base,
      day: 3,
      shopName: "<script>alert(1)</script>",
    });
    expect(hostile.htmlBody).not.toContain("<script>alert(1)</script>");
    expect(hostile.htmlBody).toContain("&lt;script&gt;");
    // The plain-text body is never escaped — email clients render text as text.
    expect(hostile.subject).toContain("<script>");
  });

  it("always deep-links to the app and signs off", () => {
    for (const day of [1, 2, 3] as const) {
      const rendered = renderTrialNudge({ ...base, day });
      expect(rendered.textBody).toContain("https://app.profit.test/billing");
      expect(rendered.textBody).toContain("— PROFIT TOOL AI");
      expect(rendered.htmlBody).toContain("trial day " + String(day));
    }
  });
});
