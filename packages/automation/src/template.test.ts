import { describe, expect, it } from "vitest";
import {
  isTemplateValid,
  renderTemplate,
  TEMPLATE_VARIABLE_PATHS,
  validateTemplateVars,
  type MessageTemplateContext,
} from "./template";

const CONTEXT: MessageTemplateContext = {
  store: { name: "Mello & Sons", domain: "mello.myshopify.com" },
  customer: {
    firstName: "Ada <admin>",
    lastName: "Lovelace",
    email: "ada@example.com",
    ordersCount: 7,
    totalSpent: "$1,250.00",
  },
  campaign: { name: "July Winback" },
  workflow: { name: "VIP Welcome" },
  unsubscribeUrl: "https://api.example.com/api/v1/t/u/token123",
};

describe("validateTemplateVars", () => {
  it("returns [] for known variables", () => {
    expect(validateTemplateVars("Hi {{ customer.firstName }} from {{store.name}}")).toEqual([]);
    expect(isTemplateValid("{{ unsubscribeUrl }}")).toBe(true);
  });

  it("flags unknown paths, deduped and sorted", () => {
    expect(validateTemplateVars("{{ store.ssn }} {{ customer.ssn }} {{store.ssn}}")).toEqual([
      "customer.ssn",
      "store.ssn",
    ]);
  });

  it("ignores non-variable braces", () => {
    expect(validateTemplateVars("JSON: {\"a\":1} and {{store.name}}")).toEqual([]);
  });

  it("catalog exposes the documented paths", () => {
    expect(TEMPLATE_VARIABLE_PATHS).toContain("customer.firstName");
    expect(TEMPLATE_VARIABLE_PATHS).toContain("campaign.name");
    expect(TEMPLATE_VARIABLE_PATHS).toContain("unsubscribeUrl");
  });
});

describe("renderTemplate — text mode", () => {
  it("substitutes known variables verbatim", () => {
    const out = renderTemplate(
      "Hi {{customer.firstName}}, thanks for shopping at {{store.name}}!",
      CONTEXT,
    );
    expect(out).toBe("Hi Ada <admin>, thanks for shopping at Mello & Sons!");
  });

  it("renders computed fullName + numeric coercions", () => {
    expect(renderTemplate("{{customer.fullName}} · {{customer.ordersCount}}", CONTEXT)).toBe(
      "Ada <admin> Lovelace · 7",
    );
    expect(renderTemplate("spent {{customer.totalSpent}}", CONTEXT)).toBe("spent $1,250.00");
  });

  it("renders unknown variables as empty string (never crashes a send)", () => {
    expect(renderTemplate("A{{unknown.var}}B", CONTEXT)).toBe("AB");
  });

  it("renders missing context slices as empty string", () => {
    const sparse: MessageTemplateContext = { store: { name: "S", domain: "d" } };
    expect(renderTemplate("{{customer.firstName}}", sparse)).toBe("");
    expect(renderTemplate("{{campaign.name}}", sparse)).toBe("");
    expect(renderTemplate("{{customer.fullName}}", sparse)).toBe("");
  });
});

describe("renderTemplate — html mode", () => {
  it("escapes interpolated values", () => {
    const out = renderTemplate("<b>{{customer.firstName}}</b>", CONTEXT, { html: true });
    expect(out).toBe("<b>Ada &lt;admin&gt;</b>");
  });

  it("escapes quotes and ampersands", () => {
    const ctx: MessageTemplateContext = {
      store: { name: `A&B "Co" 'Ltd'`, domain: "d" },
    };
    expect(renderTemplate("{{store.name}}", ctx, { html: true })).toBe(
      "A&amp;B &quot;Co&quot; &#39;Ltd&#39;",
    );
  });
});
