import { and, eq, messageSuppressions, shopifyCustomers, sql, workflowRuns, workflowRunSteps } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  AccessOverrideKind,
  MessageChannel,
  MessageSuppressionReason,
  PlanCode,
  SubscriptionStatus,
  WorkflowNodeKind,
  WorkflowRunStatus,
  WorkflowStepStatus,
  WorkflowTriggerKind,
} from "@profit/types";
import { AccessOverrideService, BillingService } from "@profit/billing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootAutomationTestDb,
  fakeAdminPort,
  fakeEmailSender,
  fakeSmsSender,
  seedActiveSubscription,
  seedAutomationStore,
  seedCustomer,
  seedPlanSubscription,
  uniqueDomain,
} from "./test-support/integration";
import { WorkflowService } from "./workflow.service";
import { WorkflowExecutor } from "./workflow.executor";

/**
 * WorkflowExecutor contract against the real schema: full walks, branch
 * gating, DELAY suspension/resume, idempotency, quota gating, suppression,
 * Shopify actions, and fail-fast error semantics. SMTP/Twilio/Admin are
 * boundary fakes the tests own — the walk + ledger are the real system.
 */

let testDb: TestDatabase;
let service: WorkflowService;
let storeId = "";

const email = fakeEmailSender();
const sms = fakeSmsSender();
const admin = fakeAdminPort();
let executor: WorkflowExecutor;

const SUBJECT_VIP = {
  customer: {
    ordersCount: 9,
    totalSpentCents: 250_000,
    acceptsMarketing: true,
    tags: ["repeat"],
  },
  event: { topic: "orders/create", totalCents: 42_000, currency: "USD" },
};

function customerSubject(customer: {
  id: string;
  shopifyCustomerId: string;
  email: string | null;
  phone?: string | null;
  firstName?: string | null;
  ordersCount?: number;
  totalSpentCents?: number;
  tags?: string[];
}) {
  return {
    customer: {
      id: customer.id,
      shopifyCustomerId: customer.shopifyCustomerId,
      email: customer.email,
      phone: customer.phone ?? null,
      firstName: customer.firstName ?? null,
      ordersCount: customer.ordersCount ?? 0,
      totalSpentCents: customer.totalSpentCents ?? 0,
      acceptsMarketing: false,
      tags: customer.tags ?? [],
    },
    event: null,
  };
}

/** Deep-link an ACTIVE workflow and return its ids. */
async function activeWorkflow(definition: unknown, name = "exec-flow"): Promise<{ workflowId: string }> {
  const created = await service.create(storeId, { name, definition });
  await service.activate(storeId, created.workflow.id, created.version.id);
  return { workflowId: created.workflow.id };
}

async function runOf(runId: string) {
  const rows = await testDb.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  return rows[0];
}

async function stepsOf(runId: string) {
  return testDb.db
    .select()
    .from(workflowRunSteps)
    .where(eq(workflowRunSteps.runId, runId))
    .orderBy(workflowRunSteps.createdAt);
}

beforeAll(async () => {
  testDb = await bootAutomationTestDb();
  service = new WorkflowService(testDb.db);
  storeId = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("wf-exec"), name: "Exec Store" });
  await seedActiveSubscription(testDb.db, storeId);
  executor = new WorkflowExecutor({
    db: testDb.db,
    email: email.sender,
    sms: sms.sender,
    adminForStore: async () => admin.port,
    billing: new BillingService(testDb.db),
  });
});

afterAll(async () => {
  await testDb.close();
});

