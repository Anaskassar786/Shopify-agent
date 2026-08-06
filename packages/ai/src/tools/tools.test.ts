import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DiscountTool, codeFromIdempotencyKey } from "./discount";
import { RecoveryEmailTool, renderBrandedEmail, emailTemplateParamsSchema } from "./email";
import { ToolExecutionError, ToolUnavailableError, type EmailSender, type ToolContext } from "./port";

/**
 * Tool-layer contract. Network edge (fetch to Shopify) is the only stubbed
 * boundary; the email sender is a capture double implementing the real port.
 */

const adminCtx = { shopDomain: "demo.myshopify.com", accessToken: "tok", apiVersion: "2025-10" };

function toolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    storeId: "store-1",
    admin: adminCtx,
    email: null,
    branding: { storeName: "Demo Store", logoUrl: null, primaryColor: "#123456", supportEmail: null },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DiscountTool", () => {
  const params = { title: "Profit AI — Recovery (PT-AB12CD34)", percent: 10, code: "PT-AB12CD34", expiresInDays: 7 };

  it("creates the price rule then the code and returns checkpoint refs", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith("/price_rules.json")) {
        return new Response(JSON.stringify({ price_rule: { id: 555 } }), { status: 201 });
      }
      return new Response(JSON.stringify({ discount_code: { id: 777, code: "PT-AB12CD34" } }), { status: 201 });
    }));

    const result = await new DiscountTool().execute(toolCtx(), params, {});
    expect(result.toolRefPatch["priceRuleId"]).toBe("555");
    expect(result.toolRefPatch["discountCode"]).toBe("PT-AB12CD34");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(
      "https://demo.myshopify.com/admin/api/2025-10/price_rules/555/discount_codes.json",
    );
    const ruleBody = calls[0]?.body as { price_rule: { value: string; ends_at: string } };
    expect(ruleBody.price_rule.value).toBe("-10");
    expect(new Date(ruleBody.price_rule.ends_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("resumes from a checkpoint — skips an already-created price rule (retry safety)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ discount_code: { id: 1, code: "PT-ZZZ99999" } }), { status: 201 });
    }));
    const result = await new DiscountTool().execute(
      toolCtx(),
      params,
      { priceRuleId: "555", percent: 10 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("discount_codes");
    expect(result.toolRefPatch["discountCode"]).toBe("PT-ZZZ99999");
  });

  it("no admin context → typed UNAVAILABLE (store disconnected mid-flight)", async () => {
    await expect(
      new DiscountTool().execute(toolCtx({ admin: null }), params, {}),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
  });

  it("422 duplicate code is typed non-retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: "code taken" }), { status: 422 })));
    const failure = await new DiscountTool().execute(toolCtx(), params, {}).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect((failure as ToolExecutionError).retryable).toBe(false);
  });

  it("invalid params fail fast at the boundary", async () => {
    await expect(
      new DiscountTool().execute(toolCtx(), { title: "x", percent: 99, code: "has spaces", expiresInDays: 0 }, {}),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});

describe("codeFromIdempotencyKey", () => {
  it("is deterministic and Shopify-code-safe", () => {
    expect(codeFromIdempotencyKey("ab12cd34rest")).toBe("PT-AB12CD34");
    expect(codeFromIdempotencyKey("ab12cd34rest")).toBe(codeFromIdempotencyKey("ab12cd34rest"));
  });
});

class CaptureSender implements EmailSender {
  readonly sent: { to: string; subject: string; htmlBody: string; textBody: string }[] = [];
  failOn: string | null = null;
  async send(input: { to: string; subject: string; htmlBody: string; textBody: string }) {
    if (this.failOn === input.to) throw new Error("smtp down");
    this.sent.push(input);
    return { messageId: `<msg-${this.sent.length}@profit.example>` };
  }
}

function emailParams(overrides: Partial<z.infer<typeof emailTemplateParamsSchema>> = {}) {
  return emailTemplateParamsSchema.parse({
    template: "RECOVERY",
    recipients: [
      { email: "mia@example.com", firstName: "Mia" },
      { email: "bob@example.com", firstName: null },
    ],
    draft: { subject: "Your cart is waiting", body: "We kept your items safe.\n\nThey are almost gone.", ctaLabel: "Return to cart" },
    ctaUrl: "https://checkout.example/recover",
    discountCode: "PT-AB12CD34",
    discountPercent: 10,
    ...overrides,
  });
}

describe("RecoveryEmailTool", () => {
  it("sends branded, personalized, escaped mail to every recipient", async () => {
    const sender = new CaptureSender();
    const result = await new RecoveryEmailTool().execute(
      toolCtx({ email: sender }),
      emailParams(),
      {},
    );
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]?.htmlBody).toContain("Hi Mia,");
    expect(sender.sent[1]?.htmlBody).toContain("Hi there,");
    expect(sender.sent[0]?.htmlBody).toContain("PT-AB12CD34");
    expect(sender.sent[0]?.htmlBody).toContain("#123456"); // tenant branding token
    expect(result.toolRefPatch["sentTo"]).toEqual(["mia@example.com", "bob@example.com"]);
  });

  it("resumes from checkpoint — never double-sends after a mid-loop failure", async () => {
    const sender = new CaptureSender();
    sender.failOn = "bob@example.com";
    const tool = new RecoveryEmailTool();
    const first = await tool.execute(toolCtx({ email: sender }), emailParams(), {}).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ToolExecutionError);
    expect(sender.sent).toHaveLength(1); // mia sent, bob failed

    sender.failOn = null;
    const second = await tool.execute(
      toolCtx({ email: sender }),
      emailParams(),
      { sentTo: ["mia@example.com"], messageIds: { "mia@example.com": "<m1>" } },
    );
    expect(sender.sent).toHaveLength(2); // only bob this time
    expect((second.toolRefPatch["sentTo"] as string[]).sort()).toEqual(["bob@example.com", "mia@example.com"]);
  });

  it("no sender → typed UNAVAILABLE (honest failsafe)", async () => {
    await expect(new RecoveryEmailTool().execute(toolCtx(), emailParams(), {})).rejects.toBeInstanceOf(
      ToolUnavailableError,
    );
  });
});

describe("renderBrandedEmail", () => {
  it("escapes every dynamic string — model copy cannot inject markup", async () => {
    const params = emailTemplateParamsSchema.parse({
      template: "RECOVERY",
      recipients: [{ email: "x@example.com", firstName: "X" }],
      draft: {
        subject: "Wait <script>alert(1)</script>",
        body: "Evil <b>markup</b> attempt & entities\n\nsecond paragraph here with enough length",
        ctaLabel: "Click <img>",
      },
      ctaUrl: "https://checkout.example/recover",
    });
    const rendered = renderBrandedEmail(
      { storeName: "Demo <Store>", logoUrl: null, primaryColor: null, supportEmail: null },
      params,
      "X",
    );
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).not.toContain("<b>markup</b>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("Demo &lt;Store&gt;");
    expect(rendered.text).toContain("Evil <b>markup</b> attempt & entities"); // text stays literal
  });

  it("omits the discount block when no code is attached", () => {
    const rendered = renderBrandedEmail(
      { storeName: "Demo", logoUrl: null, primaryColor: null, supportEmail: null },
      emailParams({ discountCode: undefined, discountPercent: undefined }),
      "Mia",
    );
    expect(rendered.html).not.toContain("Use code");
  });
});
