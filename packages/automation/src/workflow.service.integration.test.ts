import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, workflowRuns, workflowRunSteps, workflows } from "@profit/db";
import type { createTestDatabase, TestDatabase } from "@profit/db/testing";
import { WorkflowNodeKind, WorkflowRunStatus, WorkflowStatus, WorkflowStepStatus, WorkflowTriggerKind } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootAutomationTestDb,
  seedAutomationStore,
  uniqueDomain,
} from "./test-support/integration";
import { WorkflowService, WorkflowStateError, WorkflowValidationError } from "./workflow.service";
import { evaluateCondition } from "./workflow.executor";
import { ConditionField, ConditionOperator } from "@profit/types";

/**
 * WorkflowService contract against REAL migrations 0000→0007 (RLS on): CRUD,
 * immutable versions, activation schedule math, scans, cancellation cascade.
 */

let testDb: TestDatabase;
let service: WorkflowService;
let storeId = "";

const MANUAL_DEF = {
  nodes: [
    { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: WorkflowTriggerKind.Manual } },
    { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "vip" } },
  ],
  edges: [{ from: "trigger", to: "tag" }],
};

const SCHEDULE_DEF = {
  nodes: [
    { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "SCHEDULE", cron: "0 9 * * 1" } },
    { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "weekly" } },
  ],
  edges: [{ from: "trigger", to: "tag" }],
};

const EVENT_DEF = {
  nodes: [
    { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "EVENT", topic: "orders/create" } },
    { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "buyer" } },
  ],
  edges: [{ from: "trigger", to: "tag" }],
};

beforeAll(async () => {
  testDb = await bootAutomationTestDb();
  service = new WorkflowService(testDb.db);
  storeId = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("wf-service") });
});

afterAll(async () => {
  await testDb.close();
});

describe("create + versions", () => {
  it("creates a draft with immutable version 1", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "Welcome flow",
      definition: MANUAL_DEF,
    });
    expect(workflow.status).toBe(WorkflowStatus.Draft);
    expect(version.version).toBe(1);
    const versions = await service.listVersions(storeId, workflow.id);
    expect(versions).toHaveLength(1);
  });

  it("rejects an invalid definition without persisting anything", async () => {
    const before = (await service.list(storeId)).length;
    await expect(
      service.create(storeId, { name: "broken", definition: { nodes: [], edges: [] } }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
    expect(await service.list(storeId)).toHaveLength(before);
  });

  it("edits by appending a new immutable version", async () => {
    const { workflow } = await service.create(storeId, { name: "v-flow", definition: MANUAL_DEF });
    const edited = await service.saveNewVersion(storeId, workflow.id, {
      name: "v-flow renamed",
      definition: EVENT_DEF,
    });
    expect(edited.version.version).toBe(2);
    expect(edited.workflow.name).toBe("v-flow renamed");
    expect((await service.listVersions(storeId, workflow.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it("scopes by store — another tenant sees nothing (RLS backstop)", async () => {
    const otherStore = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("wf-other") });
    expect(await service.list(otherStore)).toHaveLength(0);
  });
});

describe("activation", () => {
  it("computes nextFireAt for schedule triggers", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "weekly",
      definition: SCHEDULE_DEF,
    });
    const now = new Date("2026-08-06T10:30:00Z"); // Thursday
    const active = await service.activate(storeId, workflow.id, version.id, now);
    expect(active.status).toBe(WorkflowStatus.Active);
    expect(active.nextFireAt?.toISOString()).toBe("2026-08-10T09:00:00.000Z"); // next Monday
  });

  it("manual/event workflows carry no schedule", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "manual",
      definition: MANUAL_DEF,
    });
    const active = await service.activate(storeId, workflow.id, version.id);
    expect(active.nextFireAt).toBeNull();
  });

  it("pause disarms + clears the schedule; archive rejects later edits", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "pausable",
      definition: SCHEDULE_DEF,
    });
    await service.activate(storeId, workflow.id, version.id);
    const paused = await service.pause(storeId, workflow.id);
    expect(paused.status).toBe(WorkflowStatus.Paused);
    expect(paused.nextFireAt).toBeNull();

    const { workflow: archivedTarget, version: v2 } = await service.create(storeId, {
      name: "archivable",
      definition: MANUAL_DEF,
    });
    await service.activate(storeId, archivedTarget.id, v2.id);
    await service.archive(storeId, archivedTarget.id);
    await expect(
      service.saveNewVersion(storeId, archivedTarget.id, { definition: MANUAL_DEF }),
    ).rejects.toBeInstanceOf(WorkflowStateError);
  });

  it("rejects activating a version from another workflow", async () => {
    const a = await service.create(storeId, { name: "a", definition: MANUAL_DEF });
    const b = await service.create(storeId, { name: "b", definition: MANUAL_DEF });
    await expect(service.activate(storeId, a.workflow.id, b.version.id)).rejects.toBeInstanceOf(
      WorkflowStateError,
    );
  });
});