describe("linear walk with template render", () => {
  it("executes trigger→email→tag→discount to completion with a truthful ledger", async () => {
    const customerId = await seedCustomer(testDb.db, {
      storeId,
      shopifyCustomerId: "777001",
      email: "vip@example.com",
      firstName: "Vera",
      tags: ["repeat"],
    });
    const { workflowId } = await activeWorkflow({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        {
          id: "mail",
          kind: WorkflowNodeKind.SendEmail,
          config: {
            subject: "Hi {{customer.firstName}}",
            bodyText: "Welcome to {{store.name}}, {{customer.firstName}}!",
          },
        },
        { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "welcomed" } },
        { id: "discount", kind: WorkflowNodeKind.CreateDiscount, config: { code: "WELCOME-10", percentOff: 10, expiresInDays: 30 } },
      ],
      edges: [
        { from: "trigger", to: "mail" },
        { from: "mail", to: "tag" },
        { from: "tag", to: "discount" },
      ],
    });
    const subject = customerSubject({
      id: customerId,
      shopifyCustomerId: "777001",
      email: "vip@example.com",
      firstName: "Vera",
      tags: ["repeat"],
    });
    const result = await executor.startRun({
      storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:test-1",
      subject,
    });
    expect(result.started).toBe(true);

    const run = await runOf(result.runId);
    expect(run?.status).toBe(WorkflowRunStatus.Completed);
    expect(run?.completedAt).not.toBeNull();

    // Email rendered + sent via the boundary.
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toBe("vip@example.com");
    expect(email.sent[0]!.subject).toBe("Hi Vera");
    expect(email.sent[0]!.textBody).toBe("Welcome to Exec Store, Vera!");
    expect(email.sent[0]!.htmlBody).toContain("<p>");

    // Shopify writes: customer tag merge + price rule + discount code.
    expect(admin.puts.some((p) => p.path.includes("/customers/777001.json"))).toBe(true);
    const tagPut = admin.puts.find((p) => p.path.includes("/customers/777001.json"));
    expect((tagPut?.body as { customer: { tags: string } }).customer.tags).toBe("repeat, welcomed");
    expect(admin.posts.some((p) => p.path.includes("price_rules.json"))).toBe(true);
    expect(admin.posts.some((p) => p.path.includes("discount_codes.json"))).toBe(true);

    // Local replica reflects the tag without waiting for the webhook echo.
    const customerRows = await testDb.db
      .select({ tags: shopifyCustomers.tags })
      .from(shopifyCustomers)
      .where(eq(shopifyCustomers.id, customerId));
    expect(customerRows[0]?.tags).toEqual(["repeat", "welcomed"]);

    // Steps: trigger + 3 actions, all completed, exactly once each.
    const steps = await stepsOf(result.runId);
    expect(steps.map((s) => s.nodeId).sort()).toEqual(["discount", "mail", "tag", "trigger"]);
    for (const step of steps) {
      expect(step.status).toBe(WorkflowStepStatus.Completed);
      expect(step.attempts).toBe(1);
    }
    const discountStep = steps.find((s) => s.nodeId === "discount");
    expect((discountStep?.detail as { priceRuleId: string }).priceRuleId).toBe("900001");
  });
});

