import { describe, expect, it } from "vitest";
import { QK } from "./query-keys";

describe("QK registry", () => {
  it("uses realtime-invalidation-compatible prefixes", () => {
    // The realtime gateway invalidates ["sync"], ["analytics"], ["catalog"],
    // ["dashboard"], ["notifications"] — these keys must share those roots.
    expect(QK.syncStatus[0]).toBe("sync");
    expect(QK.syncHistory(2)[0]).toBe("sync");
    expect(QK.analyticsSummary(30)[0]).toBe("analytics");
    expect(QK.topProducts(7)[0]).toBe("analytics");
    expect(QK.topCustomers(90)[0]).toBe("analytics");
    expect(QK.products(1, "")[0]).toBe("catalog");
    expect(QK.product("x")[0]).toBe("catalog");
    expect(QK.productVariants("x")[0]).toBe("catalog");
    expect(QK.customers(1, "")[0]).toBe("catalog");
    expect(QK.customer("x")[0]).toBe("catalog");
    expect(QK.orders(1, "")[0]).toBe("catalog");
    expect(QK.order("x")[0]).toBe("catalog");
    expect(QK.inventory(1, false)[0]).toBe("catalog");
    expect(QK.dashboard(30)[0]).toBe("dashboard");
    expect(QK.notifications("all")[0]).toBe("notifications");
  });

  it("parameterizes keys so distinct filters never collide", () => {
    expect(QK.products(1, "a")).not.toEqual(QK.products(2, "a"));
    expect(QK.products(1, "a")).not.toEqual(QK.products(1, "b"));
    expect(QK.analyticsSummary(7)).not.toEqual(QK.analyticsSummary(30));
  });
});