describe("scans (tick + webhook fan-out)", () => {
  it("finds schedule-due workflows only when ACTIVE and past-due", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "due-scan",
      definition: SCHEDULE_DEF,
    });
    await service.activate(storeId, workflow.id, version.id, new Date("2026-08-06T10:00:00Z"));
    const early = await service.findScheduleDue(new Date("2026-08-06T11:00:00Z"));
    expect(early.find((d) => d.workflowId === workflow.id)).toBeUndefined();
    const late = await service.findScheduleDue(new Date("2026-08-10T09:00:01Z"));
    const found = late.find((d) => d.workflowId === workflow.id);
    expect(found).toBeDefined();
    expect(found?.storeId).toBe(storeId);

    // TICK advance helper: strictly-after semantics on the pinned version's cron.
    const next = await service.nextFireAfter(storeId, workflow.id, new Date("2026-08-10T09:00:00Z"));
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(new Date("2026-08-10T09:00:00Z").getTime());
    // Unknown workflow → null (TICK skips honestly); manual trigger → null.
    expect(await service.nextFireAfter(storeId, crypto.randomUUID(), new Date())).toBeNull();
    const manual = await service.create(storeId, { name: "no-fire", definition: MANUAL_DEF });
    await service.activate(storeId, manual.workflow.id, manual.version.id);
    expect(await service.nextFireAfter(storeId, manual.workflow.id, new Date())).toBeNull();
  });

  it("finds event-triggered workflows by topic", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "on-order",
      definition: EVENT_DEF,
    });
    const hits = await service.findEventTriggered("orders/create");
    expect(hits.find((h) => h.workflowId === workflow.id)).toBeUndefined(); // not active yet
    await service.activate(storeId, workflow.id, version.id);
    const after = await service.findEventTriggered("orders/create");
    expect(after.find((h) => h.workflowId === workflow.id)).toBeDefined();
    expect(await service.findEventTriggered("products/create")).toHaveLength(0);
  });

  it("advanceSchedule CAS loses the race for a stale observer", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "cas",
      definition: SCHEDULE_DEF,
    });
    const observed = new Date("2026-08-10T09:00:00.000Z");
    await testDb.db
      .update(workflows)
      .set({ status: WorkflowStatus.Active, activeVersionId: version.id, nextFireAt: observed })
      .where(eq(workflows.id, workflow.id));
    expect(await service.advanceSchedule(storeId, workflow.id, observed, new Date("2026-08-17T09:00:00Z"))).toBe(true);
    // Second advance with the same observed instant must fail (someone else moved it).
    expect(await service.advanceSchedule(storeId, workflow.id, observed, new Date("2026-08-24T09:00:00Z"))).toBe(false);
  });

  it("finds resume-due waiting runs", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "resume-scan",
      definition: MANUAL_DEF,
    });
    await service.activate(storeId, workflow.id, version.id);
    const inserted = await testDb.db
      .insert(workflowRuns)
      .values({
        storeId,
        workflowId: workflow.id,
        versionId: version.id,
        status: WorkflowRunStatus.Waiting,
        triggerKind: WorkflowTriggerKind.Manual,
        triggerEventId: `manual:${Math.random()}`,
        resumeAt: new Date(Date.now() - 60_000),
        resumeFromNodeId: "wait",
      })
      .returning({ id: workflowRuns.id });
    const due = await service.findResumeDue(new Date());
    const dueRow = due.find((d) => d.runId === inserted[0]!.id);
    expect(dueRow).toBeDefined();
    // resumeAt rides along — the resume jobId needs it (multi-DELAY graphs).
    expect(dueRow?.resumeAt).toBeInstanceOf(Date);
    // A future-resume run is NOT due.
    const future = await testDb.db
      .insert(workflowRuns)
      .values({
        storeId,
        workflowId: workflow.id,
        versionId: version.id,
        status: WorkflowRunStatus.Waiting,
        triggerKind: WorkflowTriggerKind.Manual,
        triggerEventId: `manual:${Math.random()}`,
        resumeAt: new Date(Date.now() + 3_600_000),
        resumeFromNodeId: "wait",
      })
      .returning({ id: workflowRuns.id });
    const due2 = await service.findResumeDue(new Date());
    expect(due2.find((d) => d.runId === future[0]!.id)).toBeUndefined();
  });
});