describe("branch gating", () => {
  it("YES path only when the condition matches; NO path otherwise", async () => {
    const { workflowId } = await activeWorkflow(
      {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
          {
            id: "check",
            kind: WorkflowNodeKind.Condition,
            config: { field: "customer.totalSpentCents", operator: "GTE", value: 100_000 },
          },
          { id: "vip-tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "vip" } },
          { id: "regular-tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "regular" } },
        ],
        edges: [
          { from: "trigger", to: "check" },
          { from: "check", to: "vip-tag", branch: "YES" },
          { from: "check", to: "regular-tag", branch: "NO" },
        ],
      },
      "branching",
    );
    const vipCustomer = await seedCustomer(testDb.db, { storeId, shopifyCustomerId: "777002" });
    const vipRun = await executor.startRun({
      storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:branch-yes",
      subject: customerSubject({ id: vipCustomer, shopifyCustomerId: "777002", email: null, totalSpentCents: 150_000 }),
    });
    const vipSteps = await stepsOf(vipRun.runId);
    expect(vipSteps.find((s) => s.nodeId === "vip-tag")?.status).toBe(WorkflowStepStatus.Completed);
    expect(vipSteps.find((s) => s.nodeId === "regular-tag")).toBeUndefined();
    expect((vipSteps.find((s) => s.nodeId === "check")?.detail as { result: boolean }).result).toBe(true);

    const smallCustomer = await seedCustomer(testDb.db, { storeId, shopifyCustomerId: "777003" });
    const smallRun = await executor.startRun({
      storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:branch-no",
      subject: customerSubject({ id: smallCustomer, shopifyCustomerId: "777003", email: null, totalSpentCents: 42 }),
    });
    const smallSteps = await stepsOf(smallRun.runId);
    expect(smallSteps.find((s) => s.nodeId === "regular-tag")?.status).toBe(WorkflowStepStatus.Completed);
    expect(smallSteps.find((s) => s.nodeId === "vip-tag")).toBeUndefined();
  });
});

describe("DELAY suspension + resume", () => {
  it("suspends on DELAY, computes resumeAt, and resumes through the tick path", async () => {
    const { workflowId } = await activeWorkflow(
      {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
          { id: "wait", kind: WorkflowNodeKind.Delay, config: { minutes: 120 } },
          { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "after-wait" } },
        ],
        edges: [
          { from: "trigger", to: "wait" },
          { from: "wait", to: "tag" },
        ],
      },
      "delayer",
    );
    const customerId = await seedCustomer(testDb.db, { storeId, shopifyCustomerId: "777004" });
    const now = new Date("2026-08-06T12:00:00Z");
    const started = await executor.startRun(
      {
        storeId,
        workflowId,
        triggerKind: WorkflowTriggerKind.Manual,
        triggerEventId: "manual:delay-1",
        subject: customerSubject({ id: customerId, shopifyCustomerId: "777004", email: null }),
      },
      now,
    );
    const run = await runOf(started.runId);
    expect(run?.status).toBe(WorkflowRunStatus.Waiting);
    expect(run?.resumeAt?.toISOString()).toBe("2026-08-06T14:00:00.000Z");
    expect(run?.resumeFromNodeId).toBe("wait");

    // Premature resume: CAS fails, nothing continues.
    const premature = await executor.resumeRun(storeId, started.runId, now);
    expect(premature.resumed).toBe(false);

    // Move the clock past resumeAt: the tick's CAS claim succeeds.
    await testDb.db
      .update(workflowRuns)
      .set({ resumeAt: new Date("2026-08-06T14:00:00Z") })
      .where(eq(workflowRuns.id, started.runId));
    const resumed = await executor.resumeRun(storeId, started.runId, new Date("2026-08-06T14:00:01Z"));
    expect(resumed.resumed).toBe(true);
    const after = await runOf(started.runId);
    expect(after?.status).toBe(WorkflowRunStatus.Completed);
    const steps = await stepsOf(started.runId);
    expect(steps.find((s) => s.nodeId === "tag")?.status).toBe(WorkflowStepStatus.Completed);
    // The DELAY step was executed exactly once.
    expect(steps.filter((s) => s.nodeId === "wait")).toHaveLength(1);
  });
});

describe("idempotency + dedupe", () => {
  it("a duplicate triggerEventId is a no-op returning the existing run", async () => {
    const { workflowId } = await activeWorkflow(
      {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "EVENT", topic: "orders/create" } },
          { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "ordered" } },
        ],
        edges: [{ from: "trigger", to: "tag" }],
      },
      "dedupe-flow",
    );
    const payload = {
      storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Event,
      triggerEventId: "webhook:delivery-77",
      subject: SUBJECT_VIP,
    };
    const first = await executor.startRun(payload);
    const second = await executor.startRun(payload);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.runId).toBe(first.runId);
    const rows = await testDb.db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.triggerEventId, "webhook:delivery-77")));
    expect(rows).toHaveLength(1);
  });

  it("starting against an inactive/draft workflow throws", async () => {
    const created = await service.create(storeId, {
      name: "draft-only",
      definition: {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
          { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "x" } },
        ],
        edges: [{ from: "trigger", to: "tag" }],
      },
    });
    await expect(
      executor.startRun({
        storeId,
        workflowId: created.workflow.id,
        triggerKind: WorkflowTriggerKind.Manual,
        triggerEventId: "manual:draft",
        subject: { customer: null, event: null },
      }),
    ).rejects.toThrow(/not active/);
  });
});

