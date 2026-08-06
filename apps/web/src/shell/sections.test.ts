import { describe, expect, it } from "vitest";
import { APP_SECTIONS, SECTION_GROUPS, sectionByPath, sectionsForGroup, visibleSections } from "./sections";
import { OWNER_PERMISSIONS, VIEWER_PERMISSIONS } from "../test-support/render";

const hasAll = (p: string): boolean => (OWNER_PERMISSIONS as readonly string[]).includes(p);
const hasViewer = (p: string): boolean => (VIEWER_PERMISSIONS as readonly string[]).includes(p);

describe("section registry (P9: 15 surfaces)", () => {
  it("declares exactly the 15 definitive sections in P9 order", () => {
    expect(APP_SECTIONS).toHaveLength(15);
    expect(APP_SECTIONS.map((s) => s.label)).toEqual([
      "Dashboard",
      "AI Command Center",
      "Recommendations",
      "Customers",
      "Products",
      "Orders",
      "Inventory",
      "Automation",
      "Analytics",
      "Campaigns",
      "Notifications",
      "Audit Logs",
      "Billing",
      "Settings",
      "Support",
    ]);
  });

  it("has unique keys and paths", () => {
    expect(new Set(APP_SECTIONS.map((s) => s.key)).size).toBe(15);
    expect(new Set(APP_SECTIONS.map((s) => s.path)).size).toBe(15);
  });

  it("every section belongs to a declared group with content", () => {
    for (const group of SECTION_GROUPS) {
      expect(sectionsForGroup(group).length).toBeGreaterThan(0);
    }
    expect(SECTION_GROUPS.flatMap(sectionsForGroup)).toHaveLength(15);
  });

  it("roadmap sections declare a milestone and live ones do not", () => {
    const roadmap = APP_SECTIONS.filter((s) => s.availability === "roadmap").map((s) => s.key);
    expect(roadmap.sort()).toEqual(["campaigns"]); // M4 shipped ai-command-center, recommendations, automation
    for (const section of APP_SECTIONS) {
      if (section.availability === "roadmap") expect(section.milestone).not.toBeNull();
      else expect(section.milestone).toBeNull();
    }
  });

  it("sectionByPath matches exact and nested paths only", () => {
    expect(sectionByPath("/products")?.key).toBe("products");
    expect(sectionByPath("/products/abc-123")?.key).toBe("products");
    expect(sectionByPath("/audit-logs")?.key).toBe("audit-logs");
    expect(sectionByPath("/nope")).toBeNull();
  });

  it("visibleSections honors the permission matrix", () => {
    const owner = visibleSections(hasAll);
    expect(owner).toHaveLength(15);
    const viewer = visibleSections(hasViewer);
    const viewerKeys = viewer.map((s) => s.key);
    // Viewer: dashboard, ai-command-center, recommendations, analytics,
    // campaigns (permissionless), notifications, settings (store:read), support.
    expect(viewerKeys).toContain("dashboard");
    expect(viewerKeys).toContain("notifications");
    expect(viewerKeys).toContain("campaigns");
    expect(viewerKeys).toContain("support");
    expect(viewerKeys).not.toContain("products");
    expect(viewerKeys).not.toContain("audit-logs");
    expect(viewerKeys).not.toContain("billing");
  });
});