describe("run history", () => {
  it("paginates newest-first with totals", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "history",
      definition: MANUAL_DEF,
    });
    await service.activate(storeId, workflow.id, version.id);
    for (let i = 0; i < 7; i += 1) {
      await testDb.db.insert(workflowRuns).values({
        storeId,
        workflowId: workflow.id,
        versionId: version.id,
        status: WorkflowRunStatus.Completed,
        triggerKind: WorkflowTriggerKind.Manual,
        triggerEventId: `manual:h-${i}`,
      });
    }
    const page1 = await service.listRuns(storeId, workflow.id, 1, 5);
    expect(page1.runs).toHaveLength(5);
    expect(page1.total).toBe(7);
    const page2 = await service.listRuns(storeId, workflow.id, 2, 5);
    expect(page2.runs).toHaveLength(2);
  });

  it("getRun + listRunSteps read the ledger; foreign runs stay invisible", async () => {
    const { workflow, version } = await service.create(storeId, {
      name: "ledger",
      definition: MANUAL_DEF,
    });
    await service.activate(storeId, workflow.id, version.id);
    const runRows = await testDb.db
      .insert(workflowRuns)
      .values({
        storeId,
        workflowId: workflow.id,
        versionId: version.id,
        status: WorkflowRunStatus.Completed,
        triggerKind: WorkflowTriggerKind.Manual,
        triggerEventId: `manual:${crypto.randomUUID()}`,
      })
      .returning({ id: workflowRuns.id });
    const runId = runRows[0]!.id;
    await testDb.db.insert(workflowRunSteps).values({
      storeId,
      runId,
      nodeId: "act",
      nodeKind: WorkflowNodeKind.SendEmail,
      status: WorkflowStepStatus.Completed,
    });

    const run = await service.getRun(storeId, workflow.id, runId);
    expect(run?.id).toBe(runId);
    const steps = await service.listRunSteps(storeId, workflow.id, runId);
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.nodeId).toBe("act");

    // Cross-workflow / unknown ids: null, never a lease of another tenant's data.
    expect(await service.getRun(storeId, crypto.randomUUID(), runId)).toBeNull();
    expect(await service.listRunSteps(storeId, crypto.randomUUID(), runId)).toBeNull();
    expect(await service.listRunSteps(storeId, workflow.id, crypto.randomUUID())).toBeNull();
  });
});

describe("evaluateCondition (pure)", () => {
  const subject = {
    customer: {
      ordersCount: 5,
      totalSpentCents: 123_456,
      acceptsMarketing: true,
      tags: ["vip", "repeat"],
    },
    event: { topic: "orders/create", totalCents: 9_999, currency: "USD" },
  };

  it("numeric operators on customer facts", () => {
    expect(
      evaluateCondition({ field: ConditionField.CustomerTotalSpentCents, operator: ConditionOperator.GreaterThan, value: 100_000 }, subject),
    ).toBe(true);
    expect(
      evaluateCondition({ field: ConditionField.CustomerOrdersCount, operator: ConditionOperator.LessThanOrEqual, value: 5 }, subject),
    ).toBe(true);
    expect(
      evaluateCondition({ field: ConditionField.CustomerOrdersCount, operator: ConditionOperator.Equals, value: 4 }, subject),
    ).toBe(false);
  });

  it("tag membership via CONTAINS; missing subject fails closed", () => {
    expect(evaluateCondition({ field: ConditionField.CustomerTag, operator: ConditionOperator.Contains, value: "vip" }, subject)).toBe(true);
    expect(evaluateCondition({ field: ConditionField.CustomerTag, operator: ConditionOperator.Contains, value: "wholesale" }, subject)).toBe(false);
    expect(evaluateCondition({ field: ConditionField.CustomerTag, operator: ConditionOperator.Contains, value: "vip" }, { customer: null, event: null })).toBe(false);
  });

  it("boolean + currency comparisons are case-insensitive", () => {
    expect(
      evaluateCondition({ field: ConditionField.CustomerAcceptsMarketing, operator: ConditionOperator.Equals, value: "true" }, subject),
    ).toBe(true);
    expect(
      evaluateCondition({ field: ConditionField.EventCurrency, operator: ConditionOperator.Equals, value: "usd" }, subject),
    ).toBe(true);
  });

  it("non-numeric operands on numeric operators fail closed", () => {
    expect(
      evaluateCondition({ field: ConditionField.EventTotalCents, operator: ConditionOperator.GreaterThan, value: "abc" }, subject),
    ).toBe(false);
    expect(
      evaluateCondition({ field: ConditionField.EventCurrency, operator: ConditionOperator.GreaterThan, value: "A" }, subject),
    ).toBe(false);
  });
});