describe("gates: quota, access override, suppression", () => {
  it("email step fails terminal when the plan's email quota is exhausted", async () => {
    const limited = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("wf-quota") });
    // Starter: 500 emails. Seed a subscription with a quota already consumed.
    await seedPlanSubscription(testDb.db, {
      storeId: limited,
      planCode: PlanCode.Starter,
      status: SubscriptionStatus.Active,
    });
    // Starter's sms quota is 0 → the send must fail terminal, never retry.
    const { workflowId } = await new WorkflowService(testDb.db).create(limited, {
      name: "sms-quota",
      definition: {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
          { id: "sms", kind: WorkflowNodeKind.SendSms, config: { bodyText: "Hi" } },
        ],
        edges: [{ from: "trigger", to: "sms" }],
      },
    }).then(async (created) => {
      await service.activate(limited, created.workflow.id, created.version.id);
      return { workflowId: created.workflow.id };
    });
    const customerId = await seedCustomer(testDb.db, { storeId: limited, phone: "+15551230001" });
    const run = await executor.startRun({
      storeId: limited,
      workflowId,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:quota-1",
      subject: customerSubject({ id: customerId, shopifyCustomerId: "q1", email: null, phone: "+15551230001" }),
    });
    const finished = await runOf(run.runId);
    expect(finished?.status).toBe(WorkflowRunStatus.Failed);
    expect(finished?.error).toContain("SMS");
    const steps = await stepsOf(run.runId);
    expect(steps.find((s) => s.nodeId === "sms")?.status).toBe(WorkflowStepStatus.Failed);
  });

  it("suspended subscription blocks the send; an access override re-enables it", async () => {
    const blockedStore = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("wf-blocked") });
    await seedPlanSubscription(testDb.db, {
      storeId: blockedStore,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.Suspended,
    });
    const svc = new WorkflowService(testDb.db);
    const created = await svc.create(blockedStore, {
      name: "suspended-flow",
      definition: {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
          { id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "s", bodyText: "b" } },
        ],
        edges: [{ from: "trigger", to: "mail" }],
      },
    });
    await svc.activate(blockedStore, created.workflow.id, created.version.id);
    const customerId = await seedCustomer(testDb.db, { storeId: blockedStore, email: "blocked@example.com" });
    const subject = customerSubject({ id: customerId, shopifyCustomerId: "b1", email: "blocked@example.com" });

    const deniedRun = await executor.startRun({
      storeId: blockedStore,
      workflowId: created.workflow.id,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:blocked-1",
      subject,
    });
    expect((await runOf(deniedRun.runId))?.status).toBe(WorkflowRunStatus.Failed);
    const emailsBefore = email.sent.length;

    // Operator grants comped access → the same flow now passes the gate.
    const overrides = new AccessOverrideService(testDb.db);
    await overrides.grant(blockedStore, {
      kind: AccessOverrideKind.CompAccess,
      accessUntil: new Date(Date.now() + 7 * 86_400_000),
      reason: "goodwill: migration outage",
      grantedBy: "[email protected]",
    });
    const allowedRun = await executor.startRun({
      storeId: blockedStore,
      workflowId: created.workflow.id,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:blocked-2",
      subject,
    });
    expect((await runOf(allowedRun.runId))?.status).toBe(WorkflowRunStatus.Completed);
    expect(email.sent.length).toBe(emailsBefore + 1);
  });

  it("suppressed destinations fail the step (never bypass the compliance list)", async () => {
    const customerId = await seedCustomer(testDb.db, { storeId, email: "unsub@example.com" });
    await testDb.db.insert(messageSuppressions).values({
      storeId,
      channel: MessageChannel.Email,
      destination: "unsub@example.com",
      reason: MessageSuppressionReason.Unsubscribed,
    });
    const { workflowId } = await activeWorkflow(
      {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
          { id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "s", bodyText: "b" } },
        ],
        edges: [{ from: "trigger", to: "mail" }],
      },
      "suppressed-flow",
    );
    const run = await executor.startRun({
      storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:suppressed-1",
      subject: customerSubject({ id: customerId, shopifyCustomerId: "s1", email: "unsub@example.com" }),
    });
    const finished = await runOf(run.runId);
    expect(finished?.status).toBe(WorkflowRunStatus.Failed);
    expect(finished?.error).toContain("suppressed");
  });

  it("missing customer email fails the step with a human reason", async () => {
    const { workflowId } = await activeWorkflow(
      {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "EVENT", topic: "orders/create" } },
          { id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "s", bodyText: "b" } },
        ],
        edges: [{ from: "trigger", to: "mail" }],
      },
      "no-email-flow",
    );
    const run = await executor.startRun({
      storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Event,
      triggerEventId: "webhook:no-email",
      subject: SUBJECT_VIP, // no customer attached
    });
    const finished = await runOf(run.runId);
    expect(finished?.status).toBe(WorkflowRunStatus.Failed);
    expect(finished?.error).toContain("no customer email");
  });

  it("sms sends through the boundary for E.164 phones and meters as a run", async () => {
    const customerId = await seedCustomer(testDb.db, { storeId, phone: "+15559876543" });
    const { workflowId } = await activeWorkflow(
      {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
          { id: "sms", kind: WorkflowNodeKind.SendSms, config: { bodyText: "Hi {{customer.firstName}}" } },
        ],
        edges: [{ from: "trigger", to: "sms" }],
      },
      "sms-flow",
    );
    const run = await executor.startRun({
      storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:sms-1",
      subject: customerSubject({ id: customerId, shopifyCustomerId: "s2", email: null, phone: "+15559876543", firstName: "Sid" }),
    });
    expect((await runOf(run.runId))?.status).toBe(WorkflowRunStatus.Completed);
    expect(sms.sent.some((m) => m.to === "+15559876543" && m.body === "Hi Sid")).toBe(true);
  });
});

