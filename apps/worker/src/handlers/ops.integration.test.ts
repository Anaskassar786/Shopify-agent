import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, mergeFeatureOverrides, storeSettings, workflowRuns, workflows } from "@profit/db";
import {
  AutomationTickJob,
  WorkflowRunStartJob,
  WorkflowService,
  type WorkflowDefinition,
} from "@profit/automation";
import {
  FeatureFlag,
  PlanCode,
  SubscriptionStatus,
  WorkflowNodeKind,
  WorkflowRunStatus,
  WorkflowTriggerKind,
} from "@profit/types";
import type { EmailSender } from "@profit/ai";
import {
  buildWorkerTestEnvironment,
  seedHarnessSubscription,
  type WorkerTestEnvironment,
} from "../test-support/harness";

/**
 * Launch readiness (ADR 37): the per-merchant `automationDisabled` flag is
 * enforced at the ONE place every trigger kind funnels through — the
 * run-start handler. A disabled store's run-start acks and skips loudly
 * (structured log, no retry storm, no run row); clearing the flag restores
 * execution on the next job. In-flight runs are deliberately untouched.
 */

let env: WorkerTestEnvironment;
const emailSent: Array<{ to: string; subject: string }> = [];
const emailSender: EmailSender = {
  send: async (input) => {
    emailSent.push(input);
    return { messageId: `msg-${String(emailSent.length)}` };
  },
};

const MANUAL_FLOW: WorkflowDefinition = {
  nodes: [
    { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: WorkflowTriggerKind.Manual } },
    {
      id: "note",
      kind: WorkflowNodeKind.SendEmail,
      config: { subject: "Hello {{customer.firstName}}", bodyText: "body" },
    },
  ],
  edges: [{ from: "trigger", to: "note" }],
};

const WEEKLY_FLOW: WorkflowDefinition = {
  nodes: [
    {
      id: "trigger",
      kind: WorkflowNodeKind.Trigger,
      config: { kind: WorkflowTriggerKind.Schedule, cron: "0 9 * * 1" },
    },
    {
      id: "note",
      kind: WorkflowNodeKind.SendEmail,
      config: { subject: "Weekly", bodyText: "Digest" },
    },
  ],
  edges: [{ from: "trigger", to: "note" }],
};

beforeEach(async () => {
  emailSent.length = 0;
  env = await buildWorkerTestEnvironment({ emailSender });
  await seedHarnessSubscription(env.db, env.storeId, {
    planCode: PlanCode.Professional,
    status: SubscriptionStatus.Active,
  });
  // Production parity: the OAuth install transaction ALWAYS creates the
  // settings row, so flag evaluation points can rely on it existing.
  await env.db.insert(storeSettings).values({ storeId: env.storeId }).onConflictDoNothing();
});

afterEach(async () => {
  await env.close();
});

async function activeWorkflow(definition: WorkflowDefinition): Promise<string> {
  const service = new WorkflowService(env.db);
  const { workflow, version } = await service.create(env.storeId, {
    name: `wf-ops-${crypto.randomUUID().slice(0, 8)}`,
    definition,
  });
  await service.activate(env.storeId, workflow.id, version.id);
  return workflow.id;
}

async function runsOf(workflowId: string) {
  return env.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
}

async function enqueueManualStart(workflowId: string): Promise<void> {
  await env.deps.persistence.enqueuePersistent(
    env.queue,
    WorkflowRunStartJob,
    {
      storeId: env.storeId,
      workflowId,
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: `manual:${crypto.randomUUID()}`,
      subject: { customer: { email: "ops@x.com", firstName: "Ops" }, event: null },
    },
    { jobId: `ops-start:${crypto.randomUUID()}` },
  );
  await env.settle();
}

describe("automationDisabled enforcement (worker run-start funnel)", () => {
  it("acks and skips manual run-starts for a disabled store — no run row, no side effects", async () => {
    const workflowId = await activeWorkflow(MANUAL_FLOW);
    await mergeFeatureOverrides(env.db, env.storeId, { [FeatureFlag.AutomationDisabled]: true });

    await enqueueManualStart(workflowId);

    expect(await runsOf(workflowId)).toHaveLength(0);
    expect(emailSent).toHaveLength(0);
  });

  it("skips schedule-fired run-starts too (the tick still CAS-advances the cursor honestly)", async () => {
    const workflowId = await activeWorkflow(WEEKLY_FLOW);
    const past = new Date(Date.now() - 60_000);
    await env.db.update(workflows).set({ nextFireAt: past }).where(eq(workflows.id, workflowId));
    await mergeFeatureOverrides(env.db, env.storeId, { [FeatureFlag.AutomationDisabled]: true });

    await env.deps.persistence.enqueuePersistent(env.queue, AutomationTickJob, {}, {
      jobId: `ops-tick:${String(Date.now())}:${crypto.randomUUID()}`,
    });
    await env.settle();

    // The instant fired — the run was skipped by policy (logged), never lost
    // silently: the cursor advanced past the fired instant so a re-enabled
    // store does not replay a backlog of stale instants.
    expect(await runsOf(workflowId)).toHaveLength(0);
    const after = await env.db.select().from(workflows).where(eq(workflows.id, workflowId));
    expect(after[0]!.nextFireAt).not.toBeNull();
    expect(after[0]!.nextFireAt!.getTime()).toBeGreaterThan(past.getTime());
  });

  it("clearing the flag restores execution on the next run-start", async () => {
    const workflowId = await activeWorkflow(MANUAL_FLOW);
    await mergeFeatureOverrides(env.db, env.storeId, { [FeatureFlag.AutomationDisabled]: true });
    await enqueueManualStart(workflowId);
    expect(await runsOf(workflowId)).toHaveLength(0);

    await mergeFeatureOverrides(env.db, env.storeId, { [FeatureFlag.AutomationDisabled]: false });
    await enqueueManualStart(workflowId);

    const runs = await runsOf(workflowId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe(WorkflowRunStatus.Completed);
    expect(emailSent).toHaveLength(1);
  });
});