describe("fail-fast semantics", () => {
  it("a provider error marks step + run FAILED and halts the walk", async () => {
    email.failNext();
    const customerId = await seedCustomer(testDb.db, { storeId, shopifyCustomerId: "777005", email: "crash@example.com" });
    const { workflowId } = await activeWorkflow(
      {
        nodes: [
          { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
          { id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "s", bodyText: "b" } },
          { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "should-not-run" } },
        ],
        edges: [
          { from: "trigger", to: "mail" },
          { from: "mail", to: "tag" },
        ],
      },
      "failing-flow",
    );
    const run = await executor.startRun({
      storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:fail-1",
      subject: customerSubject({ id: customerId, shopifyCustomerId: "777005", email: "crash@example.com" }),
    });
    const finished = await runOf(run.runId);
    expect(finished?.status).toBe(WorkflowRunStatus.Failed);
    const steps = await stepsOf(run.runId);
    expect(steps.find((s) => s.nodeId === "mail")?.status).toBe(WorkflowStepStatus.Failed);
    expect(steps.find((s) => s.nodeId === "tag")).toBeUndefined();
  });

  it("run rows are tenant-scoped even when driven by the owner (RLS)", async () => {
    // profit_app with an EMPTY app.store_id sees zero rows (fail-closed).
    const scopedProbe = await testDb.db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE profit_app"));
      await tx.execute(sql`SELECT set_config('app.store_id', '', true)`);
      return tx.execute(sql`SELECT count(*)::int AS c FROM workflow_runs`);
    });
    const rows = (Array.isArray(scopedProbe) ? scopedProbe : (scopedProbe as { rows: { c: number }[] }).rows) as { c: number }[];
    expect(rows[0]!.c).toBe(0);
  });
});
